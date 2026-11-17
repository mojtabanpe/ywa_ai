/* Persian voice provider test: renders the same sample with every configured TTS provider so they can be ranked by ear.
 * Usage: pnpm voice:test ["custom Persian sentence"]
 * Output: output/voice-test/<provider>-<voice>.mp3 plus results.json. Providers without a key are skipped, not failed. */
import axios, { AxiosProxyConfig } from 'axios';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

const SAMPLE =
  process.argv.slice(2).find((arg) => arg !== '--') ||
  'اگه ایران قدرتمندترین نیروی هوایی دنیا بود، جنگ آسمون چه شکلی می‌شد؟ این یه داستان خیالیه، ولی بیاید با هم تصورش کنیم.';
const OUT = join('output', 'voice-test');
const env = (name: string) => {
  const value = process.env[name]?.trim();
  return value && !value.startsWith('replace-with') ? value : undefined;
};

function proxy(): AxiosProxyConfig | undefined {
  const raw = env('PIPELINE_PROXY_URL') || env('GEMINI_PROXY_URL') || env('HTTPS_PROXY');
  if (!raw) return undefined;
  const url = new URL(raw);
  return { protocol: url.protocol.replace(':', ''), host: url.hostname, port: Number(url.port) };
}

function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(-500)}`);
}

type Take = { provider: string; voice: string; file?: string; status: 'ok' | 'skipped' | 'failed'; detail?: string; ms?: number };
interface Provider {
  name: string;
  missing(): string | undefined;
  voices: string[];
  synthesize(text: string, voice: string, file: string): Promise<void>;
}

const http = { proxy: proxy(), timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity };

const gemini = (model: string): Provider => ({
  name: `gemini:${model}`,
  missing: () => (env('GEMINI_API_KEY') ? undefined : 'GEMINI_API_KEY'),
  voices: ['Charon', 'Kore', 'Orus'],
  async synthesize(text, voice, file) {
    const base = env('GEMINI_API_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta';
    const { data } = await axios.post(
      `${base}/models/${model}:generateContent`,
      {
        // Send the narration only: any style instruction in the prompt gets read aloud as part of the speech.
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      },
      { ...http, headers: { 'x-goog-api-key': env('GEMINI_API_KEY') } },
    );
    const part = data?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: { data: string } }) => p.inlineData);
    if (!part) throw new Error('no audio in response');
    const raw = `${file}.pcm`;
    await writeFile(raw, Buffer.from(part.inlineData.data, 'base64'));
    const rate = /rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? '24000';
    ffmpeg(['-f', 's16le', '-ar', rate, '-ac', '1', '-i', raw, '-b:a', '128k', file]);
    spawnSync('rm', [raw]);
  },
});

const elevenlabs: Provider = {
  name: 'elevenlabs:eleven_v3',
  missing: () => (env('ELEVENLABS_API_KEY') ? undefined : 'ELEVENLABS_API_KEY'),
  // George, Brian, Sarah: stock multilingual voices available on every account.
  voices: ['JBFqnCBsd6RMkjVDRZzb', 'nPczCjzI2devNBz1zQrb', 'EXAVITQu4vr4xnSDxMaL'],
  async synthesize(text, voice, file) {
    const { data } = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
      { text, model_id: 'eleven_v3', language_code: 'fa' },
      { ...http, responseType: 'arraybuffer', headers: { 'xi-api-key': env('ELEVENLABS_API_KEY') } },
    );
    await writeFile(file, Buffer.from(data));
  },
};

const deepgram: Provider = {
  name: 'deepgram:aura-2',
  missing: () => (env('DEEPGRAM_API_KEY') ? undefined : 'DEEPGRAM_API_KEY'),
  voices: ['aura-2-thalia-en', 'aura-2-orion-en'],
  async synthesize(text, voice, file) {
    const { data } = await axios.post(
      `https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`,
      { text },
      { ...http, responseType: 'arraybuffer', headers: { Authorization: `Token ${env('DEEPGRAM_API_KEY')}` } },
    );
    await writeFile(file, Buffer.from(data));
  },
};

const higgsfield: Provider = {
  name: 'higgsfield',
  missing: () => (env('HIGGSFIELD_API_KEY') ? undefined : 'HIGGSFIELD_API_KEY'),
  voices: ['default'],
  async synthesize() {
    // docs.higgsfield.ai (checked 2026-11-17) lists only image and video models; the API has no TTS endpoint.
    throw new Error('Higgsfield API has no text-to-speech endpoint (video/image only)');
  },
};

const piper: Provider = {
  name: 'piper:fa_IR-ganji_adabi',
  missing: () => (spawnSync('piper', ['--help']).status === 0 ? undefined : 'piper binary'),
  voices: ['medium'],
  async synthesize(text, _voice, file) {
    const wav = `${file}.wav`;
    const model = 'models/tts/piper-fa_IR-ganji_adabi-medium/model.onnx';
    const result = spawnSync('piper', ['-m', model, '-f', wav], { input: text, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr.slice(-400));
    ffmpeg(['-i', wav, '-b:a', '128k', file]);
    spawnSync('rm', [wav]);
  },
};

const PROVIDERS = [elevenlabs, gemini('gemini-3.8-flash-tts'), gemini('gemini-2.5-pro-preview-tts'), higgsfield, deepgram, piper];

function describe(error: unknown) {
  if (!axios.isAxiosError(error)) return (error as Error).message;
  const data = error.response?.data;
  const body =
    data instanceof ArrayBuffer || Buffer.isBuffer(data)
      ? Buffer.from(data as ArrayBuffer).toString()
      : typeof data === 'string'
        ? data
        : JSON.stringify(data ?? '');
  return `HTTP ${error.response?.status ?? '-'} ${body.slice(0, 300) || error.message}`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const only = process.env.VOICE_PROVIDERS?.split(',').map((name) => name.trim());
  const takes: Take[] = [];
  for (const provider of PROVIDERS) {
    if (only && !only.some((name) => provider.name.startsWith(name))) continue;
    const missing = provider.missing();
    if (missing) {
      takes.push({ provider: provider.name, voice: '-', status: 'skipped', detail: `${missing} not set` });
      continue;
    }
    for (const voice of provider.voices) {
      const file = join(OUT, `${provider.name.replace(/[^a-z0-9.-]+/gi, '_')}-${voice}.mp3`);
      const started = Date.now();
      try {
        await provider.synthesize(SAMPLE, voice, file);
        takes.push({ provider: provider.name, voice, file, status: 'ok', ms: Date.now() - started });
      } catch (error) {
        takes.push({ provider: provider.name, voice, status: 'failed', detail: describe(error), ms: Date.now() - started });
      }
      console.log(takes.at(-1));
    }
  }
  await writeFile(join(OUT, 'results.json'), JSON.stringify({ sample: SAMPLE, takes }, null, 2));
  console.table(takes.map(({ provider, voice, status, detail, ms }) => ({ provider, voice, status, ms, detail: detail?.slice(0, 80) })));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
