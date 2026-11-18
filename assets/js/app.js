/**
 * QRShare application shell: routing, room lifecycle, layout state and global interactions.
 */
import { CONFIG } from './config.js';
import { RoomSession } from './room.js';
import { TransferManager } from './transfer.js';
import { ChatStore } from './chat.js';
import { copyText } from './clipboard.js';
import {
  newRoomCode, parseRoomCode, formatRoomCode, roomLink, randomDeviceName, detectDevice,
  sanitizeDisplayName, randomString, safeStorage,
} from './util.js';
import { h, $, setText, setChildren } from './ui/dom.js';
import { icon, hydrateIcons } from './ui/icons.js';
import { toast, announce } from './ui/toast.js';
import { openDialog, confirmDialog } from './ui/dialog.js';
import { qrSvg, qrPngBlob } from './ui/qr.js';
import { scannerSupported, startScanner } from './ui/scanner.js';
import { mountTransfers } from './views/transfers.js';
import { mountChat } from './views/chat.js';
import { mountPeople } from './views/people.js';

const store = safeStorage('localStorage');
const sessionStore = safeStorage('sessionStorage');
const WIDE = matchMedia('(min-width: 1180px)');
const NARROW = matchMedia('(max-width: 759.98px), (max-height: 520px) and (max-width: 1179.98px)');

const el = {
  app: $('#app'),
  statusPill: $('#statusPill'),
  statusText: $('#statusText'),
  joinBtn: $('#joinBtn'),
  themeBtn: $('#themeBtn'),
  leaveBtn: $('#leaveBtn'),
  brandLink: $('#brandLink'),
  tabs: $('#tabs'),
  roomHeading: $('#roomHeading'),
  roomHint: $('#roomHint'),
  qrButton: $('#qrButton'),
  qrCode: $('#qrCode'),
  roomCode: $('#roomCode'),
  copyLinkBtn: $('#copyLinkBtn'),
  shareBtn: $('#shareBtn'),
  saveQrBtn: $('#saveQrBtn'),
  peopleList: $('#peopleList'),
  peopleCount: $('#peopleCount'),
  dropzone: $('#dropzone'),
  dropTitle: $('#dropTitle'),
  dropHint: $('#dropHint'),
  fileInput: $('#fileInput'),
  chooseBtn: $('#chooseBtn'),
  staged: $('#staged'),
  transferList: $('#transferList'),
  clearBtn: $('#clearBtn'),
  chatLog: $('#chatLog'),
  composer: $('#composer'),
  chatInput: $('#chatInput'),
  sendBtn: $('#sendBtn'),
  jumpBtn: $('#jumpBtn'),
  screen: $('#screen'),
  dropOverlay: $('#dropOverlay'),
};

const profile = {
  name: sanitizeDisplayName(store.get('qrshare:name')) || randomDeviceName(),
  device: detectDevice(),
};
store.set('qrshare:name', profile.name);

// Identifies this tab across reloads so peers can replace our stale link immediately.
let deviceKey = sessionStore.get('qrshare:key');
if (!deviceKey) { deviceKey = randomString(16); sessionStore.set('qrshare:key', deviceKey); }

/** Current room session and everything mounted for it. */
let session = null;
let tab = 'room';
let userPickedTab = false;
let wakeLock = null;
let unreadChat = 0;

/* ==================================================================== */
/* Boot                                                                  */
/* ==================================================================== */

function boot() {
  hydrateIcons();
  initTheme();
  bindGlobalUi();
  registerServiceWorker();

  if (!window.isSecureContext) {
    showScreen({
      icon: 'lock',
      title: 'QRShare needs a secure connection',
      text: 'Browsers only allow peer-to-peer connections on HTTPS pages. Open QRShare from its https:// address instead.',
    });
    return;
  }
  if (typeof RTCPeerConnection !== 'function' || typeof window.Peer !== 'function' || !window.crypto?.subtle) {
    showScreen({
      icon: 'alert',
      title: 'This browser can’t make direct connections',
      text: 'QRShare needs WebRTC, which this browser doesn’t support or has turned off.',
      tips: ['Use a current version of Chrome, Edge, Firefox or Safari.', 'Some privacy extensions disable WebRTC. Allow it for this site.'],
    });
    return;
  }
  route({ initial: true });
}

