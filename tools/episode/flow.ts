/* Google Flow, driven in the owner's real Chrome (signed in, on the VPN) over the remote-debugging websocket.
 * Requires remote debugging on at chrome://inspect/#remote-debugging (resets when Chrome restarts).
 * Downloads are taken from Playwright's download event (on a CDP-connected Chrome they never reach ~/Downloads). */
import { Browser, chromium, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Brief, outputDir, Shot } from './brief';
import { characterFile } from './characters';
import { chromeEndpoint, env, log, sleep } from './lib';

const GENERATION_TIMEOUT_MS = 10 * 60_000;

/** Flow's model menu labels. Omni 1.2 Flash is the default (owner's choice): 24 credits per 8 s clip; Veo 3.1 Lite is 10. */
export const FLOW_MODELS: Record<string, { label: string; creditsFor: (seconds: number) => number; fixedSeconds?: number }> = {
  'veo-3.1-lite': { label: 'Veo 3.1 - Lite', creditsFor: () => 10, fixedSeconds: 8 },
  'omni-1.2-flash': { label: 'Omni 1.2 Flash', creditsFor: (s) => (s <= 10 ? 3 * s : 30 + 6 * (s - 10)) },
};

let browser: Browser | undefined;

async function connect() {
  if (browser?.isConnected()) return browser;
  // Chrome rejects a connection (403) while its "Allow remote debugging?" prompt is still waiting for the owner,
  // and refuses outright when the setting is off. Retry for 90 s so a click on Allow is enough; only then fall back.
  const deadline = Date.now() + 90_000;
  let opened = false;
  for (let attempt = 1; ; attempt++) {
    try {
      browser = await chromium.connectOverCDP(await chromeEndpoint(), { timeout: 30_000 });
      return browser;
    } catch (error) {
      const message = (error as Error).message;
      if (!opened) {
        // The setting resets whenever Chrome restarts: open the page so the owner only has to tick the box.
        if (!/403|rejected/i.test(message)) spawnSync('open', ['-a', 'Google Chrome', 'chrome://inspect/#remote-debugging']);
        await log(`flow: waiting for Chrome; click Allow in Chrome, or tick the box on chrome://inspect/#remote-debugging`);
        opened = true;
      }
      if (Date.now() > deadline) {
        throw new Error(`cannot reach the automation Chrome after ${attempt} tries: tick "Allow remote debugging" on chrome://inspect/#remote-debugging and click Allow (${message.slice(0, 120)})`);
      }
      await sleep(5_000);
    }
  }
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

interface Settings {
  mode: 'video' | 'image';
  /** Start of the label in Flow's model menu, e.g. "Omni 1.2 Flash" or "Nano Banana 2.1" (the menu adds an emoji). */
  modelLabel: string;
  aspect: '9:16' | '3:4';
  /** Video only: clip length; ignored by fixed-length models. */
  seconds?: number;
  /** Video only: generate from ingredient images (keeps a character's face) instead of frames. */
  ingredients?: boolean;
}

async function configure(page: Page, settings: Settings) {
  await click(page, 'button[aria-label="Settings trigger"]');
  await sleep(1000);
  const pickRadio = (label: string) =>
    page.evaluate((text) => {
      const button = [...document.querySelectorAll('button[role=radio]')].find((b) => (b as HTMLElement).innerText.replace(/\s+/g, ' ').trim().endsWith(text));
      (button as HTMLElement | undefined)?.click();
      return Boolean(button);
    }, label);
  if (!(await pickRadio(settings.mode === 'video' ? 'Video' : 'Image'))) throw new Error(`Flow settings: ${settings.mode} mode not found`);
  await sleep(800);
  if (settings.mode === 'video' && !(await pickRadio(settings.ingredients ? 'Ingredients' : 'Frames'))) throw new Error('Flow settings: Frames/Ingredients option not found');
  if (!(await pickRadio(settings.aspect))) throw new Error(`Flow settings: ${settings.aspect} not found`);
  await click(page, 'button[aria-label="Select model family"]');
  await sleep(800);
  const picked = await page.evaluate((label) => {
    const item = [...document.querySelectorAll('[role=menuitem],[role=option],[role=menuitemradio]')].find((e) => (e as HTMLElement).innerText.includes(label));
    (item as HTMLElement | undefined)?.click();
    return Boolean(item);
  }, settings.modelLabel);
  if (!picked) throw new Error(`Flow model "${settings.modelLabel}" is not offered`);
  await sleep(800);
  await pickRadio(settings.mode === 'video' ? '720p' : 'High');
  await pickRadio('x1');
  if (settings.mode === 'video' && settings.seconds) {
    // Length slider: value 0 = 3 s … 12 = 15 s (absent for fixed-length models).
    await page.evaluate((value) => {
      const input = document.querySelector('input[aria-label=Length]') as HTMLInputElement | null;
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, Math.min(12, Math.max(0, Math.ceil(settings.seconds) - 3)));
  }
  await sleep(500);
  const summary = await page.evaluate(() => {
    const credits = [...document.querySelectorAll('a')].find((a) => /credits/.test(a.innerText))?.innerText ?? '';
    return `${(document.querySelector('button[aria-label="Settings trigger"]') as HTMLElement)?.innerText.replace(/\s+/g, ' ')} (${credits})`;
  });
  await page.keyboard.press('Escape');
  return summary;
}

/** Index of the Download button whose batch shows this prompt (newest first), or -1. */
function finishedBatchIndex(page: Page, prompt: string) {
  return page.evaluate((text) => {
    const wanted = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const downloads = (node: Element) => node.querySelectorAll('button[aria-label=Download]').length;
    const buttons = [...document.querySelectorAll('button[aria-label=Download]')];
    return buttons.findIndex((button) => {
      // A button's own batch = the largest ancestor that still holds only this one Download button. Climbing past it
      // reaches neighbours: a batch still generating has no Download button, so its prompt used to be credited to
      // the previous finished batch, and that older clip was downloaded for the new shot.
      let own: HTMLElement = button as HTMLElement;
      while (own.parentElement && downloads(own.parentElement) === 1) own = own.parentElement;
      // The prompt must START a line: a plain "includes" also matched a longer prompt that contained this one.
      return own.innerText.split('\n').some((line) => line.replace(/\s+/g, ' ').trim().startsWith(wanted));
    });
  }, prompt);
}

/** Opens the episode's project on an account that has enough credits; returns the page and the balance. */
async function openFor(brief: Brief, account: number, cost: number) {
  const page = await (await connect()).contexts()[0].newPage();
  try {
    await page.goto(`https://flow.google.com/u/${account}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[aria-label="Account details"]', { timeout: 45_000 });
    if (!page.url().includes(`/u/${account}/`) && account !== 0) throw new Error(`account /u/${account}/ is not signed in to Chrome`);
    const credits = await readCredits(page);
    if (credits < cost) throw new Error(`only ${credits} credits left; this needs ${cost}`);
    await openProject(page, brief, account);
    return { page, credits };
  } catch (error) {
    await page.close().catch(() => undefined);
    throw error;
  }
}

const SUBMIT_CONFIRM_MS = 45_000;

const promptBoxText = (page: Page) =>
  page.evaluate(() => (document.querySelector('[contenteditable=true][role=textbox]') as HTMLElement | null)?.innerText.trim() ?? '');

/**
 * Presses Flow's send button and waits until Flow has taken the prompt (it empties the prompt box when a generation
 * starts). Since Nov 2026 Flow ignores a DOM `element.click()` on that button, so the prompt sat in the box until the
 * 10-minute timeout; it needs a real pointer click. Fails within a minute instead of waiting for a result that never comes.
 */
async function submit(page: Page, prompt: string) {
  const wanted = prompt.replace(/\s+/g, ' ').trim().slice(0, 40);
  const pending = async () => (await promptBoxText(page)).replace(/\s+/g, ' ').startsWith(wanted);
  const button = page.locator('button[aria-label="Start generation"]').last();
  if (!(await button.count())) throw new Error('Flow: the "Start generation" button was not found; the page layout may have changed');
  for (const attempt of ['click', 'enter'] as const) {
    if (attempt === 'click') {
      if (await button.isDisabled()) throw new Error('Flow: the "Start generation" button is disabled');
      await button.click({ timeout: 10_000 });
    } else {
      await log('flow: the send button did not start a generation; trying Enter in the prompt box');
      await page.locator('[contenteditable=true][role=textbox]').last().press('Enter');
    }
    const deadline = Date.now() + SUBMIT_CONFIRM_MS / 2;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (!(await pending())) return;
    }
  }
  throw new Error(`Flow did not start the generation: the prompt is still in the box after ${SUBMIT_CONFIRM_MS / 1000} s (the send control may have changed)`);
}

/** Types the prompt, generates once (unless this prompt already finished in the project), and saves the result. */
async function generate(page: Page, prompt: string, file: string, label: string) {
  if (await finishedBatchIndex(page, prompt) >= 0) {
    await log(`${label}: already generated in this project, downloading it`);
  } else {
    // Failed generations stay in the project as "Failed" cards; only a new one belongs to this attempt.
    const failedCards = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter((e) => e.children.length === 0 && (e as HTMLElement).innerText?.trim() === 'Failed')
          .map((e) => (e.parentElement as HTMLElement).innerText.replace(/\s+/g, ' ').replace(/^Failed\s*/, '').slice(0, 200)),
      );
    const failedBefore = (await failedCards()).length;
    const box = page.locator('[contenteditable=true]').last();
    await box.click();
    // Flow keeps unsent text in the box between visits; typing after it would send both prompts as one.
    if (await promptBoxText(page)) {
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
    }
    await page.keyboard.insertText(prompt);
    await sleep(500);
    await submit(page, prompt);
    await log(`${label}: generating`);
    // Wait for this prompt's finished batch (its Download button appears when the result is ready) or a new Failed card.
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > GENERATION_TIMEOUT_MS) throw new Error('Flow generation timed out after 10 minutes');
      await sleep(8_000);
      const failed = await failedCards();
      // Newest card is listed first. A policy refusal (e.g. naming a prominent real person) is refunded by Flow.
      if (failed.length > failedBefore) throw new Error(`Flow refused: ${failed[0]}`);
      // Flow renders only the items on screen, so counting Download buttons misses new results in a full project;
      // wait for the batch that shows this exact prompt instead (the newest is at the top).
      if ((await finishedBatchIndex(page, prompt)) >= 0) break;
    }
    await sleep(3000); // let the new batch settle before downloading
  }
  const batch = await finishedBatchIndex(page, prompt);
  if (batch < 0) throw new Error('the finished result for this prompt was not found on the page');
  // Playwright takes over downloads on a CDP-connected Chrome (they never reach ~/Downloads), so save it from the event.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.evaluate((i) => (document.querySelectorAll('button[aria-label=Download]')[i] as HTMLElement).click(), batch),
  ]);
  await download.saveAs(file);
  await log(`${label}: saved (${download.suggestedFilename()})`);
}

/** Free in Flow (Nano Banana): a 3:4 portrait used as a character reference. */
export async function flowImage(brief: Brief, prompt: string, file: string, account: number) {
  const { page } = await openFor(brief, account, 0);
  try {
    await log(`flow u${account}: ${await configure(page, { mode: 'image', modelLabel: 'Nano Banana 2.1', aspect: '3:4' })}`);
    await generate(page, prompt, file, `flow u${account} image`);
  } catch (error) {
    await page.screenshot({ path: `${file}.error.png` }).catch(() => undefined);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function flowShot(brief: Brief, index: number, shot: Shot, file: string, account: number): Promise<void> {
  const modelKey = brief.flowModel ?? 'omni-1.2-flash'; // owner prefers Omni over Veo (2026-11-17)
  const model = FLOW_MODELS[modelKey];
  if (!model) throw new Error(`unknown flowModel "${modelKey}"`);
  const cost = model.creditsFor(shot.seconds);
  const { page, credits } = await openFor(brief, account, cost);
  try {
    const references = (shot.characters ?? []).map((id) => characterFile(brief.slug, id));
    const settings = await configure(page, { mode: 'video', modelLabel: model.label, aspect: '9:16', seconds: model.fixedSeconds ? undefined : shot.seconds, ingredients: references.length > 0 });
    await log(`flow u${account}: ${settings}; ${credits} credits, shot costs ${cost}`);
    if (references.length) await attachIngredients(page, references);
    await generate(page, shot.prompt, file, `flow u${account} shot ${index + 1}`);
  } catch (error) {
    await page.screenshot({ path: join(outputDir(brief.slug), `flow-shot-${index + 1}-u${account}.png`) }).catch(() => undefined);
    throw error;
  } finally {
    await page.close().catch(() => undefined);
  }
}

const ingredientCount = (page: Page) => page.evaluate(() => document.querySelectorAll('img[alt="Ingredient image"]').length);

/**
 * Adds reference images to the prompt box (Ingredients mode). In the "+" picker, clicking an asset adds it at once.
 * Each file is uploaded to the project once (by its file name) and reused on later shots.
 */
async function attachIngredients(page: Page, files: string[]) {
  // Flow keeps the prompt box (and its ingredients) between visits; start each shot from an empty box.
  if ((await ingredientCount(page)) > 0) {
    await click(page, 'button[aria-label="Clear prompt"]');
    for (let i = 0; i < 5 && (await ingredientCount(page)) > 0; i++) await sleep(1000);
    if ((await ingredientCount(page)) > 0) throw new Error('could not clear the ingredients left in the prompt box');
  }
  for (const source of files) {
    // Upload under a name tied to the image's content: a plain file name was reused for a different (older) face.
    const hash = createHash('sha1').update(await readFile(source)).digest('hex').slice(0, 8);
    const file = join(dirname(source), `${basename(source, extname(source))}-${hash}${extname(source)}`);
    if (!existsSync(file)) await copyFile(source, file);
    const name = basename(file);
    const before = await ingredientCount(page);
    const option = () => page.locator('[role=option]', { hasText: name }).filter({ hasNotText: 'Uploading' }).first();
    await click(page, 'button[aria-label="Add ingredients to the prompt box"]');
    await sleep(1500);
    if (!(await option().count())) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), page.click('button:has-text("Upload media")')]);
      await chooser.setFiles(file);
      await log(`flow: uploading ingredient ${name}`);
      for (let i = 0; i < 30 && !(await option().count()); i++) await sleep(2000);
      if (!(await option().count())) throw new Error(`ingredient ${name} did not finish uploading`);
      // A fresh upload is added to the prompt by Flow itself a moment later; clicking too soon toggles it back off.
      for (let i = 0; i < 8 && (await ingredientCount(page)) === before; i++) await sleep(1000);
    }
    if ((await ingredientCount(page)) === before) {
      // Clicking an asset either adds it at once or only selects it (preview + "Add to prompt" button).
      await option().click();
      await sleep(1500);
      const add = page.locator('button', { hasText: 'Add to prompt' });
      if ((await ingredientCount(page)) === before && (await add.count()) && (await add.first().isVisible())) await add.first().click();
    }
    for (let i = 0; i < 10 && (await ingredientCount(page)) === before; i++) await sleep(1000);
    if ((await ingredientCount(page)) === before) throw new Error(`ingredient ${name} was not added to the prompt`);
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  await log(`flow: ${await ingredientCount(page)} ingredient image(s) in the prompt`);
}
