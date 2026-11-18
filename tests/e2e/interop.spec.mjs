/**
 * Cross-engine interop: a Chromium device and a Firefox device in the same room.
 * Runs only when Playwright's Firefox is installed (`npx playwright install firefox`).
 */
import { test, expect, firefox } from '@playwright/test';
import { device, createRoom, sendFiles, acceptOffer, download, rowFor, tempFile, randomData, sha256, status } from './helpers.mjs';
import { LOCAL_CONFIG } from './servers.mjs';

let ff;
test.beforeAll(async () => {
  try { ff = await firefox.launch(); } catch { ff = null; }
});
test.afterAll(async () => { await ff?.close(); });

async function firefoxDevice(name) {
  const ctx = await ff.newContext({ bypassCSP: true, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(LOCAL_CONFIG + `try { localStorage.setItem('qrshare:name', ${JSON.stringify(name)}); } catch {}`);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}

test('Chromium ⇄ Firefox: connect, chat and transfer both ways with verification', async ({ browser }) => {
  test.skip(!ff, 'Playwright Firefox not installed');
  const chrome = await device(browser, { name: 'Chrome box' });
  const url = await createRoom(chrome);
  const fox = await firefoxDevice('Firefox box');
  await fox.goto(url);
  await expect(status(fox)).toHaveText('Connected to Chrome box');
  await expect(status(chrome)).toHaveText('Connected to Firefox box');

  await fox.locator('#chatInput').fill('hello from gecko');
  await fox.keyboard.press('Enter');
  await expect(chrome.locator('.msg--theirs .msg__text')).toHaveText('hello from gecko');
  await expect(fox.locator('.msg--mine .msg__meta')).toContainText('Delivered');

  const big = randomData(24 * 1024 * 1024);
  const f1 = await tempFile('chrome-to-fox.bin', big);
  await sendFiles(chrome, [f1.path]);
  await acceptOffer(fox);
  expect(sha256((await download(fox, 'chrome-to-fox.bin')).bytes)).toBe(sha256(big));
  await expect(rowFor(chrome, 'chrome-to-fox.bin')).toHaveAttribute('data-status', 'done');

  const small = randomData(5 * 1024 * 1024 + 7);
  await sendFiles(fox, [{ name: 'fox-to-chrome.bin', mimeType: 'application/octet-stream', buffer: small }]);
  await acceptOffer(chrome);
  expect(sha256((await download(chrome, 'fox-to-chrome.bin')).bytes)).toBe(sha256(small));
  await expect(rowFor(fox, 'fox-to-chrome.bin')).toHaveAttribute('data-status', 'done');
  expect(fox.errors).toEqual([]);
});
