import { test, expect } from '@playwright/test';
import { device, createRoom, join, status, APP_URL } from './helpers.mjs';

test.describe('rooms & connections', () => {
  test('creates a room with a secure code, QR and link', async ({ browser }) => {
    const a = await device(browser);
    const url = await createRoom(a);
    const code = new URL(url).hash.slice(1);
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    await expect(a.locator('#roomCode')).toHaveText(`${code.slice(0, 5)}-${code.slice(5)}`);
    await expect(a.locator('#qrCode svg path')).toHaveCount(1);
    // Each visit without a code gets a new room.
    const b = await device(browser);
    const url2 = await createRoom(b);
    expect(url2).not.toBe(url);
    expect(a.errors).toEqual([]);
  });

  test('two devices connect and see each other', async ({ browser }) => {
    const a = await device(browser, { name: 'Laptop A' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Phone B' });
    await join(b, url);
    await expect(status(a)).toHaveText('Connected to Phone B');
    await expect(status(b)).toHaveText('Connected to Laptop A');
    await expect(a.locator('#peopleCount')).toHaveText('2');
    await expect(a.locator('.person__name', { hasText: 'Phone B' })).toBeVisible();
    // Route + verification code are exposed, and both ends compute the same code.
    await expect(a.locator('.person', { hasText: 'Phone B' }).locator('.person__meta')).toContainText(/Direct/);
    await a.locator('.person', { hasText: 'Phone B' }).getByRole('button', { name: /Verify/ }).click();
    const codeA = await a.locator('.safety-code').textContent();
    await b.locator('.person', { hasText: 'Laptop A' }).getByRole('button', { name: /Verify/ }).click();
    await expect(b.locator('.safety-code')).toHaveText(codeA);
    expect(codeA).toMatch(/^\d{4} \d{4} \d{4}$/);
    expect([...a.errors, ...b.errors]).toEqual([]);
  });

  test('three devices form a full mesh; chat reaches everyone', async ({ browser }) => {
    const a = await device(browser, { name: 'Alpha' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Bravo' });
    await join(b, url);
    const c = await device(browser, { name: 'Charlie' });
    await join(c, url, '2 devices connected');
    for (const p of [a, b, c]) await expect(status(p)).toHaveText('2 devices connected');
    for (const p of [a, b, c]) await expect(p.locator('#peopleCount')).toHaveText('3');
    await c.locator('#chatInput').fill('hello mesh');
    await c.keyboard.press('Enter');
    await expect(a.locator('.msg--theirs .msg__text', { hasText: 'hello mesh' })).toBeVisible();
    await expect(b.locator('.msg--theirs .msg__text', { hasText: 'hello mesh' })).toBeVisible();
    await expect(c.locator('.msg--mine .msg__meta')).toContainText('Delivered');
  });

  test('room survives the creator leaving; newcomers still join', async ({ browser }) => {
    const a = await device(browser, { name: 'Keeper' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Bravo' });
    await join(b, url);
    const c = await device(browser, { name: 'Charlie' });
    await join(c, url, '2 devices connected');

    await a.locator('#leaveBtn').click();
    await expect(a.locator('#screenTitle')).toHaveText('You left the room');
    await expect(status(b)).toHaveText('Connected to Charlie');
    await expect(status(c)).toHaveText('Connected to Bravo');

    // Someone new arrives with the same link and is introduced to both survivors.
    const d = await device(browser, { name: 'Delta' });
    await join(d, url, '2 devices connected');
    await expect(status(b)).toHaveText('2 devices connected');
    await expect(status(c)).toHaveText('2 devices connected');
  });

  test('a peer closing the tab is removed promptly', async ({ browser }) => {
    const a = await device(browser, { name: 'Stay' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Go' });
    await join(b, url);
    await b.close();
    await expect(status(a)).toHaveText('Waiting for another device', { timeout: 30_000 });
    await expect(a.locator('#peopleCount')).toHaveText('1');
    await expect(a.locator('.msg-system', { hasText: /Go (left|disconnected)/ })).toBeVisible();
  });

  test('reloading a device reconnects without leaving a ghost participant', async ({ browser }) => {
    const a = await device(browser, { name: 'Host' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Reloader' });
    await join(b, url);
    await b.reload();
    await expect(status(b)).toHaveText('Connected to Host');
    await expect(status(a)).toHaveText('Connected to Reloader');
    await expect(a.locator('#peopleCount')).toHaveText('2');
  });

  test('a device cannot evict another by claiming its device key', async ({ browser }) => {
    const sameKey = "try { sessionStorage.setItem('qrshare:key', 'shared-victim-key'); } catch {}";
    const a = await device(browser, { name: 'Observer' });
    const url = await createRoom(a);
    const victim = await device(browser, { name: 'Victim', config: sameKey });
    await join(victim, url);
    const attacker = await device(browser, { name: 'Attacker', config: sameKey });
    await join(attacker, url, '2 devices connected');
    await a.waitForTimeout(4500); // longer than the liveness probe window
    await expect(status(a)).toHaveText('2 devices connected');
    await expect(a.locator('.person__name', { hasText: 'Victim' })).toBeVisible();
  });

    test('rejoining a room after the creator reloads works (creator becomes a member)', async ({ browser }) => {
    const a = await device(browser, { name: 'Creator' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'Guest' });
    await join(b, url);
    await a.reload();
    await expect(status(a)).toHaveText('Connected to Guest');
    await expect(status(b)).toHaveText('Connected to Creator');
  });

  test('invalid and legacy room links show a recovery screen', async ({ browser }) => {
    const a = await device(browser);
    await a.goto(`${APP_URL}#NOT-A-ROOM`);
    await expect(a.locator('#screenTitle')).toHaveText('This room link doesn’t work');
    await a.getByRole('button', { name: 'Start a new room' }).click();
    await expect(status(a)).toHaveText('Waiting for another device');
    await a.goto(`${APP_URL}?room=abc123`);
    await expect(a.locator('#screenTitle')).toHaveText('This room link doesn’t work');
  });

  test('opening a link to an empty room explains the situation', async ({ browser }) => {
    const a = await device(browser);
    await a.goto(`${APP_URL}#ABCDEFGHJK`);
    await expect(status(a)).toHaveText('Waiting for another device');
    await expect(a.locator('#roomHint')).toContainText('No one else is here right now');
  });

  test('joining by typed code switches rooms', async ({ browser }) => {
    const a = await device(browser, { name: 'Source' });
    const url = await createRoom(a);
    const code = new URL(url).hash.slice(1);
    const b = await device(browser, { name: 'Typist' });
    await createRoom(b);
    await b.getByRole('button', { name: 'Join a room' }).click();
    await b.locator('#joinCode').fill('nope');
    await b.getByRole('button', { name: 'Join room' }).click();
    await expect(b.locator('#joinError')).toContainText('doesn’t look like a QRShare code');
    await b.locator('#joinCode').fill(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`);
    await b.getByRole('button', { name: 'Join room' }).click();
    await expect(status(b)).toHaveText('Connected to Source');
    expect(new URL(b.url()).hash).toBe(`#${code}`);
  });

  test('a full room turns newcomers away with an explanation', async ({ browser }) => {
    const cfg = 'window.QRSHARE_CONFIG.maxPeers = 2;';
    const a = await device(browser, { config: cfg });
    const url = await createRoom(a);
    const b = await device(browser, { config: cfg });
    await join(b, url);
    const c = await device(browser, { config: cfg });
    await c.goto(url);
    await expect(c.locator('#screenTitle')).toHaveText('This room is full');
  });

  test('blocked signaling shows actionable recovery instead of hanging', async ({ browser }) => {
    // Without bypassCSP our own Content-Security-Policy blocks the local signaling server,
    // exactly like a firewall silently dropping the WebSocket.
    const a = await device(browser, { bypassCSP: false });
    await a.goto(APP_URL);
    await expect(a.locator('#screenTitle')).toHaveText('Couldn’t reach the connection service', { timeout: 25_000 });
    await expect(a.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

    test('renaming propagates to peers', async ({ browser }) => {
    const a = await device(browser, { name: 'Old Name' });
    const url = await createRoom(a);
    const b = await device(browser);
    await join(b, url);
    await a.getByRole('button', { name: 'Rename this device' }).first().click();
    await a.locator('#renameInput').fill('Studio Mac');
    await a.getByRole('button', { name: 'Save name' }).click();
    await expect(status(b)).toHaveText('Connected to Studio Mac');
  });
});
