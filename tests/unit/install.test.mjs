import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectPlatform, installGuide } = await import('../../assets/js/install.js');

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
};

test('detectPlatform recognises common devices and browsers', () => {
  assert.deepEqual(detectPlatform(UA.iphoneSafari, 5), { os: 'ios', browser: 'safari' });
  assert.deepEqual(detectPlatform(UA.iphoneChrome, 5), { os: 'ios', browser: 'chrome' });
  assert.deepEqual(detectPlatform(UA.iphoneInstagram, 5), { os: 'ios', browser: 'inapp' });
  assert.deepEqual(detectPlatform(UA.ipadSafari, 5), { os: 'ios', browser: 'safari' }); // iPadOS reports a Mac UA
  assert.deepEqual(detectPlatform(UA.macSafari, 0), { os: 'mac', browser: 'safari' });
  assert.deepEqual(detectPlatform(UA.androidChrome, 5), { os: 'android', browser: 'chrome' });
  assert.deepEqual(detectPlatform(UA.androidSamsung, 5), { os: 'android', browser: 'samsung' });
  assert.deepEqual(detectPlatform(UA.androidFirefox, 5), { os: 'android', browser: 'firefox' });
  assert.deepEqual(detectPlatform(UA.androidWebView, 5), { os: 'android', browser: 'inapp' });
  assert.deepEqual(detectPlatform(UA.macChrome, 0), { os: 'mac', browser: 'chrome' });
  assert.deepEqual(detectPlatform(UA.winEdge, 0), { os: 'windows', browser: 'edge' });
  assert.deepEqual(detectPlatform(UA.winFirefox, 0), { os: 'windows', browser: 'firefox' });
});

test('installGuide gives device-appropriate instructions', () => {
  const text = (g) => (g.steps || []).map((s) => s.text).join(' ');
  assert.match(text(installGuide({ os: 'ios', browser: 'safari' })), /Add to Home Screen/);
  assert.match(installGuide({ os: 'ios', browser: 'chrome' }).note, /Safari/);
  assert.match(text(installGuide({ os: 'android', browser: 'samsung' })), /Add page to/);
  assert.match(text(installGuide({ os: 'mac', browser: 'safari' })), /Add to Dock/);
  assert.match(text(installGuide({ os: 'windows', browser: 'edge' })), /Install this site as an app/);
  const ff = installGuide({ os: 'windows', browser: 'firefox' });
  assert.equal(ff.steps, null);
  assert.match(ff.note, /Chrome, Edge or Safari/);
  const inapp = installGuide({ os: 'ios', browser: 'inapp' });
  assert.equal(inapp.copyLink, true);
  assert.match(text(inapp), /Open in Safari/);
});