/** Reads the room from the URL (#CODE, or the legacy ?room=CODE) and starts it. */
function route({ initial = false } = {}) {
  const url = new URL(location.href);
  const legacy = url.searchParams.get('room');
  const raw = url.hash.replace(/^#/, '') || legacy || '';
  if (!raw) {
    const code = newRoomCode();
    history.replaceState(null, '', roomLink(code));
    startRoom(code, { created: true });
    return;
  }
  const code = parseRoomCode(raw);
  if (!code) {
    endSession();
    showScreen({
      icon: 'link',
      title: 'This room link doesn’t work',
      text: 'The code in the link is incomplete or from an older version of QRShare. Ask for a fresh link, or start a new room.',
      actions: [{ label: 'Start a new room', primary: true, run: () => newRoom() }],
    });
    return;
  }
  if (legacy || url.hash.slice(1) !== code) history.replaceState(null, '', roomLink(code));
  if (session?.code === code && !initial) return;
  startRoom(code, { created: false });
}

/* ==================================================================== */
/* Room lifecycle                                                        */
/* ==================================================================== */

function startRoom(code, { created }) {
  endSession();
  hideScreen();
  const room = new RoomSession({ code, config: CONFIG, profile, deviceKey });
  const transfers = new TransferManager(room, CONFIG);
  const chat = new ChatStore(room, CONFIG);
  session = { code, created, room, transfers, chat, link: roomLink(code), signalWasLost: false };

  renderRoomCard();
  unreadChat = 0;
  setBadge('chat', 0);
  setBadge('files', 0);
  userPickedTab = false;
  setTab(NARROW.matches ? 'room' : 'files', { user: false });

  session.people = mountPeople({ list: el.peopleList, count: el.peopleCount, room, getProfile: () => profile, onRename: renameDialog });
  session.transferView = mountTransfers({ list: el.transferList, staged: el.staged, clearBtn: el.clearBtn, transfers, room });
  session.chatView = mountChat({
    log: el.chatLog, form: el.composer, input: el.chatInput, sendBtn: el.sendBtn, jumpBtn: el.jumpBtn,
    chat, room, isVisible: () => isPanelVisible('chat'), onUnread: (n) => { unreadChat = n; setBadge('chat', n); updateTitle(); },
  });

  session.unsubs = [
    room.on('state', (state, detail) => { if (state === 'failed') onRoomFailed(detail); updateStatus(); }),
    room.on('signal', onSignal),
    room.on('beacon', updateStatus),
    room.on('peer:join', onPeerJoin),
    room.on('peer:leave', onPeerLeave),
    room.on('peer:update', updateStatus),
    room.on('peer:interrupted', updateStatus),
    room.on('peer:failed', () => toast({
      tone: 'warn', key: 'peer-failed', title: 'Couldn’t connect to a device',
      body: 'Its network may block direct connections. Putting both devices on the same Wi-Fi usually helps.',
    })),
    room.on('notice', onNotice),
    transfers.on('offer', onOffer),
    transfers.on('update', onTransferUpdate),
    transfers.on('declined', (link, n) => toast({ tone: 'info', title: `${link.name} declined ${n === 1 ? 'the file' : `${n} files`}` })),
    transfers.on('staged', updateDropzone),
    chat.on('incoming', (m) => { if (!isPanelVisible('chat')) toast({ tone: 'info', key: 'chat', title: m.name, body: truncate(m.text, 90), action: { label: 'Reply', run: () => setTab('chat', { user: true, focus: true }) } }); }),
  ];

  if (CONFIG.debug) window.__qrshare = session;
  updateStatus();
  updateDropzone();
  room.start();
}

function endSession() {
  if (!session) return;
  const s = session;
  session = null;
  s.unsubs?.forEach((u) => u());
  s.people?.destroy();
  s.transferView?.();
  s.chatView?.destroy();
  s.transfers.destroy();
  s.chat.destroy();
  s.room.leave({ fast: true });
  releaseWakeLock();
}

async function leaveRoom() {
  if (!session) return;
  if (session.transfers.hasActiveTransfers()) {
    const ok = await confirmDialog({
      title: 'Leave while files are transferring?',
      message: 'Transfers in progress will stop, and files that haven’t finished won’t be saved.',
      confirmLabel: 'Leave room',
      danger: true,
    });
    if (!ok) return;
  }
  const code = session.code;
  const s = session;
  session = null;
  s.unsubs?.forEach((u) => u());
  s.people?.destroy();
  s.transferView?.();
  s.chatView?.destroy();
  s.transfers.destroy();
  s.chat.destroy();
  releaseWakeLock();
  await s.room.leave();
  showScreen({
    icon: 'leave',
    title: 'You left the room',
    text: 'Your connections are closed and nothing from this session is stored on this device.',
    actions: [
      { label: 'Start a new room', primary: true, run: () => newRoom() },
      { label: 'Rejoin', run: () => startRoom(code, { created: false }) },
    ],
  });
  updateTitle();
}

async function newRoom() {
  if (session && session.room.connectedPeers().length) {
    const ok = await confirmDialog({
      title: 'Start a new room?',
      message: 'You’ll leave this room and disconnect from everyone in it.',
      confirmLabel: 'Start new room',
    });
    if (!ok) return;
  }
  const code = newRoomCode();
  history.pushState(null, '', roomLink(code));
  startRoom(code, { created: true });
}

async function switchRoom(code) {
  if (session?.code === code) { toast({ tone: 'info', title: 'You’re already in this room' }); return; }
  if (session && (session.room.connectedPeers().length || session.transfers.hasActiveTransfers())) {
    const ok = await confirmDialog({
      title: 'Switch rooms?',
      message: 'You’ll leave the current room and disconnect from everyone in it.',
      confirmLabel: 'Join other room',
    });
    if (!ok) return;
  }
  history.pushState(null, '', roomLink(code));
  startRoom(code, { created: false });
}

function onRoomFailed(detail) {
  const reason = detail?.reason;
  const code = session?.code;
  const retry = { label: 'Try again', primary: true, run: () => startRoom(code, { created: false }) };
  const fresh = { label: 'Start a new room', run: () => newRoom() };
  const relayTip = CONFIG.iceServersUrl ? null : 'If you run this site, adding a TURN relay lets QRShare connect through strict networks (see README).';
  const screens = {
    signaling: {
      icon: 'alert',
      title: 'Couldn’t reach the connection service',
      text: 'QRShare uses a small signaling service to introduce devices to each other. It’s blocked on this network or temporarily unavailable.',
      tips: ['Check that you’re online.', 'Firewalls, VPNs or content blockers can block it. Try another network.'],
      actions: [retry],
    },
    unreachable: {
      icon: 'relay',
      title: 'Found the room, but couldn’t connect',
      text: 'Someone is in this room, but your networks won’t allow a direct connection between the devices.',
      tips: ['Put both devices on the same Wi-Fi network.', 'Turn off VPNs or try mobile data on one device.', relayTip].filter(Boolean),
      actions: [retry, fresh],
    },
    full: {
      icon: 'users',
      title: 'This room is full',
      text: `A room holds up to ${CONFIG.maxPeers} devices so every device can link directly to every other.`,
      actions: [{ ...fresh, primary: true }],
    },
    unsupported: {
      icon: 'alert',
      title: 'This browser can’t make direct connections',
      text: 'QRShare needs WebRTC. Use a current version of Chrome, Edge, Firefox or Safari.',
    },
  };
  showScreen(screens[reason] || screens.signaling);
}

/* ==================================================================== */
/* Room events → UI                                                      */
/* ==================================================================== */

function onPeerJoin(link) {
  toast({ tone: 'success', key: `join-${link.id}`, title: `${link.name} joined` });
  if (!userPickedTab && tab === 'room') setTab('files', { user: false });
  updateStatus();
}

function onPeerLeave(link, reason) {
  if (reason === 'replaced') { updateStatus(); return; }
  toast({
    tone: reason === 'left' ? 'info' : 'warn',
    key: `leave-${link.id}`,
    title: reason === 'left' ? `${link.name} left` : `Lost connection to ${link.name}`,
    body: reason === 'left' ? null : 'Their device went offline or changed networks. They can rejoin with the same link.',
  });
  updateStatus();
}

function onSignal(online) {
  if (!session) return;
  if (!online) {
    session.signalWasLost = true;
    toast({
      tone: 'warn', key: 'signal', title: 'Connection service unreachable',
      body: 'Devices already connected keep working. New devices can join again once it’s back.',
    });
  } else if (session.signalWasLost) {
    session.signalWasLost = false;
    toast({ tone: 'success', key: 'signal', title: 'Back online' });
  }
  updateStatus();
}

function onNotice(kind) {
  if (kind === 'relay-unavailable') {
    toast({ tone: 'warn', title: 'Relay server unavailable', body: 'Direct connections still work. Devices on strict networks may not be able to connect.' });
  } else if (kind === 'peer-full') {
    toast({ tone: 'warn', title: 'A device couldn’t join: the room is full' });
  }
}

function onOffer(batch) {
  const n = batch.ids.length;
  const title = `${batch.peerName} wants to send ${n === 1 ? 'a file' : `${n} files`}`;
  updateTitle();
  if (isPanelVisible('files')) {
    // The offer card itself is on screen; don't cover it with a toast, just announce it.
    announce(`${title}. Accept or decline in Files.`);
    return;
  }
  updatePendingBadge();
  toast({
    tone: 'info', key: `offer-${batch.id}`,
    title,
    body: n === 1 ? session.transfers.transfers.get(batch.ids[0])?.name : 'Review them in Files.',
    action: { label: 'Review', run: () => { setTab('files', { user: true }); focusBatch(batch.id); } },
    duration: 10000,
  });
}

function focusBatch(batchId) {
  requestAnimationFrame(() => {
    const batchEl = el.transferList.querySelector(`[data-batch="${CSS.escape(batchId)}"]`);
    const btn = batchEl?.querySelector('.batch__actions .btn--primary');
    batchEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    btn?.focus({ preventScroll: true });
  });
}

/** Batch-level completion/failure notifications (one toast per batch, not per file). */
function onTransferUpdate(t) {
  if (!session) return;
  syncWakeLock();
  const { transfers } = session;
  const batch = transfers.batches.get(t.batchId);
  if (!batch) return;
  const ts = transfers.batchTransfers(batch);
  if (t.status === 'failed') {
    toast({ tone: 'error', key: `fail-${batch.id}`, title: `Couldn’t ${t.dir === 'in' ? 'receive' : 'send'} ${t.name}`, body: t.error });
    return;
  }
  if (!ts.every((x) => ['done', 'failed', 'cancelled', 'declined'].includes(x.status))) return;
  if (batch.notified) return;
  batch.notified = true;
  const done = ts.filter((x) => x.status === 'done').length;
  if (!done) return;
  const files = done === 1 ? ts.find((x) => x.status === 'done').name : `${done} files`;
  if (batch.dir === 'in') {
    toast({
      tone: 'success', key: `done-${batch.id}`, title: `Received ${files}`, body: `From ${batch.peerName}. Verified and ready to save.`,
      action: isPanelVisible('files') ? null : { label: 'View', run: () => setTab('files', { user: true }) },
    });
  } else {
    toast({ tone: 'success', key: `done-${batch.id}`, title: `${batch.peerName} received ${files}` });
  }
  updatePendingBadge();
}

function updatePendingBadge() {
  if (!session || isPanelVisible('files')) { setBadge('files', 0); return; }
  const n = [...session.transfers.batches.values()].filter((b) => b.dir === 'in' && session.transfers.batchTransfers(b).some((t) => t.status === 'pending')).length;
  setBadge('files', n);
}

/* ==================================================================== */
/* Status, phase, room card                                              */
/* ==================================================================== */

function updateStatus() {
  if (!session) return;
  const { room } = session;
  const peers = room.connectedPeers();
  const reconnecting = [...room.links.values()].filter((l) => l.status === 'reconnecting');
  const connecting = [...room.links.values()].some((l) => l.status === 'connecting');
  let phase;
  let tone;
  let text;
  if (room.state === 'connecting' || room.state === 'idle') {
    phase = 'connecting'; tone = 'busy'; text = session.created ? 'Setting up room…' : 'Joining room…';
  } else if (room.state === 'failed' || room.state === 'closed') {
    phase = 'failed'; tone = 'error'; text = 'Not connected';
  } else if (reconnecting.length) {
    phase = peers.length ? 'active' : 'waiting'; tone = 'warn'; text = `Reconnecting to ${reconnecting[0].name}…`;
  } else if (peers.length) {
    phase = 'active'; tone = 'ok';
    text = peers.length === 1 ? `Connected to ${peers[0].name}` : `${peers.length} devices connected`;
    if (!room.signalOnline) { tone = 'warn'; text += ' · offline for new devices'; }
  } else if (connecting) {
    phase = 'waiting'; tone = 'busy'; text = 'Connecting to devices…';
  } else if (!room.signalOnline) {
    phase = 'waiting'; tone = 'warn'; text = 'Offline · retrying…';
  } else {
    phase = 'waiting'; tone = 'waiting'; text = 'Waiting for another device';
  }
  el.app.dataset.phase = phase;
  el.statusPill.dataset.tone = tone;
  setText(el.statusText, text);

  setText(el.roomHeading, phase === 'active' ? 'Add another device' : 'Scan to connect');
  let hint = 'Point another device’s camera at this code, or send it the link.';
  if (phase === 'waiting' && !session.created && room.state === 'online' && !connecting) {
    hint = 'No one else is here right now. The person who shared this link may have closed it. They can reopen the same link to reconnect.';
  } else if (phase === 'active') {
    hint = 'Anyone with this code can join, so share it only with people you trust.';
  }
  setText(el.roomHint, hint);
  updateDropzone();
  updateTitle();
}

function renderRoomCard() {
  const { code, link } = session;
  setText(el.roomCode, formatRoomCode(code));
  el.roomCode.setAttribute('aria-label', `Room code ${code.split('').join(' ')}`);
  const svg = qrSvg(link, { label: `QR code for room ${formatRoomCode(code)}` });
  el.qrCode.replaceChildren(svg);
  el.qrButton.classList.remove('qr--reveal');
  void el.qrButton.offsetWidth;
  el.qrButton.classList.add('qr--reveal');
  el.shareBtn.hidden = typeof navigator.share !== 'function';
}

function updateDropzone() {
  if (!session) return;
  const peers = session.room.connectedPeers();
  const staged = session.transfers.staged.length;
  el.dropzone.dataset.state = peers.length ? 'ready' : 'waiting';
  if (peers.length) {
    setText(el.dropTitle, peers.length === 1 ? `Send files to ${peers[0].name}` : `Send files to ${peers.length} devices`);
    setText(el.dropHint, 'Drop files anywhere, paste them, or choose from this device.');
  } else {
    setText(el.dropTitle, staged ? 'Waiting for a device to join' : 'Get files ready');
    setText(el.dropHint, 'Pick files now. They’re offered as soon as another device joins.');
  }
}

/* ==================================================================== */
/* Layout: tabs & badges                                                 */
/* ==================================================================== */

function setTab(next, { user = false, focus = false } = {}) {
  tab = next;
  if (user) userPickedTab = true;
  el.app.dataset.tab = next;
  for (const b of el.tabs.querySelectorAll('.tab')) {
    const on = b.dataset.tab === next || (!NARROW.matches && next === 'room' && b.dataset.tab === 'files');
    b.setAttribute('aria-current', on ? 'page' : 'false');
  }
  if (isPanelVisible('chat')) { session?.chatView?.seen(); }
  if (isPanelVisible('files')) setBadge('files', 0);
  if (focus && next === 'chat') requestAnimationFrame(() => el.chatInput.focus());
  updateTitle();
}

function isPanelVisible(name) {
  if (document.hidden) return false;
  if (WIDE.matches) return true;
  if (NARROW.matches) return tab === name;
  if (name === 'room') return true;
  if (name === 'files') return tab !== 'chat';
  return tab === 'chat';
}

function setBadge(name, n) {
  const b = document.getElementById(`badge-${name}`);
  if (!b) return;
  b.hidden = !n;
  setText(b, n > 99 ? '99+' : String(n));
  b.setAttribute('aria-label', n ? `${n} new` : '');
}

function updateTitle() {
  const pending = session ? [...session.transfers.transfers.values()].filter((t) => t.status === 'pending').length : 0;
  const n = unreadChat + pending;
  document.title = `${n ? `(${n}) ` : ''}QRShare`;
}

/* ==================================================================== */
/* Files in: picker, drag & drop, paste                                  */
/* ==================================================================== */

function intake(files, { skippedFolders = 0 } = {}) {
  if (!session) return;
  const list = [...files];
  if (skippedFolders) {
    toast({ tone: 'warn', title: skippedFolders === 1 ? 'Folders can’t be sent' : `${skippedFolders} folders skipped`, body: 'Compress the folder into a .zip first, or select the files inside it.' });
  }
  if (!list.length) return;
  const { staged } = session.transfers.send(list);
  if (staged) {
    toast({ tone: 'info', key: 'staged', title: `${staged === 1 ? 'File' : `${staged} files`} ready to send`, body: 'They’ll be offered as soon as another device joins.' });
  }
  if (NARROW.matches && tab !== 'files') setTab('files', { user: true });
}

function filesFromDrop(dt) {
  const files = [];
  let skippedFolders = 0;
  const items = dt.items ? [...dt.items] : [];
  if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry();
      if (entry?.isDirectory) { skippedFolders++; continue; }
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  } else {
    files.push(...dt.files);
  }
  return { files, skippedFolders };
}

