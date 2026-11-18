import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto;
const util = await import('../../assets/js/util.js');

test('room codes are 10 chars from the unambiguous alphabet and parse back', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = util.newRoomCode();
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    assert.equal(util.parseRoomCode(code), code);
    seen.add(code);
  }
  assert.equal(seen.size, 2000);
});

test('parseRoomCode accepts formatted, lowercase and full links; rejects junk', () => {
  assert.equal(util.parseRoomCode('k7qm3-xrpwa'), 'K7QM3XRPWA');
  assert.equal(util.parseRoomCode(' K7QM3 XRPWA '), 'K7QM3XRPWA');
  assert.equal(util.parseRoomCode('https://tahasinx.github.io/qr-share/#K7QM3XRPWA'), 'K7QM3XRPWA');
  assert.equal(util.parseRoomCode('https://x.test/?room=K7QM3XRPWA'), 'K7QM3XRPWA');
  for (const bad of ['', 'K7QM3', 'K7QM3XRPWO', 'K7QM3XRPW1', 'javascript:alert(1)', 'K7QM3XRPWAA', null]) {
    assert.equal(util.parseRoomCode(bad), null, String(bad));
  }
});

test('isLocalOnlyHost flags addresses other devices cannot open', () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.20.1.1', '[::1]', 'mypc.local', '169.254.3.4']) {
    assert.equal(util.isLocalOnlyHost(h), true, h);
  }
  for (const h of ['tahasinx.github.io', 'qrshare-alpha.vercel.app', '8.8.8.8', '172.32.0.1']) {
    assert.equal(util.isLocalOnlyHost(h), false, h);
  }
});

test('sanitizeFileName strips spoofing characters, separators and edge dots', () => {
  assert.equal(util.sanitizeFileName('report‮fdp.exe'), 'reportfdp.exe');
  assert.equal(util.sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(util.sanitizeFileName('a\u0000b​c.txt'), 'abc.txt');
  assert.equal(util.sanitizeFileName('...'), 'file');
  assert.equal(util.sanitizeFileName('name. '), 'name');
  assert.equal(util.sanitizeFileName('<b>x</b>.html'), '_b_x__b_.html');
  const long = util.sanitizeFileName('a'.repeat(400) + '.tar.gz');
  assert.ok(long.length <= 180 && long.endsWith('.gz'));
});

test('uniqueName de-duplicates within a session', () => {
  const taken = new Set();
  assert.equal(util.uniqueName('a.txt', taken), 'a.txt');
  assert.equal(util.uniqueName('a.txt', taken), 'a (2).txt');
  assert.equal(util.uniqueName('a.txt', taken), 'a (3).txt');
  assert.equal(util.uniqueName('README', taken), 'README');
  assert.equal(util.uniqueName('README', taken), 'README (2)');
});

test('formatting helpers', () => {
  assert.equal(util.formatBytes(0), '0 B');
  assert.equal(util.formatBytes(1500), '1.50 KB');
  assert.equal(util.formatBytes(25_300_000), '25.3 MB');
  assert.equal(util.formatBytes(4.2e9), '4.20 GB');
  assert.equal(util.formatDuration(42.2), '43 s');
  assert.equal(util.formatDuration(125), '2 min 5 s');
  assert.equal(util.formatRoomCode('K7QM3XRPWA'), 'K7QM3-XRPWA');
});

test('mime and preview guards', () => {
  assert.equal(util.sanitizeMime('image/png'), 'image/png');
  assert.equal(util.sanitizeMime('text/html; charset=utf-8'), '');
  assert.equal(util.isPreviewableType('image/svg+xml'), false);
  assert.equal(util.isPreviewableType('image/jpeg'), true);
  assert.equal(util.isExecutableName('setup.EXE'), true);
  assert.equal(util.isExecutableName('photo.jpg'), false);
  assert.equal(util.fileKind('x.mp4'), 'video');
});

test('display names are cleaned and bounded', () => {
  assert.equal(util.sanitizeDisplayName('  Bob‮  the\n builder '), 'Bob the builder');
  assert.equal(util.sanitizeDisplayName('x'.repeat(100)).length, 32);
});
