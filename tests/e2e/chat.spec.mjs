import { test, expect } from '@playwright/test';
import { device, createRoom, join, status } from './helpers.mjs';

test.describe('chat', () => {
  test('messages, receipts, grouping, safe rendering and links', async ({ browser }) => {
    const a = await device(browser, { name: 'Ana' });
    const url = await createRoom(a);
    await expect(a.locator('#chatInput')).toBeDisabled();
    const b = await device(browser, { name: 'Ben' });
    await join(b, url);
    await expect(a.locator('#chatInput')).toBeEnabled();
    await expect(a.locator('#chatInput')).toHaveAttribute('placeholder', 'Message Ben');

    await a.locator('#chatInput').fill('first');
    await a.keyboard.press('Enter');
    await a.locator('#chatInput').fill('second\nline two');
    await a.locator('#sendBtn').click();
    await expect(b.locator('.msg--theirs')).toHaveCount(2);
    await expect(b.locator('.msg--theirs.is-first')).toHaveCount(1); // grouped under one author label
    await expect(b.locator('.msg__author > span:not(.avatar)')).toHaveText('Ana');
    await expect(a.locator('.msg--mine').last().locator('.msg__meta')).toContainText('Delivered');

    // Hostile content is rendered as text.
    await b.locator('#chatInput').fill('<img src=x onerror="window.__pwned=1"> visit https://example.com/path?q=1 now');
    await b.keyboard.press('Enter');
    const msg = a.locator('.msg--theirs').last();
    await expect(msg).toContainText('<img src=x');
    expect(await msg.locator('img').count()).toBe(0);
    expect(await a.evaluate(() => window.__pwned)).toBeUndefined();
    const link = msg.locator('a');
    await expect(link).toHaveAttribute('href', 'https://example.com/path?q=1');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');

    // javascript: URLs are never linked.
    await b.locator('#chatInput').fill('javascript:alert(1)');
    await b.keyboard.press('Enter');
    await expect(a.locator('.msg--theirs').last().locator('a')).toHaveCount(0);
  });

  test('copy message to clipboard', async ({ browser }) => {
    const a = await device(browser, { name: 'Ana', permissions: ['clipboard-read', 'clipboard-write'] });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Ben' });
    await join(b, url);
    await b.locator('#chatInput').fill('copy me 123');
    await b.keyboard.press('Enter');
    const m = a.locator('.msg--theirs').last();
    await m.hover();
    await m.getByRole('button', { name: 'Copy message' }).click();
    await expect(a.locator('.toast__title', { hasText: 'Message copied' })).toBeVisible();
    expect(await a.evaluate(() => navigator.clipboard.readText())).toBe('copy me 123');
  });

  test('does not yank the view while reading history', async ({ browser }) => {
    const a = await device(browser, { name: 'Reader', viewport: { width: 1360, height: 600 } });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Talker' });
    await join(b, url);
    for (let i = 0; i < 30; i++) {
      await b.locator('#chatInput').fill(`message number ${i}`);
      await b.keyboard.press('Enter');
    }
    await expect(a.locator('.msg--theirs')).toHaveCount(30);
    await a.locator('#chatLog').evaluate((el) => { el.scrollTop = 0; });
    await b.locator('#chatInput').fill('a new one');
    await b.keyboard.press('Enter');
    await expect(a.locator('#jumpBtn')).toBeVisible();
    expect(await a.locator('#chatLog').evaluate((el) => el.scrollTop)).toBeLessThan(50);
    await a.locator('#jumpBtn').click();
    await expect(a.locator('#jumpBtn')).toBeHidden();
    await expect(status(a)).toHaveText('Connected to Talker');
  });
});