function bindFileIntake() {
  el.chooseBtn.addEventListener('click', () => el.fileInput.click());
  el.dropzone.addEventListener('click', (e) => { if (e.target === el.dropzone || e.target.closest('.dropzone__text, .dropzone__art')) el.fileInput.click(); });
  el.fileInput.addEventListener('change', () => {
    intake(el.fileInput.files);
    el.fileInput.value = '';
  });

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const hide = () => { depth = 0; el.dropOverlay.hidden = true; el.app.classList.remove('is-dragging'); };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !session || !el.screen.hidden) return;
    e.preventDefault();
    depth++;
    el.dropOverlay.hidden = false;
    el.app.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = session ? 'copy' : 'none'; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) hide(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (!session || !el.screen.hidden) return;
    const { files, skippedFolders } = filesFromDrop(e.dataTransfer);
    intake(files, { skippedFolders });
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !session || !el.screen.hidden) return;
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    // Clipboard images are all called "image.png"; give them distinct, meaningful names.
    const named = files.map((f, i) => (/^image\.\w+$/.test(f.name)
      ? new File([f], `Pasted image ${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${f.name.split('.').pop()}`, { type: f.type })
      : f));
    intake(named);
  });
}

/* ==================================================================== */
/* Dialogs                                                               */
/* ==================================================================== */

