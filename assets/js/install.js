/**
 * "Install app": uses the browser's own install prompt where it exists (Chromium-based browsers fire
 * `beforeinstallprompt`), and otherwise shows step-by-step instructions for the user's device.
 */
import { h } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { openDialog } from './ui/dialog.js';
import { toast } from './ui/toast.js';
import { copyText } from './clipboard.js';
import { safeStorage } from './util.js';

const store = safeStorage('localStorage');
const INSTALLED_FLAG = 'qrshare:installed';

/** Running as an installed app (home screen / dock / app window) rather than in a browser tab. */
export function isStandalone() {
  return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
    .some((mode) => matchMedia(`(display-mode: ${mode})`).matches) || navigator.standalone === true;
}

/**
 * Best-effort platform detection for install instructions only (never for features).
 * @returns {{ os: 'ios'|'android'|'mac'|'windows'|'chromeos'|'linux'|'other',
 *   browser: 'safari'|'chrome'|'edge'|'firefox'|'samsung'|'opera'|'inapp'|'other' }}
 */
export function detectPlatform(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints || 0) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const android = /Android/.test(ua);
  let os = 'other';
  if (ios) os = 'ios';
  else if (android) os = 'android';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'mac';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Linux/.test(ua)) os = 'linux';

  let browser = 'other';
  if (/FBAN|FBAV|Instagram|Line\/|LinkedInApp|Snapchat|Twitter|TikTok|GSA\/|; wv\)/.test(ua)) browser = 'inapp';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = 'edge';
  else if (/OPR\/|OPiOS|Opera/.test(ua)) browser = 'opera';
  else if (/FxiOS|Firefox\//.test(ua)) browser = 'firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua)) browser = 'safari';
  return { os, browser };
}

/** Install steps for a platform. `null` steps means installing isn't possible in this browser. */
export function installGuide({ os, browser }) {
  const step = (text, glyph) => ({ text, glyph });
  const desktop = ['mac', 'windows', 'linux', 'chromeos', 'other'].includes(os);

  if (browser === 'inapp') {
    return {
      intro: 'This app’s built-in browser can’t install apps. Open QRShare in your regular browser first.',
      steps: [
        step('Tap the menu (⋯ or ⋮) in this app’s browser bar.', 'more'),
        step(os === 'ios' ? 'Choose “Open in Safari” (or “Open in browser”).' : 'Choose “Open in browser” (or “Open in Chrome”).'),
        step('Then tap Install app again.'),
      ],
      copyLink: true,
    };
  }
  if (os === 'ios') {
    const shareWhere = browser === 'safari'
      ? 'Tap the Share button in the toolbar.'
      : browser === 'chrome'
        ? 'Tap the Share button in the address bar.'
        : 'Open the browser menu, then tap Share.';
    return {
      intro: 'Add QRShare to your Home Screen to open it like an app, full screen.',
      steps: [
        step(shareWhere, 'share'),
        step('Scroll down and tap “Add to Home Screen”.', 'plusSquare'),
        step('Tap “Add” in the top-right corner.'),
      ],
      note: browser === 'safari' ? null : 'Don’t see “Add to Home Screen”? Open this page in Safari and try there.',
    };
  }
  if (os === 'android') {
    const guides = {
      samsung: [
        step('Tap the menu (☰) at the bottom of the screen.', 'menu'),
        step('Tap “Add page to”, then “Home screen”.', 'plusSquare'),
        step('Tap “Add”.'),
      ],
      firefox: [
        step('Tap the menu (⋮).', 'more'),
        step('Tap “Add app to Home screen” (or “Install”).', 'plusSquare'),
        step('Confirm with “Add”.'),
      ],
      edge: [
        step('Tap the menu (⋯) at the bottom of the screen.', 'more'),
        step('Tap “Add to phone” (or “Install app”).', 'plusSquare'),
        step('Tap “Install”.'),
      ],
      opera: [
        step('Tap the menu (⋮).', 'more'),
        step('Tap “Add to Home screen”.', 'plusSquare'),
        step('Tap “Add”.'),
      ],
    };
    return {
      intro: 'Install QRShare to open it from your home screen like any other app.',
      steps: guides[browser] || [
        step('Tap the menu (⋮) in the top-right corner.', 'more'),
        step('Tap “Install app” or “Add to Home screen”.', 'plusSquare'),
        step('Tap “Install”.'),
      ],
    };
  }
  if (desktop) {
    if (browser === 'firefox') {
      return {
        intro: 'Firefox on computers can’t install web apps.',
        steps: null,
        note: 'To install QRShare, open this page in Chrome, Edge or Safari (on a Mac). Or bookmark it to come back quickly.',
        copyLink: true,
      };
    }
    if (browser === 'safari') {
      return {
        intro: 'Add QRShare to your Dock to open it in its own window.',
        steps: [
          step('In the menu bar, choose File → “Add to Dock”.'),
          step('Click “Add”.'),
        ],
        note: 'Needs macOS Sonoma or later. On older versions, open this page in Chrome or Edge to install it.',
      };
    }
    if (browser === 'edge') {
      return {
        intro: 'Install QRShare to open it in its own window from your Start menu or dock.',
        steps: [
          step('Click the “App available” icon at the right of the address bar, or open the menu (⋯) → Apps → “Install this site as an app”.', 'install'),
          step('Click “Install”.'),
        ],
      };
    }
    return {
      intro: 'Install QRShare to open it in its own window from your dock, taskbar or app list.',
      steps: [
        step('Click the install icon at the right of the address bar, or open the menu (⋮) → “Cast, save and share” → “Install page as app”.', 'install'),
        step('Click “Install”.'),
      ],
      note: browser === 'chrome' || browser === 'opera' ? null : 'If your browser has no install option, open this page in Chrome or Edge.',
    };
  }
  return { intro: 'Use your browser’s menu and look for “Install app” or “Add to Home screen”.', steps: null };
}

