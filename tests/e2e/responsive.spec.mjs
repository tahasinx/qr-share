/**
 * Every dialog, at every common screen size: centred, fully on screen, no sideways overflow.
 * Guards against CSS ordering mistakes where a later rule silently overrides a responsive one.
 */
import { test, expect } from '@playwright/test';
import { device, createRoom, join, status } from './helpers.mjs';

const VIEWPORTS = {
  'phone-320': { width: 320, height: 640 },
  'phone-360': { width: 360, height: 740 },
  'phone-390': { width: 390, height: 844 },
  'phone-430': { width: 430, height: 932 },
  'phone-landscape': { width: 844, height: 390 },
  'tablet': { width: 820, height: 1180 },
  'laptop': { width: 1280, height: 800 },
};

/** Taps a section tab only where the layout has one (phones); wider layouts show every panel. */
async function showTab(page, name) {
  const tab = page.locator(`.tab[data-tab="${name}"]`);
  if (await tab.isVisible()) await tab.click();
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Opens an item from the phone "More" menu, or uses the desktop control when it's visible. */
async function viaMoreOr(page, desktopLocator, menuItem) {
  if (await desktopLocator.isVisible()) return desktopLocator.click();
  await page.locator('#moreBtn').click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: menuItem }).click();
  await expect(page.getByRole('dialog', { name: 'More' })).toHaveCount(0);
}

const DIALOGS = {
  'Join a room': (p) => p.locator('#joinBtn').click(),
  'Scan to join': async (p) => { await showTab(p, 'room'); await p.locator('#qrButton').click(); },
  'How QRShare works': (p) => viaMoreOr(p, p.locator('#helpBtn'), 'How it works'),
  'Rename this device': (p) => viaMoreOr(p, p.locator('.person--self button'), 'Rename this device'),
  'Connection details': (p) => p.locator('#statusPill').click(),
  'Install QRShare': (p) => p.locator('#installBtn').click(),
  'Verify Peer': async (p) => { await showTab(p, 'room'); await p.getByRole('button', { name: 'Verify connection with Peer' }).click(); },
  'tiny.png': async (p) => { await showTab(p, 'files'); await p.getByRole('button', { name: 'Preview tiny.png' }).click(); },
};

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  test(`dialogs are centred and fit: ${vpName}`, async ({ browser }) => {
    const mobile = viewport.width < 760;
    const a = await device(browser, { name: 'Me', viewport, isMobile: mobile, hasTouch: mobile });
    const url = await createRoom(a);
    const peer = await device(browser, { name: 'Peer' });
    await join(peer, url);
    await expect(status(a)).toHaveText('Connected to Peer');
    // Receive an image so the preview dialog exists.
    await peer.locator('#fileInput').setInputFiles([{ name: 'tiny.png', mimeType: 'image/png', buffer: PNG }]);
    await showTab(a, 'files');
    await a.locator('.batch[data-state="pending"] .btn--primary').click();
    await expect(a.locator('.file[data-status="done"]')).toHaveCount(1);

    const problems = [];
    for (const [title, open] of Object.entries(DIALOGS)) {
      await open(a);
      const dialog = a.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      await a.waitForTimeout(450); // let the entrance animation finish before measuring
      const m = await dialog.evaluate((d) => {
        const r = d.getBoundingClientRect();
        const body = d.querySelector('.dialog__body');
        return {
          left: r.left, right: innerWidth - r.right, top: r.top, bottom: innerHeight - r.bottom,
          overflowX: Math.max(d.scrollWidth - d.clientWidth, body ? body.scrollWidth - body.clientWidth : 0),
        };
      });
      if (Math.abs(m.left - m.right) > 1) problems.push(`${title}: not centred (left ${m.left.toFixed(0)}px, right ${m.right.toFixed(0)}px)`);
      if (m.left < -1 || m.right < -1 || m.top < -1 || m.bottom < -1) problems.push(`${title}: extends off screen ${JSON.stringify(m)}`);
      if (m.overflowX > 1) problems.push(`${title}: content overflows sideways by ${m.overflowX}px`);
      await a.keyboard.press('Escape');
      await expect(a.getByRole('dialog')).toHaveCount(0);
    }
    expect(problems).toEqual([]);
  });
}

test('short landscape phones use the slim side-by-side tab bar', async ({ browser }) => {
  const a = await device(browser, { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  await createRoom(a);
  const tab = a.locator('.tab[data-tab="files"]');
  expect(await tab.evaluate((t) => getComputedStyle(t).flexDirection)).toBe('row');
  expect((await tab.boundingBox()).height).toBeLessThanOrEqual(46);
});

test('active tab highlight surrounds both icon and label', async ({ browser }) => {
  const a = await device(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await createRoom(a);
  await a.locator('.tab[data-tab="files"]').click();
  const fits = await a.locator('.tab[data-tab="files"]').evaluate((t) => {
    const tr = t.getBoundingClientRect();
    const pill = getComputedStyle(t, '::before');
    const pr = { top: tr.top + parseFloat(pill.top), bottom: tr.bottom - parseFloat(pill.bottom) };
    const label = t.querySelector('span:not(.badge):not([data-icon])');
    const icon = t.querySelector('svg');
    const lr = [...t.children].filter((c) => c !== label?.parentElement).map((c) => c.getBoundingClientRect());
    return [icon, ...t.querySelectorAll('span:not(.badge)')].every((el) => {
      const r = el.getBoundingClientRect(); return !r.height || (r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5);
    }) && lr.length > 0;
  });
  expect(fits).toBe(true);
});