async function joinDialog() {
  const input = h('input', {
    class: 'field__input field__input--code', id: 'joinCode', type: 'text', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: false, placeholder: 'K7QM3-XRPWA', 'aria-describedby': 'joinHelp joinError', maxlength: '200',
  });
  const error = h('p', { class: 'field__error', id: 'joinError', 'aria-live': 'polite' });
  const form = h('form', { class: 'join-form', id: 'joinForm' },
    h('label', { class: 'field__label', for: 'joinCode', text: 'Room code or link' }),
    input,
    h('p', { class: 'field__help', id: 'joinHelp', text: 'Find it under the QR code on the other device.' }),
    error);
  const scanArea = h('div', { class: 'scan', hidden: true });
  const body = [form, scanArea];
  let stopScan = null;

  const submit = (e) => {
    e?.preventDefault();
    const code = parseRoomCode(input.value);
    if (!code) {
      setText(error, 'That doesn’t look like a QRShare code. It has 10 letters and numbers, like K7QM3-XRPWA.');
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    close();
    switchRoom(code);
  };
  form.addEventListener('submit', submit);
  input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); setText(error, ''); });

  const actions = [
    h('button', { class: 'btn btn--quiet', type: 'button', text: 'Cancel', onclick: () => close() }),
    h('button', { class: 'btn btn--primary', type: 'submit', form: 'joinForm' }, icon('join', { size: 18 }), 'Join room'),
  ];
  const { close } = openDialog({ title: 'Join a room', body, actions, onClose: () => stopScan?.() });
  input.focus();

  if (await scannerSupported()) {
    const video = h('video', { class: 'scan__video', playsinline: true, muted: true, 'aria-label': 'Camera preview' });
    const status = h('p', { class: 'scan__status', 'aria-live': 'polite' });
    const startBtn = h('button', { class: 'btn btn--quiet btn--block', type: 'button' }, icon('camera', { size: 18 }), 'Scan QR code with camera');
    const frame = h('div', { class: 'scan__frame', hidden: true }, video, h('span', { class: 'scan__reticle', 'aria-hidden': 'true' }));
    setChildren(scanArea, h('div', { class: 'divider', text: 'or' }), startBtn, frame, status);
    scanArea.hidden = false;
    startBtn.addEventListener('click', () => {
      startBtn.hidden = true;
      frame.hidden = false;
      setText(status, 'Point the camera at the QR code on the other device.');
      stopScan = startScanner(video, (value) => {
        stopScan?.();
        const code = parseRoomCode(value);
        if (!code) {
          setText(status, 'That QR code isn’t a QRShare room. Try again.');
          startBtn.hidden = false;
          frame.hidden = true;
          return;
        }
        close();
        switchRoom(code);
      }, (err) => {
        frame.hidden = true;
        startBtn.hidden = false;
        setText(status, err?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in the browser’s site settings, or type the code instead.'
          : 'The camera couldn’t start. Type the code instead.');
      });
    });
  }
}

