/** Chat panel: grouped bubbles, receipts, copy, smart auto-scroll. */
import { h, setText } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { formatTime, initials, hueFor } from '../util.js';
import { copyText } from '../clipboard.js';

const GROUP_WINDOW_MS = 3 * 60 * 1000;
const NEAR_BOTTOM_PX = 96;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

export function mountChat({ log, form, input, sendBtn, jumpBtn, chat, room, isVisible, onUnread }) {
  const nodes = new Map(); // message id → { el, meta, msg }
  let last = null;
  let unread = 0;

  const empty = h('div', { class: 'empty empty--chat' },
    h('div', { class: 'empty__art', 'aria-hidden': 'true' }, icon('message', { size: 26 })),
    h('p', { class: 'empty__title', text: 'No messages yet' }),
    h('p', { class: 'empty__text', text: 'Send a note, a link or a code snippet to everyone in the room.' }));
  log.replaceChildren(empty);

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM_PX;
  const scrollToEnd = (smooth) => log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });

  function add(msg) {
    empty.remove();
    const stick = nearBottom() || msg.mine;
    const el = msg.kind === 'system' ? systemNode(msg) : bubble(msg);
    log.append(el);
    if (msg.kind !== 'system') last = { msg, el };
    else last = null;
    if (stick) requestAnimationFrame(() => scrollToEnd(true));
    else if (!msg.mine && msg.kind === 'text') jumpBtn.hidden = false;
    if (msg.kind === 'text' && !msg.mine && !isVisible()) onUnread(++unread);
  }

  function bubble(msg) {
    const prev = last?.msg;
    const grouped = prev && prev.kind === 'text' && prev.mine === msg.mine && prev.from === msg.from && msg.ts - prev.ts < GROUP_WINDOW_MS;
    if (grouped) last.el.classList.remove('is-last');
    const meta = h('p', { class: 'msg__meta' });
    const copy = h('button', {
      class: 'icon-btn icon-btn--sm msg__copy', type: 'button', 'aria-label': 'Copy message',
      onclick: async () => {
        const ok = await copyText(msg.text);
        toast(ok ? { tone: 'success', title: 'Message copied', key: 'copy' } : { tone: 'error', title: 'Couldn’t copy the message', key: 'copy' });
      },
    }, icon('copy', { size: 15 }));
    let avatar = null;
    if (!msg.mine) {
      avatar = h('span', { class: 'avatar avatar--xs', 'aria-hidden': 'true', text: initials(msg.name) });
      avatar.style.setProperty('--hue', hueFor(msg.from));
    }
    const el = h('div', { class: `msg ${msg.mine ? 'msg--mine' : 'msg--theirs'} is-last${grouped ? '' : ' is-first'}` },
      !msg.mine && !grouped ? h('p', { class: 'msg__author' }, avatar, h('span', { text: msg.name })) : null,
      h('div', { class: 'msg__row' },
        h('div', { class: 'msg__bubble' }, h('p', { class: 'msg__text' }, linkify(msg.text))),
        copy),
      meta);
    nodes.set(msg.id, { el, meta, msg });
    renderMeta(msg);
    return el;
  }

  function systemNode(msg) {
    return h('p', { class: `msg-system msg-system--${msg.tone}` },
      h('span', { text: msg.text }), h('time', { text: formatTime(msg.ts), datetime: new Date(msg.ts).toISOString() }));
  }

  function renderMeta(msg) {
    const n = nodes.get(msg.id);
    if (!n) return;
    const time = formatTime(msg.ts);
    let text = time;
    if (msg.mine) {
      const total = msg.recipients.size;
      const got = msg.deliveredTo.size;
      if (msg.status === 'failed') text = `${time} · Not sent`;
      else if (msg.status === 'delivered') text = `${time} · Delivered`;
      else if (got) text = `${time} · Delivered to ${got} of ${total}`;
      else text = `${time} · Sent`;
      n.el.dataset.status = msg.status;
    }
    setText(n.meta, text);
  }

  function onTrim(dropped) {
    for (const m of dropped) { nodes.get(m.id)?.el.remove(); nodes.delete(m.id); }
  }

  /* ---------------- composer ---------------- */

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function updateComposer() {
    const peers = room.connectedPeers().length;
    input.disabled = peers === 0;
    const first = room.connectedPeers()[0]?.name || '';
    const short = first.length > 22 ? `${first.slice(0, 21)}…` : first;
    input.placeholder = peers ? (peers === 1 ? `Message ${short}` : `Message ${peers} devices`) : 'Chat opens when someone joins';
    sendBtn.disabled = peers === 0 || !input.value.trim();
  }

  function submit(e) {
    e?.preventDefault();
    const err = chat.send(input.value);
    if (err) { toast({ tone: 'warn', title: err, key: 'chat-error' }); return; }
    input.value = '';
    autosize();
    updateComposer();
    input.focus();
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) submit(e);
  }

  function onInput() { autosize(); updateComposer(); }

  function onScroll() {
    if (nearBottom()) jumpBtn.hidden = true;
  }

  function onJump() { scrollToEnd(true); jumpBtn.hidden = true; }

  form.addEventListener('submit', submit);
  input.addEventListener('keydown', onKey);
  input.addEventListener('input', onInput);
  log.addEventListener('scroll', onScroll, { passive: true });
  jumpBtn.addEventListener('click', onJump);

  const unsubs = [
    chat.on('add', add),
    chat.on('update', renderMeta),
    chat.on('trim', onTrim),
    room.on('peer:join', updateComposer),
    room.on('peer:leave', updateComposer),
    room.on('peer:update', updateComposer),
  ];
  updateComposer();

  return {
    /** Called when the chat becomes visible. */
    seen() {
      unread = 0;
      onUnread(0);
      if (!jumpBtn.hidden && nearBottom()) jumpBtn.hidden = true;
    },
    destroy() {
      unsubs.forEach((u) => u());
      form.removeEventListener('submit', submit);
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
      log.removeEventListener('scroll', onScroll);
      jumpBtn.removeEventListener('click', onJump);
      log.replaceChildren();
      input.value = '';
      jumpBtn.hidden = true;
    },
  };
}

/** Turns http(s) URLs into safe links; everything else stays plain text. */
function linkify(text) {
  const out = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url;
    try { url = new URL(match[0]); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
    out.push(h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer nofollow', text: match[0] }));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}
