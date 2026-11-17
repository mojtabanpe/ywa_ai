/* Episode pipeline entry point.
 * Usage: pnpm episode <slug> [--from shots|voice|edit|cover|qa|upload] [--until <step>]
 * Reads episodes/<slug>/brief.json; writes everything to output/episodes/<slug>/. Publishing is not a step:
 * post.json is shown to the owner, and Claude publishes only after the owner's yes. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleClean, assembleFinal } from './assemble';
import { loadBrief, outputDir } from './brief';
import { Caption, makeCaptions } from './captions';
import { closeFlow } from './flow';
import { makeCover, qa, upload } from './finish';
import { closeGraphics, renderFictionLabel } from './graphics';
import { log, setLogFile } from './lib';
import { makeShots } from './shots';
import { makeVoice, VoiceResult } from './voice';

const STEPS = ['shots', 'voice', 'edit', 'cover', 'qa', 'upload'] as const;
type Step = (typeof STEPS)[number];

function parseArgs() {
  // A stray "--" (npm-style argument separator) is ignored so both `pnpm episode x` and `pnpm episode -- x` work.
  const [slug, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
  if (!slug) throw new Error('usage: pnpm episode <slug> [--from <step>] [--until <step>]');
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    const value = i >= 0 ? rest[i + 1] : undefined;
    if (value && !STEPS.includes(value as Step)) throw new Error(`--${name} must be one of ${STEPS.join(', ')}`);
    return value as Step | undefined;
  };
  return { slug, from: flag('from') ?? 'shots', until: flag('until') ?? 'upload' };
}

async function main() {
  const { slug, from, until } = parseArgs();
  const brief = await loadBrief(slug);
  const dir = outputDir(slug);
  await mkdir(dir, { recursive: true });
  setLogFile(join(dir, 'run.log'));
  const active = (step: Step) => STEPS.indexOf(step) >= STEPS.indexOf(from) && STEPS.indexOf(step) <= STEPS.indexOf(until);
  const readJson = async <T>(name: string) => JSON.parse(await readFile(join(dir, name), 'utf8')) as T;
  await log(`episode ${brief.episode} "${brief.title}" (${slug}): ${from} → ${until}`);

  if (active('shots')) {
    try {
      await writeFile(join(dir, 'shots.json'), JSON.stringify(await makeShots(brief), null, 2));
    } finally {
      await closeFlow();
    }
  }
  // Later steps need the voice; skip reading it when the run stops before the edit.
  const voice = active('voice') ? await makeVoice(brief) : active('edit') ? await readJson<VoiceResult>('voice.json') : undefined;
  const clean = join(dir, 'clean.mp4');
  const final = join(dir, 'final.mp4');
  let captions: Caption[] = existsSync(join(dir, 'captions.json')) ? await readJson<Caption[]>('captions.json') : [];
  if (active('edit') && voice) {
    assembleClean(brief);
    captions = await makeCaptions(brief.narration, voice.words, dir);
    const label = brief.fictional ? join(dir, 'fiction-label.png') : undefined;
    if (label) await renderFictionLabel(label);
    assembleFinal(brief, clean, voice.file, captions, label);
    await log(`edit: ${final}`);
  }
  const cover = join(dir, 'cover.jpg');
  if (active('cover')) await makeCover(brief, clean);
  await closeGraphics();
  if (active('qa')) await qa(brief, final, cover, captions);
  if (active('upload')) {
    const post = await upload(brief, final, cover);
    await log(`ready for approval: ${post.driveName}`);
  }
  await log('done');
}

main().catch(async (error) => {
  await closeGraphics();
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