function renameDialog() {
  const input = h('input', { class: 'field__input', id: 'renameInput', type: 'text', value: profile.name, maxlength: '32', autocomplete: 'off', 'aria-describedby': 'renameHelp' });
  const form = h('form', { class: 'join-form', id: 'renameForm' },
    h('label', { class: 'field__label', for: 'renameInput', text: 'Device name' }),
    input,
    h('p', { class: 'field__help', id: 'renameHelp', text: 'Others in the room see this name. It’s saved on this device only.' }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = sanitizeDisplayName(input.value);
    if (!name) { input.focus(); return; }
    profile.name = name;
    store.set('qrshare:name', name);
    session?.room.updateProfile({ name });
    session?.people.render();
    close();
    toast({ tone: 'success', title: 'Name updated', key: 'rename' });
  });
  const { close } = openDialog({
    title: 'Rename this device',
    body: form,
    actions: [
      h('button', { class: 'btn btn--quiet', type: 'button', text: 'Cancel', onclick: () => close() }),
      h('button', { class: 'btn btn--primary', type: 'submit', form: 'renameForm', text: 'Save name' }),
    ],
  });
  input.select();
}

function helpDialog() {
  const step = (title, text) => h('li', null, h('strong', { text: title }), h('span', { text }));
  const kbd = (keys, text) => h('li', null, h('span', { class: 'kbd-row' }, keys.map((k) => h('kbd', { text: k }))), h('span', { text }));
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  openDialog({
    title: 'How QRShare works',
    className: 'dialog--wide',
    body: [
      h('ol', { class: 'steps' },
        step('Open QRShare on one device.', 'You get a private room with its own QR code.'),
        step('Scan the code with another device.', 'Use the phone’s camera app, or “Join a room” here. You can also send the link.'),
        step('Send files and messages.', 'They go straight to the other device. Each file is accepted on arrival and checked for corruption.')),
      h('h3', { class: 'dialog__subtitle', text: 'Privacy' }),
      h('p', { class: 'dialog__text', text: 'Files and messages travel directly between devices over WebRTC, encrypted in transit. They’re never uploaded or stored on a server.' }),
      h('p', { class: 'dialog__text dialog__text--muted', text: 'To introduce devices, QRShare uses the public PeerJS signaling service. It sees the room code, your IP address and connection setup data, but never your files or messages. When direct paths are blocked, a TURN relay (if configured) forwards the encrypted data without being able to read it. Use “Verify” next to a device to confirm nobody is in between.' }),
      h('h3', { class: 'dialog__subtitle', text: 'Tips' }),
      h('ul', { class: 'bullets' },
        h('li', { text: 'Keep QRShare open on both devices until transfers finish. Phones may pause apps in the background.' }),
        h('li', { text: 'Connections are fastest and most reliable when both devices are on the same Wi-Fi.' }),
        h('li', { text: 'Received files live in memory until you save them or leave. Very large files need free memory and disk space on the receiving device.' })),
      h('h3', { class: 'dialog__subtitle', text: 'Keyboard' }),
      h('ul', { class: 'kbd-list' },
        kbd([mod, 'V'], 'Send files or images from the clipboard'),
        kbd(['Alt', '1–3'], 'Switch between Room, Files and Chat'),
        kbd(['Enter'], 'Send message (Shift + Enter for a new line)'),
        kbd(['Esc'], 'Close dialogs')),
    ],
  });
}

