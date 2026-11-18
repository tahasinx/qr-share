import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { device, createRoom, join, status, sendFiles, APP_URL } from './helpers.mjs';

const SHOTS = process.env.QRSHARE_SHOTS; // optional: directory to save review screenshots

const VIEWPORTS = {
  'phone-small': { width: 320, height: 640 },
  'phone': { width: 390, height: 844 },
  'phone-landscape': { width: 844, height: 390 },
  'tablet': { width: 820, height: 1180 },
  'laptop': { width: 1280, height: 800 },
  'desktop-xl': { width: 1920, height: 1080 },
};

test.describe('layout & accessibility', () => {
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`no horizontal overflow, core controls reachable: ${name}`, async ({ browser }) => {
      const a = await device(browser, { name: 'A very long device name here', viewport });
      const url = await createRoom(a);
      const b = await device(browser, { name: 'Peer with an exceptionally long name' });
      await join(b, url);
      await expect(status(a)).toContainText('Connected');
      await sendFiles(b, [{ name: `${'very-long-file-name-'.repeat(8)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') }]);
      if (viewport.width < 760) await a.locator('.tab[data-tab="files"]').click();
      await expect(a.locator('.batch[data-state="pending"]')).toBeVisible();
      const overflow = await a.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return [...document.querySelectorAll('body *')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width && el.checkVisibility() && (r.right > vw + 1 || r.left < -1); })
          .filter((el) => !el.closest('.toasts'))
          .map((el) => `${el.tagName}.${el.className}`);
      });
      expect(overflow).toEqual([]);
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (SHOTS) await a.screenshot({ path: `${SHOTS}/${name}-files.png` });
      if (viewport.width < 760) {
        await a.locator('.tab[data-tab="room"]').click();
        await expect(a.locator('#qrButton')).toBeVisible();
        if (SHOTS) await a.screenshot({ path: `${SHOTS}/${name}-room.png` });
        await a.locator('.tab[data-tab="chat"]').click();
        await expect(a.locator('#chatInput')).toBeVisible();
      }
    });
  }

  test('axe: no serious accessibility violations (light & dark)', async ({ browser }) => {
    const a = await device(browser, { name: 'Axe' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Peer' });
    await join(b, url);
    await b.locator('#chatInput').fill('hello');
    await b.keyboard.press('Enter');
    await sendFiles(b, [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
    await expect(a.locator('.batch')).toBeVisible();
    for (const scheme of ['light', 'dark']) {
      await a.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await a.waitForTimeout(100);
      const results = await new AxeBuilder({ page: a }).exclude('.toasts').analyze();
      const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
      expect(serious.map((v) => `${scheme}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    }
  });

  test('keyboard: dialogs trap focus and restore it; Esc closes', async ({ browser }) => {
    const a = await device(browser);
    await createRoom(a);
    await a.locator('#joinBtn').focus();
    await a.keyboard.press('Enter');
    await expect(a.locator('dialog[open]')).toBeVisible();
    await expect(a.locator('#joinCode')).toBeFocused();
    await a.keyboard.press('Escape');
    await expect(a.locator('dialog')).toHaveCount(0);
    await expect(a.locator('#joinBtn')).toBeFocused();
  });

  test('theme toggle cycles and persists', async ({ browser }) => {
    const a = await device(browser);
    await createRoom(a);
    await a.locator('#themeBtn').click();
    expect(await a.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await a.locator('#themeBtn').click();
    expect(await a.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await a.reload();
    expect(await a.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  });

  test('copy link, QR enlarge and QR download', async ({ browser }) => {
    const a = await device(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    const url = await createRoom(a);
    await a.locator('#copyLinkBtn').click();
    expect(await a.evaluate(() => navigator.clipboard.readText())).toBe(url);
    expect(url).toMatch(/\/qr-share\/#[A-Z0-9]{10}$/);
    // The test server runs on localhost, so the "other devices can't open this" warning shows.
    await expect(a.locator('#localWarn')).toBeVisible();
    await a.locator('#qrButton').click();
    await expect(a.locator('.qr-large svg')).toBeVisible();
    await a.keyboard.press('Escape');
    const [dl] = await Promise.all([a.waitForEvent('download'), a.locator('#saveQrBtn').click()]);
    expect(dl.suggestedFilename()).toMatch(/^qrshare-[A-Z0-9]{10}\.png$/);
  });

  test('offline: the app shell loads from the service worker and explains the problem', async ({ browser }) => {
    const a = await device(browser);
    await createRoom(a);
    await a.evaluate(() => navigator.serviceWorker.ready);
    await a.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('qrshare-')));
    await a.context().setOffline(true);
    await a.reload();
    await expect(a.locator('.brand__name')).toHaveText('QRShare');
    await expect(a.locator('#screenTitle')).toHaveText('Couldn’t reach the connection service', { timeout: 30_000 });
    await a.context().setOffline(false);
    await a.getByRole('button', { name: 'Try again' }).click();
    await expect(status(a)).toHaveText('Waiting for another device');
  });

    test('all assets load from the sub-path with no failed requests', async ({ browser }) => {
    const a = await device(browser);
    const failed = [];
    a.on('requestfailed', (r) => failed.push(r.url()));
    a.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    await a.goto(APP_URL);
    await expect(status(a)).toHaveText('Waiting for another device');
    await a.waitForLoadState('networkidle');
    expect(failed).toEqual([]);
    expect(a.errors).toEqual([]);
    const fontOk = await a.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px "Schibsted Grotesk"'); });
    expect(fontOk).toBe(true);
  });
});
