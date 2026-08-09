/* Free, source-grounded reel renderer. No generative-video service is used here. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

type Asset = { url: string; file: string; kind: 'image' | 'gif' | 'video'; alt?: string };
type Scene = { narration: string; onScreenText: string; animation: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right'; media?: string; duration?: number };
interface TtsAdapter { name: string; synthesize(text: string, output: string): void }

const SOURCE = 'https://huggingface.co/blog/grabette';
const font = '/Users/mojtabanpe/Library/Fonts/Vazirmatn.ttf';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).slice(-1800)}`);
};
const probe = (file: string) => {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read duration for ${file}`);
  return duration;
};
const slugify = (url: string) => new URL(url).pathname.split('/').filter(Boolean).pop()?.replace(/[^a-z0-9]+/gi, '-') || 'reel';
const decode = (text: string) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const clean = (text: string) => decode(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

class MacSayAdapter implements TtsAdapter {
  name = 'macos-say-majed-arabic-fallback';
  synthesize(text: string, output: string) {
    // Majed is Apple’s bundled Arabic voice. It is a zero-install fallback for Persian
    // where a dedicated local provider is not configured.
    run('say', ['-v', process.env.FREE_TTS_VOICE || 'Majed', '-r', process.env.FREE_TTS_RATE || '155', '-o', output, '--data-format=LEF32@44100', text]);
  }
}
class EspeakAdapter implements TtsAdapter {
  name = 'espeak-ng-fa';
  synthesize(text: string, output: string) { run('espeak-ng', ['-v', 'fa', '-s', process.env.FREE_TTS_RATE || '250', '-w', output, text]); }
}
function selectTts(): TtsAdapter {
  if (process.env.FREE_TTS_PROVIDER === 'espeak-ng') return new EspeakAdapter();
  if (spawnSync('espeak-ng', ['--version'], { encoding: 'utf8' }).status === 0) return new EspeakAdapter();
  return new MacSayAdapter();
}

const grabetteScenes: Scene[] = [
  { narration: 'اگر بخواهید به یک ربات یاد بدهید فنجان را بردارد، به داده‌های واقعی زیادی نیاز دارید. Grabette یک سیستم باز برای ثبت همین داده‌های دست‌کاری ربات است.', onScreenText: 'Grabette چیست؟', animation: 'zoom-in' },
  { narration: 'این پروژه از Hugging Face و Pollen Robotics، یک بازوی رومیزی و دوربین را برای ثبت حرکت، تصویر و فرمان‌های کاربر کنار هم قرار می‌دهد.', onScreenText: 'ثبت حرکت + تصویر + فرمان', animation: 'pan-right' },
  { narration: 'کاربر با رابط وب، یک جلسهٔ ضبط را شروع می‌کند؛ سپس کارهایی مثل برداشتن فنجان یا باز کردن کابینت را انجام می‌دهد.', onScreenText: 'ضبط کارهای واقعی ربات', animation: 'zoom-out' },
  { narration: 'پس از ضبط، داده‌ها در مرورگر بررسی و پردازش می‌شوند تا اپیزودهای قابل استفاده برای آموزش مدل آماده شوند.', onScreenText: 'بازبینی و پردازش اپیزودها', animation: 'pan-left' },
  { narration: 'هدف، ساده‌تر کردن ساخت دیتاست برای پژوهشگران و تیم‌هایی است که روی یادگیری مهارت‌های دست‌کاری در ربات‌ها کار می‌کنند.', onScreenText: 'دادهٔ باز برای رباتیک', animation: 'zoom-in' },
  { narration: 'Grabette یک مدل ویدیوساز نیست؛ زیرساختی باز است تا داده‌های بهتر تولید شود و ربات‌ها مهارت‌های فیزیکی را سریع‌تر یاد بگیرند.', onScreenText: 'منبع: Hugging Face Blog', animation: 'zoom-out' },
];

async function fetchArticle(url: string) {
  const response = await fetch(url, { headers: { 'User-Agent': 'ywa-ai-free-reel/1.0 (+source-attribution)' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Source request failed with HTTP ${response.status}`);
  return response.text();
}
function extractAssets(html: string, baseUrl: string): Array<{ url: string; alt?: string }> {
  const found: Array<{ url: string; alt?: string }> = [];
  for (const match of html.matchAll(/<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi)) {
    const content = match[0].match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (content) found.push({ url: new URL(decode(content), baseUrl).toString(), alt: 'Article cover' });
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]; const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!src || !/\.(png|jpe?g|gif|webp|mp4)(?:\?|$)/i.test(src)) continue;
    const url = new URL(decode(src), baseUrl).toString();
    // Exclude author/recommendation avatars and retain the article's own Grabette material.
    if (!/grabette/i.test(url)) continue;
    found.push({ url, alt: tag.match(/\balt=["']([^"']*)["']/i)?.[1] });
  }
  return [...new Map(found.map((asset) => [asset.url, asset])).values()];
}
function pixelArea(file: string) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [width, height] = result.stdout.trim().split(',').map(Number);
  return Number.isFinite(width * height) ? width * height : 0;
}
async function downloadAssets(items: Array<{ url: string; alt?: string }>, dir: string): Promise<Asset[]> {
  const assets: Asset[] = [];
  for (const item of items) {
    try {
      const response = await fetch(item.url, { headers: { 'User-Agent': 'ywa-ai-free-reel/1.0' }, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) continue;
      const extension = extname(new URL(item.url).pathname).toLowerCase() || '.bin';
      const name = `${createHash('sha256').update(item.url).digest('hex').slice(0, 14)}${extension}`;
      await writeFile(join(dir, name), Buffer.from(await response.arrayBuffer()));
      assets.push({ url: item.url, file: join(dir, name), kind: extension === '.gif' ? 'gif' : extension === '.mp4' ? 'video' : 'image', alt: item.alt });
    } catch (error) { console.warn(`Asset download skipped (${item.url}): ${error instanceof Error ? error.message : 'unknown error'}`); }
  }
  return assets;
}
function srtTime(seconds: number) { const ms = Math.round(seconds * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }
function escapedFilterPath(path: string) { return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'"); }
function xml(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function twoLines(value: string) {
  const words = value.split(/\s+/); const pivot = Math.ceil(words.length / 2);
  return [words.slice(0, pivot).join(' '), words.slice(pivot).join(' ')];
}
async function renderCaption(scene: Scene, index: number, job: string) {
  const svg = join(job, `caption-${index + 1}.svg`); const png = join(job, `caption-${index + 1}.png`);
  const [line1, line2] = twoLines(scene.narration.split(/\s+/).slice(0, 18).join(' ')); const headline = scene.onScreenText;
  await writeFile(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><style>text{font-family:Vazirmatn,Arial,sans-serif;font-weight:700}</style><text x="48" y="105" fill="#ffffff" opacity=".86" font-size="30">ywa_ai</text><rect x="58" y="1370" width="964" height="300" rx="34" fill="#07101ce0"/><text x="960" y="1450" text-anchor="end" direction="rtl" unicode-bidi="bidi-override" fill="#68e0c1" font-size="39">${xml(headline)}</text><text x="960" y="1535" text-anchor="end" direction="rtl" unicode-bidi="bidi-override" fill="white" font-size="25">${xml(line1)}</text><text x="960" y="1595" text-anchor="end" direction="rtl" unicode-bidi="bidi-override" fill="white" font-size="25">${xml(line2)}</text></svg>`);
  // sips is bundled with macOS and preserves the SVG's 1080x1920 canvas and alpha.
  run('sips', ['-s', 'format', 'png', svg, '--out', png]);
  return png;
}

async function main() {
  if ((process.env.VIDEO_MODE || 'free').toLowerCase() !== 'free') throw new Error('This CLI only renders VIDEO_MODE=free; paid video providers are intentionally never called.');
  const url = process.argv.find((arg, i, all) => all[i - 1] === '--url') || SOURCE;
  const job = join(process.cwd(), 'output', slugify(url)); const assetDir = join(job, 'assets'); await mkdir(assetDir, { recursive: true });
  const html = await fetchArticle(url); const title = clean(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'Source article');
  const extracted = extractAssets(html, url); const assets = await downloadAssets(extracted, assetDir);
  if (!assets.length) throw new Error('No usable source media was downloaded; refusing to substitute unrelated stock media.');
  await writeFile(join(job, 'source.json'), JSON.stringify({ url, title, fetchedAt: new Date().toISOString(), assets }, null, 2));
  if (grabetteScenes.length < 5 || grabetteScenes.length > 7 || grabetteScenes.some((scene) => !scene.narration.trim() || !scene.onScreenText.trim())) {
    throw new Error('Malformed scene data: expected 5–7 scenes with narration and on-screen text.');
  }
  // Prefer the source page's higher-resolution originals; tiny GIF previews remain
  // attributed in source.json but are not promoted to full-screen scene media.
  const preferredAssets = [...assets].sort((a, b) => pixelArea(b.file) - pixelArea(a.file));
  const findPreferred = (pattern: RegExp, fallbackIndex: number) =>
    preferredAssets.find((asset) => pattern.test(asset.url)) ?? preferredAssets[fallbackIndex % preferredAssets.length];
  // This first reference job has known source assets. The mapping avoids low-resolution
  // previews and the Browser_postprocess GIF's long blank/loading section.
  const sceneAssets = [
    findPreferred(/thumbnail_grabette/i, 0),
    findPreferred(/grabette_label_big/i, 1),
    findPreferred(/start_session/i, 2),
    findPreferred(/start_session/i, 0),
    findPreferred(/grabette_gripette/i, 3),
    findPreferred(/thumbnail_grabette/i, 0),
  ];
  const scenes = grabetteScenes.map((scene, i) => ({ ...scene, media: sceneAssets[i].file }));
  await writeFile(join(job, 'script.json'), JSON.stringify({ language: 'fa', source: url, scenes: grabetteScenes }, null, 2));
  const tts = selectTts(); const narrationParts: string[] = [];
  for (const [index, scene] of scenes.entries()) { const part = join(job, `narration-${index + 1}.wav`); tts.synthesize(scene.narration, part); narrationParts.push(part); scene.duration = probe(part) + 0.35; }
  await writeFile(join(job, 'narration-list.txt'), narrationParts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'));
  run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', join(job, 'narration-list.txt'), '-c:a', 'pcm_s16le', join(job, 'narration.wav')]);
  let time = 0; const subtitleBlocks = scenes.map((scene, index) => { const start = time; time += scene.duration!; return `${index + 1}\n${srtTime(start)} --> ${srtTime(time - 0.1)}\n${scene.narration}\n`; });
  await writeFile(join(job, 'subtitles.srt'), subtitleBlocks.join('\n'));
  await writeFile(join(job, 'scenes.json'), JSON.stringify({ tts: tts.name, duration: time, scenes }, null, 2));
  const clips: string[] = [];
  for (const [index, scene] of scenes.entries()) {
    const clip = join(job, `clip-${index + 1}.mp4`); const duration = scene.duration!.toFixed(3); const source = scene.media!;
    // Overlay + foreground preserves every source aspect ratio: blurred fill below, gently zoomed cover above.
    const frames = Math.ceil(Number(duration) * 30);
    const motion = scene.animation === 'zoom-out'
      ? `z='max(1.0,1.04-0.00018*on)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      : scene.animation === 'pan-left'
        ? `z='1.035':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`
        : scene.animation === 'pan-right'
          ? `z='1.035':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`
          : `z='min(1.04,1+0.00018*on)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    const caption = await renderCaption(scene, index, job);
    const filter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,boxblur=24:8,eq=brightness=-0.22:saturation=0.88[bg];[0:v]scale=1020:1700:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[composite];[composite]fps=30,zoompan=${motion}:d=1:s=1080x1920:fps=30,unsharp=5:5:0.35:3:3:0[base];[base][1:v]overlay=0:0[v]`;
    const input = assets.find((asset) => asset.file === source)!;
    const args = input.kind === 'image' ? ['-loop', '1', '-i', source] : ['-stream_loop', '-1', '-i', source];
    run(ffmpeg, ['-y', ...args, '-i', caption, '-t', duration, '-filter_complex', filter, '-map', '[v]', '-an', '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M', '-pix_fmt', 'yuv420p', clip]); clips.push(clip);
  }
  await writeFile(join(job, 'clips.txt'), clips.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`).join('\n'));
  run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', join(job, 'clips.txt'), '-i', join(job, 'narration.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', join(job, 'final.mp4')]);
  console.log(JSON.stringify({ output: join(job, 'final.mp4'), assets: assets.length, duration: probe(join(job, 'final.mp4')).toFixed(2), tts: tts.name }, null, 2));
}
main().catch((error) => { console.error(`FREE_MODE reel failed: ${error instanceof Error ? error.stack || error.message : String(error)}`); process.exitCode = 1; });