function connectionDialog() {
  if (!session) return;
  const { room } = session;
  const d = room.diagnostics();
  const row = (label, value, tone = '') => h('div', { class: 'diag__row' }, h('dt', { text: label }), h('dd', { class: tone ? `tone-${tone}` : '', text: value }));
  const routeLabel = { local: 'Direct, same network', direct: 'Direct', relay: 'Relayed (TURN)' };
  const links = [...room.links.values()];
  const dialog = openDialog({
    title: 'Connection details',
    body: [
      h('dl', { class: 'diag' },
        row('Room', formatRoomCode(session.code)),
        row('Status', el.statusText.textContent),
        row('Signaling service', d.signalOnline ? 'Reachable' : 'Unreachable, retrying', d.signalOnline ? 'ok' : 'warn'),
        row('TURN relay', d.relayConfigured ? 'Configured' : 'Not configured (direct only)'),
        ...links.map((l) => row(l.everConnected ? l.name : 'New device',
          l.status === 'connected' ? (routeLabel[l.route] || 'Connected') : l.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…',
          l.status === 'connected' ? 'ok' : 'warn'))),
      h('p', { class: 'dialog__text dialog__text--muted', text: 'Direct connections need both networks to allow peer-to-peer traffic. Corporate networks, some mobile carriers and VPNs block it. Without a TURN relay, those devices can’t connect.' }),
    ],
    actions: [
      h('button', {
        class: 'btn btn--quiet', type: 'button',
        onclick: async () => {
          dialog.close();
          if (!session) return;
          if (session.transfers.hasActiveTransfers()) {
            const ok = await confirmDialog({
              title: 'Restart while files are transferring?',
              message: 'Transfers in progress will stop. You can retry them after reconnecting.',
              confirmLabel: 'Restart', danger: true,
            });
            if (!ok || !session) return;
          }
          startRoom(session.code, { created: false });
        },
      }, icon('retry', { size: 18 }), 'Restart connection'),
    ],
  });
}

