/* Persian on-screen graphics (captions, fiction label, cover) rendered in headless Chromium:
 * this ffmpeg build has no drawtext/libass, and the browser shapes Persian text correctly. */
import { chromium, Browser } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FONT_DIR = resolve('node_modules/@fontsource-variable/vazirmatn/files');
const FONT_FACES = ['arabic', 'latin', 'latin-ext']
  .map((subset) => `@font-face{font-family:Vz;font-weight:100 900;src:url("${pathToFileURL(`${FONT_DIR}/vazirmatn-${subset}-wght-normal.woff2`).href}") format("woff2")}`)
  .join('');

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

let browser: Browser | undefined;
async function page(width: number, height: number) {
  browser ??= await chromium.launch();
  return browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
}

export async function closeGraphics() {
  await browser?.close();
  browser = undefined;
}

async function render(html: string, width: number, height: number, file: string, transparent: boolean) {
  const p = await page(width, height);
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>${FONT_FACES}html,body{margin:0;width:${width}px;height:${height}px;background:${transparent ? 'transparent' : '#000'}}</style>${html}`);
  await p.evaluate(() => document.fonts.ready);
  if (file.endsWith('.png')) await p.screenshot({ path: file, omitBackground: transparent });
  else await p.screenshot({ path: file, type: 'jpeg', quality: 92 });
  await p.close();
}

/** One caption line, 1080×260 transparent PNG; placed in the lower third, clear of Instagram's bottom UI. */
export function renderCaption(text: string, file: string) {
  return render(
    `<div style="height:100%;display:flex;align-items:center;justify-content:center;padding:0 70px;box-sizing:border-box">
       <div dir="rtl" style="font-family:Vz;font-weight:800;font-size:64px;line-height:1.35;color:#fff;text-align:center;
         background:rgba(0,0,0,.55);padding:14px 34px;border-radius:26px;
         text-shadow:0 2px 6px rgba(0,0,0,.8)">${escape(text)}</div></div>`,
    1080,
    260,
    file,
    true,
  );
}

/** Small top badge that marks alternate-history episodes as fiction. */
export function renderFictionLabel(file: string) {
  return render(
    `<div style="height:100%;display:flex;align-items:center;justify-content:center">
       <div dir="rtl" style="font-family:Vz;font-weight:700;font-size:40px;color:#fff;background:rgba(180,30,30,.85);
         padding:10px 30px;border-radius:40px;letter-spacing:0">روایت تخیلی · دنیای موازی</div></div>`,
    1080,
    140,
    file,
    true,
  );
}

/** Cover: a frame of the edit with the title kept inside the centre 3:4 area (1080×1440) that the profile grid shows. */
export async function renderCover(frame: string, title: string, subtitle: string | undefined, episode: number, file: string) {
  // Inlined as a data URI: a page made with setContent may not load file:// images (that left the background black).
  const background = `data:image/jpeg;base64,${(await readFile(frame)).toString('base64')}`;
  return render(
    `<div style="position:relative;width:1080px;height:1920px;background:url('${background}') center/cover">
       <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.75) 72%,rgba(0,0,0,.85) 100%)"></div>
       <div dir="rtl" style="position:absolute;left:70px;right:70px;top:1180px;text-align:center;font-family:Vz;color:#fff">
         <div style="display:inline-block;font-weight:700;font-size:38px;background:#e11d48;padding:6px 26px;border-radius:30px">قسمت ${episode.toLocaleString('fa-IR')}</div>
         <div style="font-weight:900;font-size:86px;line-height:1.25;margin-top:22px;text-shadow:0 4px 18px rgba(0,0,0,.9)">${escape(title)}</div>
         ${subtitle ? `<div style="font-weight:500;font-size:44px;margin-top:14px;opacity:.92">${escape(subtitle)}</div>` : ''}
       </div></div>`,
    1080,
    1920,
    file,
    false,
  );
}
