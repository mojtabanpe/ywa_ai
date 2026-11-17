/* Cover, automatic QA, the Instagram package, and the Drive upload with public direct links. */
import axios from 'axios';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Brief, outputDir, totalSeconds } from './brief';
import { Caption } from './captions';
import { renderCover } from './graphics';
import { ffmpeg, http, log, probe, proxyUrl, run } from './lib';
import { characterErrorRate, transcribe } from './stt';

export async function makeCover(brief: Brief, clean: string) {
  const dir = outputDir(brief.slug);
  const frame = join(dir, 'cover-frame.jpg');
  ffmpeg(['-ss', String(brief.coverAt), '-i', clean, '-frames:v', '1', '-q:v', '2', frame]);
  const file = join(dir, 'cover.jpg');
  await renderCover(frame, brief.title, brief.subtitle, brief.episode, file);
  return file;
}

function averageBrightness(image: string, filter: string) {
  const out = run('ffmpeg', ['-hide_banner', '-i', image, '-vf', `${filter},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-']);
  return Number(/YAVG=([\d.]+)/.exec(out)?.[1] ?? 0);
}

export const captionText =(brief: Brief) => `${brief.caption.trim()}\n\n${brief.hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' ')}`;

export async function qa(brief: Brief, final: string, cover: string, captions: Caption[]) {
  const dir = outputDir(brief.slug);
  const total = totalSeconds(brief);
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  const video = probe(final);
  add('video size 1080×1920', video.width === 1080 && video.height === 1920, `${video.width}×${video.height}`);
  add('video length', Math.abs(video.duration - total) < 0.4, `${video.duration.toFixed(2)} s (planned ${total} s)`);
  add('video has sound', video.hasAudio, video.hasAudio ? 'yes' : 'no audio stream');

  const coverInfo = probe(cover);
  add('cover size 1080×1920', coverInfo.width === 1080 && coverInfo.height === 1920, `${coverInfo.width}×${coverInfo.height}`);
  // The picture area above the title must actually show the frame, not an empty background.
  const brightness = averageBrightness(cover, 'crop=1080:1000:0:120');
  add('cover shows the picture', brightness > 18, `average brightness ${brightness.toFixed(0)}/255 above the title`);

  // The narration must still be intelligible after mixing with the shots' own sound.
  const audio = join(dir, 'final-audio.mp3');
  ffmpeg(['-i', final, '-vn', '-ac', '1', '-b:a', '96k', audio]);
  const heard = await transcribe(audio);
  const cer = characterErrorRate(brief.narration, heard.text);
  add('narration clear in the mix', cer <= 0.12, `read error ${(cer * 100).toFixed(1)} %`);

  add('captions inside the video', captions.every((caption) => caption.start >= 0 && caption.start < total), `${captions.length} lines`);
  const text = captionText(brief);
  add('Instagram caption ≤ 2200 chars', text.length <= 2200, `${text.length} chars`);
  add('hashtags ≤ 30', brief.hashtags.length <= 30, `${brief.hashtags.length}`);

  // Contact sheet: nine frames across the edit, for a human (or Claude) to eyeball.
  const sheet = join(dir, 'contact-sheet.jpg');
  ffmpeg(['-i', final, '-vf', `fps=9/${total},scale=360:640,tile=3x3`, '-frames:v', '1', '-q:v', '3', sheet]);

  const passed = checks.every((check) => check.ok);
  await writeFile(join(dir, 'qa.json'), JSON.stringify({ passed, checks, heard: heard.text, sheet }, null, 2));
  for (const check of checks) await log(`qa: ${check.ok ? 'ok  ' : 'FAIL'} ${check.check}: ${check.detail}`);
  if (!passed) throw new Error('QA failed; see qa.json');
  return { passed, checks, sheet };
}

/** Drive file name in the ywa folder's convention, e.g. YWA_10_Air_Superiority_FA.mp4. */
export const driveName = (brief: Brief) =>
  `YWA_${String(brief.episode).padStart(2, '0')}_${brief.slug.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('_')}_FA`;

export async function upload(brief: Brief, final: string, cover: string) {
  const dir = outputDir(brief.slug);
  const name = driveName(brief);
  const proxyEnv = { ...process.env, HTTPS_PROXY: proxyUrl(), HTTP_PROXY: proxyUrl() };
  // The tunnel stalls on long requests: small chunks and short timeouts make a stall fail fast and retry.
  const flags = ['--drive-chunk-size', '4M', '--timeout', '45s', '--contimeout', '15s', '--low-level-retries', '30', '--retries', '5'];
  for (const [source, target] of [[final, `${name}.mp4`], [cover, `${name}_cover.jpg`]]) {
    await log(`upload: ${target}`);
    run('rclone', ['copyto', source, `ywa:${target}`, ...flags], { env: proxyEnv });
  }
  const listing = JSON.parse(run('rclone', ['lsjson', 'ywa:', '--files-only'], { env: proxyEnv })) as Array<{ Name: string; ID: string; Size: number }>;
  const find = (target: string) => {
    const file = listing.find((entry) => entry.Name === target);
    if (!file) throw new Error(`${target} not found in Drive after upload`);
    return `https://drive.usercontent.google.com/download?id=${file.ID}&export=download&confirm=t`;
  };
  const videoUrl = find(`${name}.mp4`);
  const coverUrl = find(`${name}_cover.jpg`);
  // Instagram fetches these anonymously, so check them without any credentials.
  for (const [label, url, type] of [['video', videoUrl, 'video/'], ['cover', coverUrl, 'image/']]) {
    const response = await axios.get(url, { ...http(), headers: { Range: 'bytes=0-1023' }, responseType: 'arraybuffer', validateStatus: () => true });
    const contentType = String(response.headers['content-type'] ?? '');
    if (![200, 206].includes(response.status) || !contentType.startsWith(type)) throw new Error(`${label} link is not public (HTTP ${response.status}, ${contentType})`);
  }
  const post = { account: 'ywa_ai', videoUrl, coverUrl, caption: captionText(brief), driveName: name, status: 'awaiting-approval' };
  await writeFile(join(dir, 'post.json'), JSON.stringify(post, null, 2));
  await log(`upload: public links verified`);
  return post;
}