function enlargeQr() {
  if (!session) return;
  openDialog({
    title: 'Scan to join',
    className: 'dialog--qr',
    body: [
      h('div', { class: 'qr-large' }, qrSvg(session.link, { label: `QR code for room ${formatRoomCode(session.code)}` })),
      h('p', { class: 'qr-large__code', text: formatRoomCode(session.code) }),
      h('p', { class: 'dialog__text dialog__text--muted dialog__text--center', text: 'Turn up screen brightness if the other device struggles to scan.' }),
    ],
  });
}

/* ==================================================================== */
/* Room card actions                                                     */
/* ==================================================================== */

async function copyLink() {
  if (!session) return;
  const ok = await copyText(session.link);
  if (ok) {
    flashButton(el.copyLinkBtn, 'Link copied');
    toast({ tone: 'success', key: 'copy', title: 'Link copied', body: 'Send it to the other device. Anyone with the link can join.' });
  } else {
    openDialog({
      title: 'Copy this link',
      body: [
        h('p', { class: 'dialog__text', text: 'Your browser blocked automatic copying. Select the link and copy it.' }),
        h('input', { class: 'field__input', type: 'text', readOnly: true, value: session.link, onfocus: (e) => e.target.select(), 'aria-label': 'Room link' }),
      ],
    });
  }
}

function flashButton(btn, label) {
  const labelEl = btn.querySelector('span:last-child');
  const original = labelEl.textContent;
  btn.classList.add('is-confirmed');
  labelEl.textContent = label;
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => { btn.classList.remove('is-confirmed'); labelEl.textContent = original; }, 1800);
}

async function shareLink() {
  if (!session) return;
  try {
    await navigator.share({ title: 'QRShare room', text: `Join my QRShare room (code ${formatRoomCode(session.code)})`, url: session.link });
  } catch (err) {
    if (err?.name !== 'AbortError') copyLink();
  }
}

async function saveQr() {
  if (!session) return;
  try {
    const blob = await qrPngBlob(session.link);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `qrshare-${session.code}.png`, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast({ tone: 'success', key: 'saveqr', title: 'QR code saved' });
  } catch {
    toast({ tone: 'error', key: 'saveqr', title: 'Couldn’t save the QR code' });
  }
}

/* ==================================================================== */
/* Global UI                                                             */
/* ==================================================================== */

