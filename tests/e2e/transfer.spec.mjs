import { test, expect } from '@playwright/test';
import {
  device, createRoom, join, sendFiles, acceptOffer, download, rowFor, tempFile, randomData, sha256, status,
} from './helpers.mjs';

async function pair(browser) {
  const a = await device(browser, { name: 'Sender' });
  const url = await createRoom(a);
  const b = await device(browser, { name: 'Receiver' });
  await join(b, url);
  await expect(status(a)).toHaveText('Connected to Receiver');
  return { a, b };
}

test.describe('file transfers', () => {
  test('single file arrives byte-for-byte and is verified on both sides', async ({ browser }) => {
    const { a, b } = await pair(browser);
    const data = randomData(3 * 1024 * 1024 + 123);
    await sendFiles(a, [{ name: 'photo-archive.bin', mimeType: 'application/octet-stream', buffer: data }]);
    await expect(rowFor(a, 'photo-archive.bin')).toHaveAttribute('data-status', 'offered');
    await expect(b.locator('.batch[data-state="pending"]')).toContainText('From Sender');
    await acceptOffer(b);
    const { bytes, suggested } = await download(b, 'photo-archive.bin');
    expect(suggested).toBe('photo-archive.bin');
    expect(sha256(bytes)).toBe(sha256(data));
    await expect(rowFor(a, 'photo-archive.bin')).toHaveAttribute('data-status', 'done');
    await expect(rowFor(a, 'photo-archive.bin').locator('.file__meta')).toHaveText(/Delivered and verified/);
    await expect(rowFor(b, 'photo-archive.bin').locator('.file__meta')).toHaveText(/Received and verified/);
    expect([...a.errors, ...b.errors]).toEqual([]);
  });

  test('batch with an empty file and duplicate names', async ({ browser }) => {
    const { a, b } = await pair(browser);
    const f1 = randomData(200_000);
    const f2 = randomData(50_000);
    await sendFiles(a, [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: f1 },
      { name: 'empty.dat', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
      { name: 'image.png', mimeType: 'image/png', buffer: f2 },
    ]);
    await expect(b.locator('.batch[data-state="pending"]')).toContainText('3 files');
    await acceptOffer(b);
    expect(sha256((await download(b, 'notes.txt')).bytes)).toBe(sha256(f1));
    expect((await download(b, 'empty.dat')).bytes.length).toBe(0);
    await expect(rowFor(b, 'image.png')).toHaveAttribute('data-status', 'done');
    await expect(b.locator('.batch__actions', { hasText: 'Save all' })).toBeVisible();

    // Same names again: the second copy gets a distinct download name.
    await sendFiles(a, [{ name: 'notes.txt', mimeType: 'text/plain', buffer: f1 }]);
    await acceptOffer(b);
    const second = b.locator('.batch').first();
    await expect(second.locator('.file')).toHaveAttribute('data-status', 'done');
    const [dl] = await Promise.all([b.waitForEvent('download'), second.locator('a[download]').click()]);
    expect(dl.suggestedFilename()).toBe('notes (2).txt');
  });

  test('declining an offer tells the sender', async ({ browser }) => {
    const { a, b } = await pair(browser);
    await sendFiles(a, [{ name: 'unwanted.zip', mimeType: 'application/zip', buffer: randomData(1000) }]);
    await b.locator('.batch[data-state="pending"]').getByRole('button', { name: 'Decline' }).click();
    await expect(rowFor(a, 'unwanted.zip').locator('.file__meta')).toHaveText(/Receiver declined/);
    await expect(rowFor(b, 'unwanted.zip').locator('.file__meta')).toHaveText(/Declined/);
  });

  test('large file: bounded-memory streaming, pause/resume, verified', async ({ browser }) => {
    const { a, b } = await pair(browser);
    const data = randomData(96 * 1024 * 1024);
    const file = await tempFile('dataset.bin', data);
    await sendFiles(a, [file.path]);
    await acceptOffer(b);
    const recv = rowFor(b, 'dataset.bin');
    await expect(recv).toHaveAttribute('data-status', 'active');
    // Pause from the receiver; sender reflects it.
    await recv.getByRole('button', { name: /Pause/ }).click();
    await expect(rowFor(a, 'dataset.bin').locator('.file__meta')).toContainText('Paused by Receiver');
    await expect(recv.locator('.file__meta')).toContainText('Paused by you');
    const pausedAt = await b.evaluate(() => [...window.__qrshare.transfers.transfers.values()][0].bytes);
    await b.waitForTimeout(800);
    const stillAt = await b.evaluate(() => [...window.__qrshare.transfers.transfers.values()][0].bytes);
    expect(stillAt - pausedAt).toBeLessThanOrEqual(8 * 1024 * 1024); // only in-flight buffer drains
    await recv.getByRole('button', { name: /Resume/ }).click();
    const t0 = Date.now();
    const { bytes } = await download(b, 'dataset.bin');
    const secs = (Date.now() - t0) / 1000;
    expect(sha256(bytes)).toBe(sha256(data));
    await expect(rowFor(a, 'dataset.bin')).toHaveAttribute('data-status', 'done');
    test.info().annotations.push({ type: 'throughput', description: `${(96 / secs).toFixed(1)} MB/s after resume (localhost)` });
  });

  test('cancelling mid-transfer stops both sides; sender can retry', async ({ browser }) => {
    const { a, b } = await pair(browser);
    const data = randomData(64 * 1024 * 1024);
    const file = await tempFile('video.mov', data);
    await sendFiles(a, [file.path]);
    await acceptOffer(b);
    await expect(rowFor(a, 'video.mov')).toHaveAttribute('data-status', 'active');
    await rowFor(a, 'video.mov').getByRole('button', { name: /Cancel/ }).click();
    await expect(rowFor(b, 'video.mov')).toHaveAttribute('data-status', 'cancelled');
    await expect(rowFor(b, 'video.mov').locator('.file__meta')).toContainText('Cancelled by Sender');
    await expect(rowFor(a, 'video.mov')).toHaveAttribute('data-status', 'cancelled');
    // Retry creates a fresh offer that completes.
    await rowFor(a, 'video.mov').getByRole('button', { name: /Retry/ }).click();
    await acceptOffer(b);
    const done = b.locator('.batch').first();
    await expect(done.locator('.file')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  });

  test('receiver leaving mid-transfer fails the sender cleanly', async ({ browser }) => {
    const { a, b } = await pair(browser);
    const file = await tempFile('big.iso', randomData(64 * 1024 * 1024));
    await sendFiles(a, [file.path]);
    await acceptOffer(b);
    await expect(rowFor(a, 'big.iso')).toHaveAttribute('data-status', 'active');
    await b.close();
    await expect(rowFor(a, 'big.iso')).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
    await expect(rowFor(a, 'big.iso').locator('.file__meta')).toContainText(/left the room|interrupted|Connection lost/);
  });

  test('files chosen before anyone joins are offered to the first device', async ({ browser }) => {
    const a = await device(browser, { name: 'Early' });
    const url = await createRoom(a);
    const data = randomData(10_000);
    await sendFiles(a, [{ name: 'ready.pdf', mimeType: 'application/pdf', buffer: data }]);
    await expect(a.locator('#staged')).toContainText('1 file ready');
    const b = await device(browser, { name: 'Late' });
    await join(b, url);
    await acceptOffer(b);
    expect(sha256((await download(b, 'ready.pdf')).bytes)).toBe(sha256(data));
    await expect(a.locator('#staged')).toBeHidden();
  });

  test('one offer to two devices is tracked per recipient', async ({ browser }) => {
    const a = await device(browser, { name: 'Hub' });
    const url = await createRoom(a);
    const b = await device(browser, { name: 'One' });
    await join(b, url);
    const c = await device(browser, { name: 'Two' });
    await join(c, url, '2 devices connected');
    const data = randomData(500_000);
    await sendFiles(a, [{ name: 'shared.key', mimeType: 'application/octet-stream', buffer: data }]);
    await acceptOffer(b);
    await c.locator('.batch[data-state="pending"]').getByRole('button', { name: 'Decline' }).click();
    expect(sha256((await download(b, 'shared.key')).bytes)).toBe(sha256(data));
    await expect(a.locator('.batch', { hasText: 'One' }).locator('.file')).toHaveAttribute('data-status', 'done');
    await expect(a.locator('.batch', { hasText: 'Two' }).locator('.file')).toHaveAttribute('data-status', 'declined');
  });

  test('hostile file names are neutralised and shown as text', async ({ browser }) => {
    const { a, b } = await pair(browser);
    const evil = '<img src=x onerror="window.__pwned=1">‮gpj.exe';
    await sendFiles(a, [{ name: evil, mimeType: 'text/html', buffer: Buffer.from('<script>window.__pwned=1</script>') }]);
    await acceptOffer(b);
    const row = b.locator('.batch').first().locator('.file');
    await expect(row).toHaveAttribute('data-status', 'done');
    const name = await row.locator('.file__name').textContent();
    expect(name).not.toContain('‮');
    expect(name).not.toMatch(/[<>"]/);
    expect(await b.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await b.locator('.file__name img').count()).toBe(0);
    await expect(row.locator('.file__warn')).toContainText('Program or script');
    // Non-image content is stored as opaque bytes, never as text/html in our origin.
    expect(await b.evaluate(() => [...window.__qrshare.transfers.transfers.values()][0].blob.type)).toBe('application/octet-stream');
  });
});
