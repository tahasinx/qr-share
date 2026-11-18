import { test, expect } from '@playwright/test';
import { device, createRoom } from './helpers.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

/** Init script: a stand-in for Chromium's beforeinstallprompt, recording what the app does with it. */
const FAKE_PROMPT = `
  window.__fireInstallPrompt = (outcome) => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; return Promise.resolve(); };
    e.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(e);
  };`;

test.describe('install app', () => {
  test('without a browser prompt, the button opens desktop instructions', async ({ browser }) => {
    const a = await device(browser);
    await createRoom(a);
    await a.getByRole('button', { name: 'Install QRShare as an app' }).click();
    const dialog = a.getByRole('dialog', { name: 'Install QRShare' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Install page as app');
    await dialog.getByRole('button', { name: 'Got it' }).click();
    await expect(dialog).toBeHidden();
  });

  test('iPhone Safari gets Add to Home Screen steps in a bottom sheet', async ({ browser }) => {
    const a = await device(browser, { viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, hasTouch: true, isMobile: true });
    await createRoom(a);
    await a.getByRole('button', { name: 'Install QRShare as an app' }).click();
    const dialog = a.getByRole('dialog', { name: 'Install QRShare' });
    await expect(dialog).toContainText('Add to Home Screen');
    await expect(dialog.locator('.install-steps li')).toHaveCount(3);
    // Anchored to the bottom of the screen (drawer) on phones.
    await expect.poll(async () => { const b = await dialog.boundingBox(); return Math.round(b.y + b.height); }).toBe(844);
  });

  test('uses the browser install prompt when offered, then hides the button once installed', async ({ browser }) => {
    const a = await device(browser, { config: FAKE_PROMPT });
    await createRoom(a);
    const btn = a.getByRole('button', { name: 'Install QRShare as an app' });
    await a.evaluate(() => window.__fireInstallPrompt('accepted'));
    await btn.click();
    expect(await a.evaluate(() => window.__prompted)).toBe(1);
    await expect(a.getByRole('dialog')).toHaveCount(0); // native prompt, not instructions
    await a.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect(btn).toBeHidden();
    await expect(a.locator('.toast__title', { hasText: 'QRShare installed' })).toBeVisible();
    await a.reload();
    await expect(a.locator('#statusText')).toHaveText('Waiting for another device');
    await expect(btn).toBeHidden(); // remembered in this browser
    // If the browser offers installation again (app was uninstalled), the button returns.
    await a.evaluate(() => window.__fireInstallPrompt('dismissed'));
    await expect(btn).toBeVisible();
  });

  test('hidden when already running as an installed app', async ({ browser }) => {
    const standalone = `
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => real(q.includes('display-mode: standalone') ? '(min-width: 0px)' : q);`;
    const a = await device(browser, { config: standalone });
    await createRoom(a);
    await expect(a.locator('#installBtn')).toBeHidden();
  });
});
