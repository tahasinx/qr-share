/** Small, dependency-free helpers shared across modules. */

/** Room-code alphabet: no 0/O, 1/I/L to avoid read-aloud and typing mistakes. 31 symbols. */
const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 10; // 31^10 ≈ 8.2e14 (~49.5 bits)

/** Uniform random string from `alphabet` using rejection sampling over crypto bytes. */
export function randomString(length, alphabet = ROOM_ALPHABET) {
  const out = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < max) out.push(alphabet[b % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export const newRoomCode = () => randomString(ROOM_CODE_LENGTH);

/** Normalises user input ("k7qm3-xrpwa", full links…) to a room code, or null if invalid. */
export function parseRoomCode(input) {
  if (!input) return null;
  let s = String(input).trim();
  try {
    const u = new URL(s);
    s = (u.hash || '').replace(/^#/, '') || u.searchParams.get('room') || '';
  } catch { /* not a URL */ }
  s = s.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of s) if (!ROOM_ALPHABET.includes(ch)) return null;
  return s;
}

export const formatRoomCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

export function roomLink(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = code;
  return u.toString();
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = -1;
  do { v /= 1000; i++; } while (v >= 1000 && i < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export const formatSpeed = (bps) => `${formatBytes(bps)}/s`;

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return 'less than a second';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
export const formatTime = (ts) => timeFmt.format(ts);

/* ---------- File names ---------- */

// C0/C1 controls, bidi overrides/isolates, zero-width chars: used to spoof extensions ("gpj.exe").
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Makes an untrusted file name safe to display and to use as a download name. */
export function sanitizeFileName(name) {
  let s = String(name ?? '').normalize('NFC').replace(UNSAFE_NAME_CHARS, '');
  s = s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!s) s = 'file';
  if (s.length > 180) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

export function splitExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1).toLowerCase()] : [name, ''];
}

/** Returns "name (2).ext" style names so repeated downloads in a session stay distinct. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const [base, ext] = splitExt(name);
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext ? '.' + ext : ''}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}

const EXECUTABLE_EXT = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'lnk', 'reg', 'jar', 'apk', 'xapk', 'app', 'dmg', 'pkg', 'sh', 'command', 'deb', 'rpm',
  'appimage', 'msix', 'appx', 'iso', 'docm', 'xlsm', 'pptm',
]);
export const isExecutableName = (name) => EXECUTABLE_EXT.has(splitExt(name)[1]);

/** Raster formats safe to render via <img>. SVG is excluded on purpose: it can carry script. */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
export const isPreviewableType = (type) => PREVIEWABLE.has(type);

export function sanitizeMime(type) {
  const t = String(type || '').toLowerCase().slice(0, 100);
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(t) ? t : '';
}

/** Coarse category used to pick an icon. */
export function fileKind(name, type = '') {
  const ext = splitExt(name)[1];
  if (type.startsWith('image/') || /^(png|jpe?g|gif|webp|avif|heic|heif|bmp|svg|tiff?)$/.test(ext)) return 'image';
  if (type.startsWith('video/') || /^(mp4|mov|mkv|webm|avi|m4v)$/.test(ext)) return 'video';
  if (type.startsWith('audio/') || /^(mp3|wav|flac|aac|ogg|m4a|opus)$/.test(ext)) return 'audio';
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/.test(ext)) return 'archive';
  if (/^(pdf|docx?|odt|rtf|txt|md|pages|xlsx?|csv|ods|numbers|pptx?|key|odp|epub)$/.test(ext)) return 'doc';
  if (/^(js|ts|json|html?|css|py|rb|go|rs|java|c|cpp|h|sh|yml|yaml|xml|sql)$/.test(ext)) return 'code';
  return 'file';
}

/* ---------- Device identity ---------- */

const ADJECTIVES = ['Amber', 'Brisk', 'Cobalt', 'Coral', 'Dusky', 'Ember', 'Frosty', 'Golden', 'Hazel', 'Indigo',
  'Jade', 'Lunar', 'Maple', 'Misty', 'Nimble', 'Olive', 'Pearl', 'Quiet', 'Rapid', 'Rosy', 'Sage', 'Solar',
  'Swift', 'Teal', 'Velvet', 'Witty'];
const ANIMALS = ['Badger', 'Crane', 'Falcon', 'Fox', 'Gecko', 'Heron', 'Ibis', 'Koala', 'Lynx', 'Marten', 'Newt',
  'Otter', 'Owl', 'Panda', 'Puffin', 'Quail', 'Raven', 'Seal', 'Sparrow', 'Tapir', 'Tern', 'Walrus', 'Wren', 'Yak'];

export function randomDeviceName() {
  const pick = (arr) => arr[crypto.getRandomValues(new Uint32Array(1))[0] % arr.length];
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

/** Best-effort device class from the UA. Only used for an icon and a label. */
export function detectDevice() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || touchMac || (/Android/.test(ua) && !/Mobile/.test(ua))) return 'tablet';
  if (/iPhone|iPod|Android.+Mobile|Mobile/.test(ua)) return 'phone';
  return 'computer';
}

export function sanitizeDisplayName(name) {
  return String(name ?? '').replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

/* ---------- Misc ---------- */

export function initials(name) {
  const parts = String(name).split(' ').filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

/** Stable hue (0–359) derived from a string, for avatar tints. */
export function hueFor(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 360;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeStorage(kind = 'localStorage') {
  return {
    get(key) { try { return window[kind].getItem(key); } catch { return null; } },
    set(key, value) { try { window[kind].setItem(key, value); } catch { /* storage unavailable */ } },
    remove(key) { try { window[kind].removeItem(key); } catch { /* storage unavailable */ } },
  };
}