/**
 * Wires up an install button. Hidden while running as an installed app, or once this browser has
 * installed it (until the browser offers installation again, e.g. after an uninstall).
 */
export function setupInstall(button, { getLink }) {
  let deferred = null;

  const refresh = () => {
    button.hidden = isStandalone() || (store.get(INSTALLED_FLAG) === '1' && !deferred);
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    deferred = e;
    store.remove(INSTALLED_FLAG); // the browser only offers this when the app isn't installed
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    store.set(INSTALLED_FLAG, '1');
    refresh();
    toast({ tone: 'success', key: 'install', title: 'QRShare installed', body: 'Open it from your home screen, dock or app list.' });
  });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', refresh);

  button.addEventListener('click', async () => {
    if (deferred) {
      const prompt = deferred;
      deferred = null; // a prompt event can only be used once
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice?.outcome !== 'accepted') refresh();
      } catch {
        showGuide(getLink());
      }
      return;
    }
    showGuide(getLink());
  });

  refresh();
}

function showGuide(link) {
  const guide = installGuide(detectPlatform());
  const body = [h('p', { class: 'dialog__text', text: guide.intro })];
  if (guide.steps) {
    body.push(h('ol', { class: 'steps install-steps' }, guide.steps.map((s) => h('li', null,
      h('span', { class: 'install-steps__text' },
        s.glyph ? h('span', { class: 'install-steps__glyph', 'aria-hidden': 'true' }, icon(s.glyph, { size: 16 })) : null,
        h('span', { class: 'install-steps__label', text: s.text }))))));
  }
  if (guide.note) body.push(h('p', { class: 'dialog__text dialog__text--muted', text: guide.note }));
  const actions = [];
  if (guide.copyLink && link) {
    actions.push(h('button', {
      class: 'btn btn--quiet', type: 'button',
      onclick: async () => toast((await copyText(link))
        ? { tone: 'success', key: 'copy', title: 'Link copied', body: 'Paste it into your browser’s address bar.' }
        : { tone: 'error', key: 'copy', title: 'Couldn’t copy the link' }),
    }, icon('link', { size: 18 }), 'Copy link'));
  }
  const dialog = openDialog({
    title: 'Install QRShare',
    className: 'dialog--install',
    body,
    actions: [...actions, h('button', { class: 'btn btn--primary', type: 'button', text: 'Got it', onclick: () => dialog.close() })],
  });
}
