/* Google Flow, driven in the owner's real Chrome (signed in, on the VPN) over the remote-debugging websocket.
 * Requires remote debugging on at chrome://inspect/#remote-debugging (resets when Chrome restarts).
 * Downloads are taken from Playwright's download event (on a CDP-connected Chrome they never reach ~/Downloads). */
import { Browser, chromium, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Brief, outputDir, Shot } from './brief';
import { env, log, sleep } from './lib';

const CDP = env('CHROME_CDP_WS') || 'ws://127.0.0.1:9222/devtools/browser';
const GENERATION_TIMEOUT_MS = 10 * 60_000;

/** Flow's model menu labels. Veo 3.1 Lite is the default: 10 credits per 8 s clip vs 24 for Omni 1.2 Flash. */
export const FLOW_MODELS: Record<string, { label: string; creditsFor: (seconds: number) => number; fixedSeconds?: number }> = {
  'veo-3.1-lite': { label: 'Veo 3.1 - Lite', creditsFor: () => 10, fixedSeconds: 8 },
  'omni-1.2-flash': { label: 'Omni 1.2 Flash', creditsFor: (s) => (s <= 10 ? 3 * s : 30 + 6 * (s - 10)) },
};

let browser: Browser | undefined;

async function connect() {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(CDP, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`cannot reach your Chrome at ${CDP}: turn on chrome://inspect/#remote-debugging (${(error as Error).message.slice(0, 120)})`);
  }
  return browser;
}

/** Disconnects only; with connectOverCDP this leaves the owner's Chrome and tabs open. */
export async function closeFlow() {
  await browser?.close().catch(() => undefined);
  browser = undefined;
}

const click = (page: Page, selector: string) => page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.click(), selector);

async function readCredits(page: Page) {
  await click(page, 'div[aria-label="Account details"]');
  await sleep(1500);
  const text = await page.evaluate(() => document.body.innerText);
  await page.keyboard.press('Escape');
  const match = /([\d,]+) Google Flow credits/.exec(text);
  if (!match) throw new Error(/not available in your country/i.test(text) ? 'Flow is not available for this account' : 'could not read the Flow credit balance');
  return Number(match[1].replace(/,/g, ''));
}

