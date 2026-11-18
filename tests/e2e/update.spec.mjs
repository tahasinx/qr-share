/**
 * App updates via the service worker. Each test runs its own copy of the site on a separate port
 * (a separate origin, so its service worker can't affect other tests) and "deploys" a new version
 * by changing the VERSION that server returns in sw.js.
 */
import { test, expect } from '@playwright/test';
import { startServer } from '../../scripts/serve.mjs';
import { device, join, status } from './helpers.mjs';

async function site(port) {
  const state = { version: null };
  const server = await startServer(port, {
    transform: (rel, body) => (rel === 'sw.js' && state.version
      ? String(body).replace(/const VERSION = '[^']+';/, `const VERSION = '${state.version}';`)
      : body),
  });
  return {
    url: `http://localhost:${port}/qr-share/`,
    deploy: (version) => { state.version = version; },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Opens a new room and loads it again so a service worker controls the page. */
async function controlledRoom(page, baseUrl) {
  await page.goto(baseUrl);
  await expect(status(page)).toHaveText('Waiting for another device');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(status(page)).toHaveText('Waiting for another device');
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  return page.url();
}

/** page.evaluate that tolerates the page reloading underneath it (returns null meanwhile). */
const read = (page, fn) => page.evaluate(fn).catch(() => null);
const caches = (page) => read(page, async () => (await self.caches.keys()).filter((k) => k.startsWith('qrshare-')));
const checkForUpdate = (page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());

test.describe('updates', () => {
  test('an idle tab picks up a new version by itself, staying in the same room', async ({ browser }) => {
    const s = await site(8191);
    try {
      const a = await device(browser);
      const url = await controlledRoom(a, s.url);
      s.deploy('qrshare-test-next');
      await a.evaluate(() => { window.__beforeUpdate = true; });
      await checkForUpdate(a);
      // Seamless reload: marker gone, same room URL, only the new cache remains.
      await expect.poll(() => read(a, () => window.__beforeUpdate === undefined)).toBe(true);
      expect(a.url()).toBe(url);
      await expect(status(a)).toHaveText('Waiting for another device');
      await expect.poll(() => caches(a)).toEqual(['qrshare-test-next']);
    } finally { await s.close(); }
  });

  test('a busy tab is never reloaded; an update waiting at page load is still applied', async ({ browser }) => {
    const s = await site(8192);
    try {
      // Tab A is connected to a peer, so it prompts instead of reloading.
      const a = await device(browser, { name: 'Busy' });
      const url = await controlledRoom(a, s.url);
      const peer = await device(browser, { name: 'Peer' });
      await join(peer, url);
      await expect(status(a)).toHaveText('Connected to Peer');
      s.deploy('qrshare-test-next');
      await a.evaluate(() => { window.__beforeUpdate = true; });
      await checkForUpdate(a);
      await expect(a.locator('.toast__title', { hasText: 'A new version of QRShare is ready' })).toBeVisible();

      // A second, idle tab opens while the update is already waiting: it applies it on load.
      const c = await a.context().newPage();
      await c.goto(s.url);
      await expect.poll(() => caches(c)).toEqual(['qrshare-test-next']);

      // The busy tab kept running: not reloaded, still connected.
      expect(await a.evaluate(() => window.__beforeUpdate)).toBe(true);
      await expect(status(a)).toHaveText('Connected to Peer');
    } finally { await s.close(); }
  });
});
