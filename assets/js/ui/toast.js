/** Non-blocking notifications. Polite for info/success, assertive for errors. */
import { h } from './dom.js';
import { icon } from './icons.js';

const TONE_ICON = { success: 'check', info: 'info', warn: 'alert', error: 'alert' };
const MAX_VISIBLE = 3;
let region;
let regionAlert;
const live = new Map(); // key → toast element

function ensureRegions() {
  if (region) return;
  region = h('section', { class: 'toasts', 'aria-label': 'Notifications' });
  // Separate live regions: screen readers announce errors immediately, the rest politely.
  regionAlert = h('div', { class: 'sr-only', role: 'alert' });
  region.append(h('div', { class: 'sr-only', 'aria-live': 'polite', id: 'toastPolite' }));
  document.body.append(region, regionAlert);
}

/**
 * @param {{ tone?: 'success'|'info'|'warn'|'error', title: string, body?: string,
 *   action?: { label: string, run: () => void }, duration?: number, key?: string }} opts
 */
export function toast({ tone = 'info', title, body, action, duration, key }) {
  ensureRegions();
  if (key && live.has(key)) dismiss(live.get(key), true);
  const ms = duration ?? (tone === 'error' ? 8000 : action ? 7000 : 4000);

  const el = h('div', { class: `toast toast--${tone}`, dataset: { key: key || '' } },
    h('span', { class: 'toast__icon' }, icon(TONE_ICON[tone], { size: 18 })),
    h('div', { class: 'toast__text' },
      h('p', { class: 'toast__title', text: title }),
      body ? h('p', { class: 'toast__body', text: body }) : null),
    action ? h('button', {
      class: 'btn btn--sm btn--quiet toast__action', type: 'button', text: action.label,
      onclick: () => { dismiss(el); action.run(); },
    }) : null,
    h('button', { class: 'icon-btn icon-btn--sm toast__close', type: 'button', 'aria-label': 'Dismiss notification', onclick: () => dismiss(el) },
      icon('x', { size: 16 })));

  let timer = null;
  const arm = () => { clearTimeout(timer); if (ms > 0) timer = setTimeout(() => dismiss(el), ms); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  el._timer = () => clearTimeout(timer);

  region.append(el);
  if (key) live.set(key, el);
  arm();

  // Announce through the live regions (toasts themselves aren't live, so they don't double-announce).
  const spoken = `${title}${body ? '. ' + body : ''}`;
  if (tone === 'error') regionAlert.textContent = spoken;
  else document.getElementById('toastPolite').textContent = spoken;

  const visible = region.querySelectorAll('.toast:not(.is-leaving)');
  if (visible.length > MAX_VISIBLE) dismiss(visible[0], true);
  return () => dismiss(el);
}

/** Screen-reader-only announcement for events that are already visible on screen. */
export function announce(text) {
  ensureRegions();
  const polite = document.getElementById('toastPolite');
  polite.textContent = '';
  requestAnimationFrame(() => { polite.textContent = text; });
}

function dismiss(el, instant = false) {
  if (!el || el.classList.contains('is-leaving')) return;
  el._timer?.();
  const key = el.dataset.key;
  if (key && live.get(key) === el) live.delete(key);
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.remove(); return; }
  el.classList.add('is-leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 400);
}
