import { expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { APP_URL, LOCAL_CONFIG } from './servers.mjs';

export { APP_URL };

/** A fresh, isolated "device" (own storage, own WebRTC stack). */
export async function device(browser, { name, viewport = { width: 1360, height: 860 }, config = '', ...ctxOpts } = {}) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, ...ctxOpts });
  await ctx.addInitScript(LOCAL_CONFIG + config);
  if (name) await ctx.addInitScript(`try { localStorage.setItem('qrshare:name', ${JSON.stringify(name)}); } catch {}`);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  return page;
}

export async function createRoom(page) {
  await page.goto(APP_URL);
  await expect(page.locator('#statusText')).toHaveText('Waiting for another device');
  return page.url();
}

export async function join(page, url, expectText = /Connected to|devices connected/) {
  await page.goto(url);
  await expect(page.locator('#statusText')).toHaveText(expectText);
}

export const status = (page) => page.locator('#statusText');

let tmp;
export async function tempFile(name, data) {
  tmp ||= await mkdtemp(joinPath(tmpdir(), 'qrshare-e2e-'));
  const path = joinPath(tmp, `${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  await writeFile(path, data);
  return { path, name, data };
}

export const randomData = (n) => randomBytes(n);
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Sends files from `page` via the hidden file input. Accepts {name, mimeType, buffer} or paths. */
export async function sendFiles(page, files) {
  await page.locator('#fileInput').setInputFiles(files);
}

/** Waits for the incoming offer, accepts it, and returns the batch locator. */
export async function acceptOffer(page) {
  const accept = page.locator('.batch[data-state="pending"] .batch__actions .btn--primary').first();
  await expect(accept).toBeVisible();
  await accept.click();
}

/** Clicks Save on a received file and returns the downloaded bytes. */
export async function download(page, fileName) {
  const row = page.locator('.file', { has: page.locator('.file__name', { hasText: fileName }) }).first();
  await expect(row).toHaveAttribute('data-status', 'done', { timeout: 120_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), row.locator('a[download]').click()]);
  return { bytes: await readFile(await dl.path()), suggested: dl.suggestedFilename() };
}

export function rowFor(page, fileName) {
  return page.locator('.file', { has: page.locator('.file__name', { hasText: fileName }) }).first();
}