/** One Flow project per episode and account, remembered so reruns add shots to the same project. */
async function openProject(page: Page, brief: Brief, account: number) {
  const memo = join(outputDir(brief.slug), `flow-project-u${account}.txt`);
  if (existsSync(memo)) {
    await page.goto((await readFile(memo, 'utf8')).trim(), { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(`https://flow.google.com/u/${account}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button:has-text("New project")', { timeout: 30_000 });
    await page.click('button:has-text("New project")');
    await page.waitForURL(/\/project\//, { timeout: 30_000 });
    await writeFile(memo, page.url());
    const title = page.locator('input[aria-label="Editable text"]').first();
    if (await title.count()) {
      await title.fill(`YWA ${String(brief.episode).padStart(2, '0')} — ${brief.slug}`);
      await title.press('Enter');
    }
  }
  await page.waitForSelector('button[aria-label="Settings trigger"]', { timeout: 45_000 });
}

async function configure(page: Page, modelKey: string, seconds: number) {
  const model = FLOW_MODELS[modelKey];
  await click(page, 'button[aria-label="Settings trigger"]');
  await sleep(1000);
  const pickRadio = (label: string) =>
    page.evaluate((text) => {
      const button = [...document.querySelectorAll('button[role=radio]')].find((b) => (b as HTMLElement).innerText.replace(/\s+/g, ' ').trim().endsWith(text));
      (button as HTMLElement | undefined)?.click();
      return Boolean(button);
    }, label);
  for (const label of ['Video', '9:16']) if (!(await pickRadio(label))) throw new Error(`Flow settings: "${label}" option not found`);
  await click(page, 'button[aria-label="Select model family"]');
  await sleep(800);
  const picked = await page.evaluate((label) => {
    const item = [...document.querySelectorAll('[role=menuitem],[role=option],[role=menuitemradio]')].find((e) => (e as HTMLElement).innerText.trim().startsWith(label));
    (item as HTMLElement | undefined)?.click();
    return Boolean(item);
  }, model.label);
  if (!picked) throw new Error(`Flow model "${model.label}" is not offered`);
  await sleep(800);
  await pickRadio('720p');
  await pickRadio('x1');
  if (!model.fixedSeconds) {
    // Length slider: value 0 = 3 s … 12 = 15 s.
    await page.evaluate((value) => {
      const input = document.querySelector('input[aria-label=Length]') as HTMLInputElement | null;
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, Math.min(12, Math.max(0, Math.ceil(seconds) - 3)));
  }
  await sleep(500);
  const summary = await page.evaluate(() => (document.querySelector('button[aria-label="Settings trigger"]') as HTMLElement)?.innerText.replace(/\s+/g, ' '));
  await page.keyboard.press('Escape');
  return summary;
}

const batchCount = (page: Page) => page.evaluate(() => document.querySelectorAll('button[aria-label=Download]').length);

/** Index of the Download button whose batch shows this prompt (newest first), or -1. */
function finishedBatchIndex(page: Page, prompt: string) {
  return page.evaluate((text) => {
    const wanted = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const buttons = [...document.querySelectorAll('button[aria-label=Download]')];
    return buttons.findIndex((button) => {
      let node: HTMLElement | null = button as HTMLElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (node.innerText.replace(/\s+/g, ' ').includes(wanted)) return node.querySelectorAll('button[aria-label=Download]').length === 1;
      }
      return false;
    });
  }, prompt);
}

export async function flowShot(brief: Brief, index: number, shot: Shot, file: string, account: number): Promise<void> {
  const modelKey = brief.flowModel ?? 'veo-3.1-lite';
  const model = FLOW_MODELS[modelKey];
  if (!model) throw new Error(`unknown flowModel "${modelKey}"`);
  const cost = model.creditsFor(shot.seconds);
  const page = await (await connect()).contexts()[0].newPage();
  const debug = join(outputDir(brief.slug), `flow-shot-${index + 1}-u${account}`);
  try {
    await page.goto(`https://flow.google.com/u/${account}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[aria-label="Account details"]', { timeout: 45_000 });
    if (!page.url().includes(`/u/${account}/`) && account !== 0) throw new Error(`account /u/${account}/ is not signed in to Chrome`);
    const credits = await readCredits(page);
    if (credits < cost) throw new Error(`only ${credits} credits left; this shot needs ${cost}`);
    await openProject(page, brief, account);
    const settings = await configure(page, modelKey, shot.seconds);
    await log(`flow u${account}: ${settings}; ${credits} credits, shot costs ${cost}`);

    // A finished clip with this exact prompt already in the project (an earlier run) is downloaded, not paid for again.
    if (await finishedBatchIndex(page, shot.prompt) >= 0) {
      await log(`flow u${account}: shot ${index + 1} already generated in this project, downloading it`);
    } else {
      const before = await batchCount(page);
      const box = page.locator('[contenteditable=true]').last();
      await box.click();
      await page.keyboard.insertText(shot.prompt);
      await sleep(500);
      await click(page, 'button[aria-label="Start generation"]');
      await log(`flow u${account}: generating shot ${index + 1}`);

      // Wait for a new finished batch (its Download button appears when the clip is ready) or an error message.
      const started = Date.now();
      for (;;) {
        if (Date.now() - started > GENERATION_TIMEOUT_MS) throw new Error('Flow generation timed out after 10 minutes');
        await sleep(10_000);
        const state = await page.evaluate(() => {
          const text = document.body.innerText;
          const failed = /(couldn.t generate|failed to generate|something went wrong|violat|policy|try a different prompt)/i.exec(text)?.[0];
          return { downloads: document.querySelectorAll('button[aria-label=Download]').length, failed };
        });
        if (state.failed) throw new Error(`Flow reported: ${state.failed}`);
        if (state.downloads > before) break;
      }
      await sleep(3000); // let the new batch settle before downloading
    }

    const batch = await finishedBatchIndex(page, shot.prompt);
    if (batch < 0) throw new Error('the finished clip for this prompt was not found on the page');
    // Playwright takes over downloads on a CDP-connected Chrome (they never reach ~/Downloads), so save it from the event.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      page.evaluate((i) => (document.querySelectorAll('button[aria-label=Download]')[i] as HTMLElement).click(), batch),
    ]);
    await download.saveAs(file);
    await log(`flow u${account}: shot ${index + 1} saved (${download.suggestedFilename()})`);
  } catch (error) {
    await page.screenshot({ path: `${debug}.png` }).catch(() => undefined);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}
