/* Character reference images: one fixed portrait per recurring character, passed to Flow as an "ingredient"
 * so the face stays the same in every shot. Made once (free in Flow with Nano Banana) and kept on disk;
 * the owner approves it before any paid shot uses it. */
import axios from 'axios';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Brief, Character, outputDir } from './brief';
import { env, ffmpeg, firstSuccess, http, log, requireEnv } from './lib';

export const characterFile = (slug: string, id: string) => join(outputDir(slug), 'characters', `${id}.png`);

const portraitPrompt = (character: Character) =>
  `${character.prompt}. Character reference portrait: one person only, front-facing head and shoulders, ` +
  'neutral soft studio light, plain dark background, sharp facial detail, photorealistic, no text, no logos.';

async function geminiImage(prompt: string, file: string) {
  const base = env('GEMINI_API_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta';
  const model = env('GEMINI_IMAGE_MODEL') || 'gemini-3.1-flash-image';
  const { data } = await axios.post(
    `${base}/models/${model}:generateContent`,
    { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
    { ...http(), headers: { 'x-goog-api-key': requireEnv('GEMINI_API_KEY') } },
  );
  const part = data?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData);
  if (!part) throw new Error('the image model returned no image');
  await writeFile(file, Buffer.from(part.inlineData.data, 'base64'));
}

/** Flow downloads images as JPEG; convert so the .png reference really is a PNG when uploaded as an ingredient. */
async function flowPortrait(
  flowImage: (brief: Brief, prompt: string, file: string, account: number) => Promise<void>,
  brief: Brief,
  prompt: string,
  file: string,
  account: number,
) {
  const download = `${file}.download`;
  await flowImage(brief, prompt, download, account);
  ffmpeg(['-i', download, '-f', 'image2', '-c:v', 'png', file]);
  await rm(download, { force: true });
}

export async function makeCharacters(brief: Brief) {
  // Imported here to avoid a cycle: flow.ts needs characterFile from this module.
  const { flowImage, closeFlow } = await import('./flow');
  try {
    for (const character of brief.characters ?? []) {
      const file = characterFile(brief.slug, character.id);
      if (existsSync(file)) {
        await log(`character ${character.id}: already on disk, kept`);
        continue;
      }
      await mkdir(join(outputDir(brief.slug), 'characters'), { recursive: true });
      const prompt = portraitPrompt(character);
      const { name } = await firstSuccess(`character ${character.id}`, [
        { name: 'flow-u1', attempt: () => flowPortrait(flowImage, brief, prompt, file, 1) },
        { name: 'flow-u0', attempt: () => flowPortrait(flowImage, brief, prompt, file, 0) },
        { name: 'gemini-image', attempt: () => geminiImage(prompt, file) },
      ]);
      await log(`character ${character.id}: reference image made with ${name}; show it to the owner before making shots`);
    }
  } finally {
    await closeFlow();
  }
}
