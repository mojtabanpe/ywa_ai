/* Publishes ywa_ai Reels as YouTube Shorts on "You walk alone" through YouTube Studio in the owner's Chrome
 * (signed in, on the VPN), over the same remote-debugging connection the Flow step uses.
 * Usage: pnpm youtube <shortcode | episode slug> [...more]
 * Reads/updates output/youtube-migration/manifest.json and status.json; an item already published is skipped.
 * Owner rule (ROADMAP.md): every Instagram post also goes to YouTube; Instagram approval covers this upload. */
import { chromium, Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromeEndpoint } from './episode/lib';

const CHANNEL = 'UCt4vvTwH1BzVn-otS4suXDg';
const DIR = join('output', 'youtube-migration');
const MANIFEST = join(DIR, 'manifest.json');
const STATUS = join(DIR, 'status.json');

interface Item {
  media_id?: string;
  shortcode?: string;
  slug?: string;
  title: string;
  description: string;
  file: string;
  upload_status: string;
  youtube_url?: string;
  youtube_id?: string;
  ai_disclosure?: string;
  audience?: string;
  published_at?: string;
  error?: string;
}

const load = (): Item[] => JSON.parse(readFileSync(MANIFEST, 'utf8'));
const save = (items: Item[]) => {
  writeFileSync(MANIFEST, JSON.stringify(items, null, 2));
  const pending = items.filter((item) => item.upload_status !== 'published');
  const status = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : {};
  writeFileSync(
    STATUS,
    JSON.stringify(
      {
        ...status,
        total: items.length,
        published: items.length - pending.length,
        pending: pending.map(({ shortcode, slug, title, file, error }) => ({ shortcode: shortcode ?? slug, title, file, reason: error ?? 'not uploaded yet' })),
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
};

/** An episode made by the pipeline that was published on Instagram but is not in the manifest yet. */
function itemFromEpisode(slug: string): Item | undefined {
  const postFile = join('output', 'episodes', slug, 'post.json');
  const briefFile = join('episodes', slug, 'brief.json');
  if (!existsSync(postFile) || !existsSync(briefFile)) return undefined;
  const post = JSON.parse(readFileSync(postFile, 'utf8'));
  const brief = JSON.parse(readFileSync(briefFile, 'utf8'));
  if (post.status !== 'published') throw new Error(`${slug} is not published on Instagram yet; YouTube follows Instagram`);
  // brief.youtubeTitle when given (written for YouTube search); otherwise the cover title plus the series name.
  const title = (brief.youtubeTitle ?? `${brief.title} | ایران در دنیای موازی`).slice(0, 100);
  return { media_id: post.instagramMediaId, slug, title, description: post.caption, file: resolve(join('output', 'episodes', slug, 'final.mp4')), upload_status: 'pending' };
}

async function upload(page: Page, item: Item) {
  await page.goto(`https://studio.youtube.com/channel/${CHANNEL}`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront(); // Studio does not render in a background tab
  const create = page.getByRole('button', { name: 'Create', exact: true }).first();
  await create.waitFor({ timeout: 60_000 });
  await create.click();
  await page.getByText('Upload videos', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.setInputFiles('input[type=file]', item.file);
  const boxes = page.locator('ytcp-uploads-dialog #textbox');
  await boxes.first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(3000);
  const limit = await page.evaluate(() => /daily upload limit/i.test(document.body.innerText));
  if (limit) throw new Error('Daily upload limit reached');

  const fill = async (index: number, text: string) => {
    await boxes.nth(index).click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(400);
  };
  await fill(0, item.title);
  await fill(1, item.description.slice(0, 5000));
  await page.click('tp-yt-paper-radio-button[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]');
  await page.click('ytcp-uploads-dialog #toggle-button'); // "Show more" holds the AI-content question
  await page.waitForTimeout(1200);
  await page.click('tp-yt-paper-radio-button[name=VIDEO_HAS_ALTERED_CONTENT_YES]');
  const link = await page.evaluate(() => document.querySelector('ytcp-video-info a')?.getAttribute('href') ?? '');
  for (let i = 0; i < 3; i++) {
    await page.click('ytcp-uploads-dialog #next-button');
    await page.waitForTimeout(2000);
  }
  await page.click('tp-yt-paper-radio-button[name=PUBLIC]');
  await page.waitForTimeout(1000);
  await page.click('ytcp-uploads-dialog #done-button');
  const match = /shorts\/([\w-]+)|v=([\w-]+)|youtu\.be\/([\w-]+)/.exec(link);
  const id = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  // "Video published" usually appears once YouTube accepts it; it did not show for later uploads in a row,
  // although they were public. So the content list is the source of truth when the message is missing.
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText);
    if (/Video published/i.test(text)) return { url: link, id };
    if (/daily upload limit/i.test(text)) throw new Error('Daily upload limit reached');
  }
  if (id && (await isPublic(page, id))) return { url: link, id };
  throw new Error(`YouTube did not confirm the upload; check ${link} in Studio before retrying (it may exist as a draft)`);
}

/** Reads the visibility of a video from the channel's Shorts list in Studio. */
async function isPublic(page: Page, id: string) {
  await page.goto(`https://studio.youtube.com/channel/${CHANNEL}/videos/short`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForSelector('ytcp-video-row', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const visibility = await page.evaluate((videoId) => {
    const row = [...document.querySelectorAll('ytcp-video-row')].find((r) => r.querySelector(`a[href*="/video/${videoId}/"]`));
    const cell = row && [...row.querySelectorAll('[class*=visibility], [id*=visibility]')].map((c) => (c as HTMLElement).innerText.trim()).find(Boolean);
    return cell ?? '';
  }, id);
  return /public/i.test(visibility);
}

async function main() {
  const keys = process.argv.slice(2).filter((arg) => arg !== '--');
  if (!keys.length) throw new Error('usage: pnpm youtube <shortcode | episode slug> [...]');
  const items = load();
  const browser = await chromium.connectOverCDP(await chromeEndpoint(), { timeout: 90_000 });
  const page = await browser.contexts()[0].newPage();
  let failed = 0;
  try {
    for (const key of keys) {
      let item = items.find((entry) => entry.shortcode === key || entry.slug === key);
      if (!item) {
        item = itemFromEpisode(key);
        if (!item) throw new Error(`${key}: not in the manifest and no published episode with that slug`);
        items.push(item);
        save(items);
      }
      if (item.upload_status === 'published') {
        console.log(`${key}: already on YouTube (${item.youtube_url}), skipped`);
        continue;
      }
      try {
        console.log(`${key}: uploading "${item.title}"`);
        const { url, id } = await upload(page, item);
        Object.assign(item, { upload_status: 'published', youtube_url: url, youtube_id: id, ai_disclosure: 'True', audience: 'not_made_for_kids', published_at: new Date().toISOString() });
        delete item.error;
        console.log(`${key}: published ${url}`);
      } catch (error) {
        failed++;
        item.upload_status = 'pending';
        item.error = (error as Error).message.slice(0, 200);
        console.log(`${key}: FAILED ${item.error}`);
        if (/daily upload limit/i.test(item.error)) break; // the rest would hit the same limit
      } finally {
        save(items);
      }
    }
  } finally {
    await page.close().catch(() => undefined);
    await browser.close(); // disconnects only; the owner's Chrome stays open
  }
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