function bindGlobalUi() {
  el.joinBtn.addEventListener('click', joinDialog);
  for (const b of document.querySelectorAll('[data-action="help"]')) b.addEventListener('click', helpDialog);
  el.leaveBtn.addEventListener('click', leaveRoom);
  el.statusPill.addEventListener('click', connectionDialog);
  el.qrButton.addEventListener('click', enlargeQr);
  el.copyLinkBtn.addEventListener('click', copyLink);
  el.shareBtn.addEventListener('click', shareLink);
  el.saveQrBtn.addEventListener('click', saveQr);
  el.brandLink.addEventListener('click', (e) => { e.preventDefault(); newRoom(); });
  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) setTab(b.dataset.tab, { user: true });
  });
  bindFileIntake();

  window.addEventListener('hashchange', () => route());
  window.addEventListener('popstate', () => route());

  for (const mq of [WIDE, NARROW]) mq.addEventListener('change', () => setTab(tab));

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && ['1', '2', '3'].includes(e.key) && session) {
      e.preventDefault();
      setTab(['room', 'files', 'chat'][Number(e.key) - 1], { user: true, focus: e.key === '3' });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTab(tab);
      syncWakeLock();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (session?.transfers.hasActiveTransfers()) { e.preventDefault(); e.returnValue = ''; }
  });
  // Tell peers we're going instead of letting them time out. Restored from bfcache → rejoin.
  window.addEventListener('pagehide', () => { if (session) { session.room.leave({ fast: true }); } });
  window.addEventListener('pageshow', (e) => { if (e.persisted && session) startRoom(session.code, { created: false }); });
}

/* ---------------- theme ---------------- */

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };

function initTheme() {
  const saved = store.get('qrshare:theme');
  applyTheme(THEMES.includes(saved) ? saved : 'system');
  const cycle = () => {
    const current = document.documentElement.dataset.theme || 'system';
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    applyTheme(next);
    store.set('qrshare:theme', next);
    toast({ tone: 'info', key: 'theme', title: THEME_LABEL[next], duration: 1600 });
  };
  for (const b of document.querySelectorAll('[data-action="theme"]')) b.addEventListener('click', cycle);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
  const iconName = { system: 'system', light: 'sun', dark: 'moon' }[theme];
  for (const b of document.querySelectorAll('[data-action="theme"]')) {
    const small = b !== el.themeBtn;
    const glyph = icon(iconName, { size: small ? 16 : 20 });
    if (small) b.firstElementChild.replaceWith(glyph); else b.replaceChildren(glyph);
    b.setAttribute('aria-label', `${THEME_LABEL[theme]}. Change theme`);
  }
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const dark = meta.media.includes('dark');
    if (theme === 'system') meta.content = dark ? '#0c1124' : '#f3f5fa';
    else meta.content = theme === 'dark' ? '#0c1124' : '#f3f5fa';
  }
}

/* ---------------- full-screen states ---------------- */

function showScreen({ icon: iconName, title, text, tips = [], actions = [] }) {
  setChildren($('#screenIcon'), icon(iconName || 'info', { size: 28 }));
  setText($('#screenTitle'), title);
  setText($('#screenText'), text || '');
  const tipsEl = $('#screenTips');
  setChildren(tipsEl, tips.map((t) => h('li', { text: t })));
  tipsEl.hidden = !tips.length;
  setChildren($('#screenActions'), actions.map((a) => h('button', {
    class: `btn ${a.primary ? 'btn--primary' : 'btn--quiet'}`, type: 'button', text: a.label, onclick: a.run,
  })));
  el.screen.hidden = false;
  el.app.dataset.screen = 'on';
  requestAnimationFrame(() => $('#screenTitle').focus());
}

function hideScreen() {
  el.screen.hidden = true;
  delete el.app.dataset.screen;
}

/* ---------------- screen wake lock during transfers ---------------- */

async function syncWakeLock() {
  const want = !!session?.transfers.hasActiveTransfers() && !document.hidden;
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { wakeLock = null; /* denied (e.g. low battery): transfers still work */ }
  } else if (!want && wakeLock) {
    releaseWakeLock();
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
}

/* ---------------- service worker (offline app shell) ---------------- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast({
              tone: 'info', key: 'update', title: 'A new version of QRShare is ready', duration: 0,
              action: {
                label: 'Reload', run: async () => {
                  if (session?.transfers.hasActiveTransfers()) {
                    const ok = await confirmDialog({ title: 'Reload now?', message: 'Transfers in progress will stop.', confirmLabel: 'Reload', danger: true });
                    if (!ok) return;
                  }
                  worker.postMessage('skip-waiting');
                },
              },
            });
          }
        });
      });
    }).catch(() => { /* offline support is optional */ });
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Only reload when an *update* took over, never on the very first install.
      if (reloading || !hadController) return;
      reloading = true;
      location.reload();
    });
  });
}

function truncate(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

boot();
