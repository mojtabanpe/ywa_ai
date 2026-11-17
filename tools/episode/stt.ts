/* Persian speech-to-text (ElevenLabs Scribe) with word timings, and the character error rate used as the accuracy check. */
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { http, requireEnv } from './lib';

export interface Word {
  text: string;
  start: number;
  end: number;
}

export async function transcribe(file: string): Promise<{ text: string; words: Word[] }> {
  const form = new FormData();
  form.append('file', new Blob([await readFile(file)]), basename(file));
  form.append('model_id', 'scribe_v1');
  form.append('language_code', 'fas');
  form.append('timestamps_granularity', 'word');
  // Sound-event labels like "[صدای انفجار]" are not speech and would count as misread words.
  form.append('tag_audio_events', 'false');
  const { data } = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', form, {
    ...http(),
    headers: { 'xi-api-key': requireEnv('ELEVENLABS_API_KEY') },
  });
  const isEvent = (text: string) => /^[[(].*[\])]$/.test(text.trim());
  const words = ((data.words ?? []) as Array<{ text: string; start: number; end: number; type: string }>)
    .filter((word) => word.type === 'word' && !isEvent(word.text))
    .map(({ text, start, end }) => ({ text, start, end }));
  return { text: String(data.text ?? '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(), words };
}

/** Normalizes Persian so the comparison is about sounds, not spelling variants, diacritics or punctuation. */
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
