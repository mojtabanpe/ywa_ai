/* Timed Persian captions: the script's own words, timed from the narration transcript. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderCaption } from './graphics';
import { normalizePersian, Word } from './stt';

export interface Caption {
  text: string;
  start: number;
  end: number;
  file: string;
}

const MAX_WORDS = 5;
const MAX_CHARS = 28;

/** Splits the script into short caption lines, breaking after punctuation or when a line gets too long. */
export function chunkScript(script: string) {
  const words = script.replace(/\s+/g, ' ').trim().split(' ');
  const chunks: string[][] = [[]];
  for (const word of words) {
    const current = chunks[chunks.length - 1];
    const length = [...current, word].join(' ').length;
    if (current.length && (current.length >= MAX_WORDS || length > MAX_CHARS)) chunks.push([word]);
    else current.push(word);
    if (/[.،؛؟!?:]$/.test(word)) chunks.push([]);
  }
  return chunks.filter((chunk) => chunk.length).map((chunk) => chunk.join(' ').replace(/[.،؛]$/, ''));
}

/**
 * Times each chunk by its position in the script: a chunk that starts at 40 % of the script's characters starts when the
 * transcript reaches 40 % of its characters. Robust to the transcript spelling words differently or merging/splitting them.
 */
export function timeChunks(chunks: string[], words: Word[]) {
  const transcriptLengths = words.map((word) => Math.max(1, normalizePersian(word.text).length));
  const transcriptTotal = transcriptLengths.reduce((a, b) => a + b, 0);
  const timeAt = (fraction: number) => {
    let reached = 0;
    for (const [index, word] of words.entries()) {
      const share = transcriptLengths[index] / transcriptTotal;
      if (reached + share >= fraction) return word.start + (word.end - word.start) * ((fraction - reached) / share);
      reached += share;
    }
    return words[words.length - 1].end;
  };
  const chunkLengths = chunks.map((chunk) => Math.max(1, normalizePersian(chunk).length));
  const scriptTotal = chunkLengths.reduce((a, b) => a + b, 0);
  let position = 0;
  return chunks.map((text, index) => {
    const start = timeAt(position / scriptTotal);
    position += chunkLengths[index];
    const end = timeAt(position / scriptTotal);
    return { text, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)) };
  });
}

export async function makeCaptions(script: string, words: Word[], dir: string): Promise<Caption[]> {
  const captionDir = join(dir, 'captions');
  await mkdir(captionDir, { recursive: true });
  const timed = timeChunks(chunkScript(script), words);
  const captions: Caption[] = [];
  for (const [index, caption] of timed.entries()) {
    const file = join(captionDir, `${String(index).padStart(2, '0')}.png`);
    await renderCaption(caption.text, file);
    // Each line runs exactly until the next one starts: no gap (no flicker) and no overlap (two lines on screen at once).
    const end = index + 1 < timed.length ? timed[index + 1].start - 0.01 : caption.end + 0.4;
    captions.push({ ...caption, end: Number(end.toFixed(2)), file });
  }
  await writeFile(join(dir, 'captions.json'), JSON.stringify(captions, null, 2));
  return captions;
}
