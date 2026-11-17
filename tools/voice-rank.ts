/* Ranks the samples from voice-test without a human listener.
 * 1) Accuracy: transcribe each sample with ElevenLabs Scribe and measure the character error rate (CER) against the script.
 * 2) Quality: a Gemini model that accepts audio scores Persian pronunciation, naturalness and fit for a short narrated Reel (1-10).
 * Usage: pnpm voice:rank   →  output/voice-test/ranking.json */
import axios, { AxiosProxyConfig } from 'axios';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

const DIR = join('output', 'voice-test');
const env = (name: string) => {
  const value = process.env[name]?.trim();
  return value && !value.startsWith('replace-with') ? value : undefined;
};
const proxyUrl = env('PIPELINE_PROXY_URL') || env('GEMINI_PROXY_URL');
const proxy: AxiosProxyConfig | undefined = proxyUrl
  ? { protocol: new URL(proxyUrl).protocol.replace(':', ''), host: new URL(proxyUrl).hostname, port: Number(new URL(proxyUrl).port) }
  : undefined;
const http = { proxy, timeout: 180_000, maxBodyLength: Infinity, maxContentLength: Infinity };
// Tried in order; any failure (overloaded, rate-limited, retired) moves on to the next model.
const JUDGE_MODELS = (process.env.VOICE_JUDGE_MODELS || 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-pro-preview,gemini-3-flash-preview').split(',');
let JUDGE_MODEL = JUDGE_MODELS[0];

/** Normalizes Persian text so CER compares sounds, not spelling variants or punctuation. */
export function normalizePersian(text: string) {
  return text
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[‌‍]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

export function characterErrorRate(reference: string, hypothesis: string) {
  const a = [...normalizePersian(reference)];
  const b = [...normalizePersian(hypothesis)];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return a.length ? previous[b.length] / a.length : 0;
}

async function transcribe(file: string) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)], { type: 'audio/mpeg' }), basename(file));
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'fas');
  const { data } = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', form, {
    ...http,
    headers: { 'xi-api-key': env('ELEVENLABS_API_KEY') },
  });
  return String(data.text ?? '');
}

type Judgement = { id: string; pronunciation: number; naturalness: number; reelFit: number; notes: string };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Judges every sample in one request so the model compares them side by side (far more consistent than one call per file). */
async function judgeAll(files: string[], script: string): Promise<Judgement[]> {
  const base = env('GEMINI_API_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta';
  const parts: Array<Record<string, unknown>> = [
    {
      text: [
        'You are a strict Persian (Farsi) voice-over director for Instagram Reels.',
        `Each clip below was asked to read exactly this Persian script:\n${script}`,
        'Compare the clips against each other and score each 1-10 (10 = indistinguishable from a skilled native Tehrani narrator):',
        '- pronunciation: correct Persian sounds, no foreign/Arabic/English accent, no skipped or wrong words',
        '- naturalness: human-like rhythm, intonation and emotion; not robotic',
        '- reelFit: engaging and energetic enough to hold attention in a 40-second Reel',
        'Use the full range so differences show; a clip that does not speak Persian scores 1.',
        'Reply with a JSON array only: [{"id":"A","pronunciation":n,"naturalness":n,"reelFit":n,"notes":"one short English sentence"}, ...]',
      ].join('\n'),
    },
  ];
  for (const [index, file] of files.entries()) {
    parts.push({ text: `Clip ${String.fromCharCode(65 + index)}:` });
    parts.push({ inlineData: { mimeType: 'audio/mpeg', data: (await readFile(file)).toString('base64') } });
  }
  const body = { contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } };
  let lastError: unknown;
  for (const model of JUDGE_MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data } = await axios.post(`${base}/models/${model}:generateContent`, body, { ...http, headers: { 'x-goog-api-key': env('GEMINI_API_KEY') } });
        JUDGE_MODEL = model;
        const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
        return JSON.parse(text) as Judgement[];
      } catch (error) {
        lastError = error;
        console.log(`judge ${model} attempt ${attempt}: ${describe(error)}`);
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status !== 429 && status !== 503 && status !== 500) break; // not transient: try the next model
        await sleep(5_000 * attempt);
      }
    }
  }
  throw lastError;
}

function describe(error: unknown) {
  if (!axios.isAxiosError(error)) return String(error);
  return `HTTP ${error.response?.status ?? error.code ?? '-'} ${JSON.stringify(error.response?.data ?? error.message).slice(0, 160)}`;
}

async function main() {
  const { sample } = JSON.parse(await readFile(join(DIR, 'results.json'), 'utf8')) as { sample: string };
  // results.json only holds the latest run; rank every sample file on disk instead.
  const files = readdirSync(DIR).filter((name) => name.endsWith('.mp3')).sort().map((name) => join(DIR, name));
  const rows: Array<Record<string, unknown>> = files.map((file) => ({ file: basename(file) }));
  for (const [index, file] of files.entries()) {
    try {
      const transcript = await transcribe(file);
      rows[index].transcript = transcript;
      rows[index].cer = Number(characterErrorRate(sample, transcript).toFixed(3));
    } catch (error) {
      rows[index].transcriptError = describe(error);
    }
  }
  const judgements = await judgeAll(files, sample);
  for (const judgement of judgements) {
    const row = rows[judgement.id.trim().toUpperCase().charCodeAt(0) - 65];
    if (row) Object.assign(row, { pronunciation: judgement.pronunciation, naturalness: judgement.naturalness, reelFit: judgement.reelFit, notes: judgement.notes });
  }
  for (const row of rows) {
    const quality = ['pronunciation', 'naturalness', 'reelFit'].map((key) => Number(row[key] ?? 0));
    const accuracy = typeof row.cer === 'number' ? Math.max(0, 1 - (row.cer as number)) * 10 : 0;
    // Accuracy gates everything (a voice that misreads words is unusable); then naturalness and pronunciation matter most.
    row.score = Number((accuracy * 0.35 + quality[0] * 0.25 + quality[1] * 0.3 + quality[2] * 0.1).toFixed(2));
  }
  rows.sort((a, b) => Number(b.score) - Number(a.score));
  await writeFile(join(DIR, 'ranking.json'), JSON.stringify({ sample, judgeModel: JUDGE_MODEL, transcriber: 'elevenlabs scribe_v1', rows }, null, 2));
  console.log('judge model:', JUDGE_MODEL);
  console.table(rows.map((row) => ({ file: row.file, score: row.score, cer: row.cer, pron: row.pronunciation, nat: row.naturalness, fit: row.reelFit, notes: String(row.notes ?? '').slice(0, 60) })));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
