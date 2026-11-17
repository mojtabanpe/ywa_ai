/* Edit: shots → clean 1080×1920 edit (also the cover source) → final with narration, captions and the fiction label. */
import { join } from 'node:path';
import { Brief, outputDir, totalSeconds } from './brief';
import { Caption } from './captions';
import { ffmpeg, probe } from './lib';

/** Narration starts a moment after the first frame so the opening image lands first. */
export const NARRATION_OFFSET = 0.3;
const CAPTION_Y = 1380; // lower third, above Instagram's caption/UI band
const LABEL_Y = 150;
const LABEL_SECONDS = 4;

export const shotFile = (slug: string, index: number) => join(outputDir(slug), 'shots', `shot_${String(index + 1).padStart(2, '0')}.mp4`);

export function assembleClean(brief: Brief) {
  const dir = outputDir(brief.slug);
  const inputs: string[] = [];
  const filters: string[] = [];
  brief.shots.forEach((shot, index) => {
    const file = shotFile(brief.slug, index);
    inputs.push('-i', file);
    const s = shot.seconds;
    filters.push(
      `[${index}:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,` +
        `tpad=stop_mode=clone:stop_duration=1,trim=duration=${s},setpts=PTS-STARTPTS[v${index}]`,
    );
    filters.push(
      probe(file).hasAudio
        ? `[${index}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${s},asetpts=PTS-STARTPTS[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${s}[a${index}]`,
    );
  });
  const n = brief.shots.length;
  filters.push(`${brief.shots.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[v][a]`);
  const file = join(dir, 'clean.mp4');
  ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', file]);
  return file;
}

export function assembleFinal(brief: Brief, clean: string, narration: string, captions: Caption[], label?: string) {
  const dir = outputDir(brief.slug);
  const total = totalSeconds(brief);
  const level = brief.shotAudioLevel ?? 0.18;
  const inputs = ['-i', clean, '-i', narration];
  const filters: string[] = [];
  let video = '[0:v]';
  let next = 2;
  if (label) {
    inputs.push('-i', label);
    filters.push(`${video}[${next}:v]overlay=0:${LABEL_Y}:enable='between(t,0,${LABEL_SECONDS})'[vl]`);
    video = '[vl]';
    next++;
  }
  captions.forEach((caption, index) => {
    inputs.push('-i', caption.file);
    const start = (caption.start + NARRATION_OFFSET).toFixed(2);
    const end = Math.min(total, caption.end + NARRATION_OFFSET).toFixed(2);
    filters.push(`${video}[${next}:v]overlay=0:${CAPTION_Y}:enable='between(t,${start},${end})'[vc${index}]`);
    video = `[vc${index}]`;
    next++;
  });
  const delay = Math.round(NARRATION_OFFSET * 1000);
  filters.push(
    `[0:a]volume=${level}[bed]`,
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[voice]`,
    `[bed][voice]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5[mix]`,
  );
  const file = join(dir, 'final.mp4');
  ffmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', video, '-map', '[mix]',
    '-t', String(total),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    file,
  ]);
  return file;
}
