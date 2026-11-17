/* Narration: synthesize with the ranked providers, reject any take that misreads the script, fit it to the edit length. */
import axios from 'axios';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Brief, outputDir, totalSeconds } from './brief';
import { env, ffmpeg, firstSuccess, http, log, probe, requireEnv } from './lib';
import { characterErrorRate, transcribe, Word } from './stt';

/** Takes that misread more than this share of characters are rejected (the ranked voices scored 1-2 %). */
const MAX_CER = 0.08;
/** Speeding narration beyond this sounds rushed; earlier episodes used 1.27×. */
const MAX_TEMPO = 1.35;

async function gemini(text: string, voice: string, raw: string) {
  const base = env('GEMINI_API_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta';
  // Narration text only: any style instruction in the prompt is read aloud as part of the speech.
  const { data } = await axios.post(
    `${base}/models/gemini-3.8-flash-tts:generateContent`,
    { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } },
    { ...http(), headers: { 'x-goog-api-key': requireEnv('GEMINI_API_KEY') } },
  );
  const part = data?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData);
  if (!part) throw new Error('Gemini returned no audio');
  const pcm = `${raw}.pcm`;
  await writeFile(pcm, Buffer.from(part.inlineData.data, 'base64'));
  const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? '24000';
  ffmpeg(['-f', 's16le', '-ar', rate, '-ac', '1', '-i', pcm, raw]);
}

async function elevenlabs(text: string, voiceId: string, raw: string) {
  const { data } = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    { text, model_id: 'eleven_v3', language_code: 'fa' },
    { ...http(), responseType: 'arraybuffer', headers: { 'xi-api-key': requireEnv('ELEVENLABS_API_KEY') } },
  );
  const mp3 = `${raw}.mp3`;
  await writeFile(mp3, Buffer.from(data));
  ffmpeg(['-i', mp3, raw]);
}

async function piper(text: string, raw: string) {
  const result = spawnSync('piper', ['-m', 'models/tts/piper-fa_IR-ganji_adabi-medium/model.onnx', '-f', raw], { input: text, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`piper failed: ${result.stderr.slice(-300)}`);
}

/** Order decided from the 2026-11-17 voice ranking (tools/voice-rank.ts). */
const PROVIDERS: Array<{ name: string; make: (text: string, raw: string) => Promise<void> }> = [
  { name: 'gemini-kore', make: (text, raw) => gemini(text, 'Kore', raw) },
  { name: 'gemini-charon', make: (text, raw) => gemini(text, 'Charon', raw) },
  { name: 'elevenlabs-sarah', make: (text, raw) => elevenlabs(text, 'EXAVITQu4vr4xnSDxMaL', raw) },
  { name: 'elevenlabs-brian', make: (text, raw) => elevenlabs(text, 'nPczCjzI2devNBz1zQrb', raw) },
  { name: 'piper-local', make: piper },
];

export interface VoiceResult {
  provider: string;
  file: string;
  duration: number;
  tempo: number;
  cer: number;
  words: Word[];
}

export async function makeVoice(brief: Brief): Promise<VoiceResult> {
  const dir = outputDir(brief.slug);
  const target = totalSeconds(brief) - 0.8; // leave a beat of picture after the last word
  const only = env('VOICE_PROVIDER');
  const providers = only ? PROVIDERS.filter((provider) => provider.name === only) : PROVIDERS;
  const { name, result } = await firstSuccess(
    'voice',
    providers.map((provider) => ({
      name: provider.name,
      attempt: async () => {
        const raw = join(dir, `narration-${provider.name}.wav`);
        await provider.make(brief.narration, raw);
        // Trim leading/trailing silence so timing and tempo are measured on speech only.
        const trimmed = join(dir, `narration-${provider.name}-trim.wav`);
        ffmpeg(['-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', '-ar', '48000', '-ac', '1', trimmed]);
        const spoken = probe(trimmed).duration;
        const tempo = spoken > target ? spoken / target : 1;
        if (tempo > MAX_TEMPO) throw new Error(`narration is ${spoken.toFixed(1)} s for a ${target.toFixed(1)} s edit; needs ${tempo.toFixed(2)}× (max ${MAX_TEMPO}×). Shorten the narration or add a shot.`);
        const file = join(dir, 'narration.wav');
        ffmpeg(['-i', trimmed, '-af', `atempo=${tempo.toFixed(4)}`, '-ar', '48000', '-ac', '1', file]);
        // Accuracy gate on the final (tempo-adjusted) take; the same transcript times the captions.
        const { text, words } = await transcribe(file);
        const cer = characterErrorRate(brief.narration, text);
        await log(`voice: ${provider.name} ${spoken.toFixed(1)} s spoken, tempo ${tempo.toFixed(2)}×, read error ${(cer * 100).toFixed(1)} %`);
        if (cer > MAX_CER) throw new Error(`read error ${(cer * 100).toFixed(1)} % is above ${MAX_CER * 100} %; heard: ${text.slice(0, 160)}`);
        if (!words.length) throw new Error('transcription returned no word timings');
        return { file, duration: probe(file).duration, tempo, cer, words };
      },
    })),
  );
  const voice = { provider: name, ...result };
  await writeFile(join(dir, 'voice.json'), JSON.stringify(voice, null, 2));
  return voice;
}
