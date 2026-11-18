/** File panel: staged files, offers, per-file + per-batch progress, and actions. */
import { h, setText, setChildren } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { isFinal } from '../transfer.js';
import { formatBytes, formatSpeed, formatDuration, fileKind, initials, hueFor, sleep } from '../util.js';

export function mountTransfers({ list, staged, clearBtn, transfers, room }) {
  const batchEls = new Map(); // batchId → { el, bar, summary, actions, files }
  const rowEls = new Map(); // transferId → { el, bar, meta, actions, thumb }
  const dirty = new Set();
  let frame = 0;

  const empty = h('div', { class: 'empty' },
    h('div', { class: 'empty__art', 'aria-hidden': 'true' }, icon('upload', { size: 28 })),
    h('p', { class: 'empty__title', text: 'Nothing sent yet' }),
    h('p', { class: 'empty__text', text: 'Files you send or receive show up here, with live progress.' }));

  /* ---------------- staged (no one in the room yet) ---------------- */

  function renderStaged(files) {
    staged.hidden = !files.length;
    if (!files.length) { staged.replaceChildren(); return; }
    setChildren(staged,
      h('div', { class: 'staged__head' },
        h('p', { class: 'staged__title', text: `${files.length} ${files.length === 1 ? 'file' : 'files'} ready` }),
        h('p', { class: 'staged__text', text: 'They’ll be offered to the first device that joins.' })),
      h('ul', { class: 'staged__list' }, files.map((f, i) => h('li', { class: 'chip' },
        icon(kindIcon(fileKind(f.name, f.type)), { size: 16 }),
        h('span', { class: 'chip__label', text: f.name, title: f.name }),
        h('span', { class: 'chip__meta', text: formatBytes(f.size) }),
        h('button', {
          class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': `Remove ${f.name}`,
          onclick: () => transfers.unstage(i),
        }, icon('x', { size: 14 }))))));
  }

  /* ---------------- batches ---------------- */

  function createBatch(batch) {
    const files = h('ul', { class: 'batch__files', role: 'list' });
    const summary = h('p', { class: 'batch__summary' });
    const actions = h('div', { class: 'batch__actions' });
    const bar = progressBar();
    const peer = h('span', { class: 'avatar avatar--sm', 'aria-hidden': 'true', text: initials(batch.peerName) });
    peer.style.setProperty('--hue', hueFor(batch.peerId));
    const el = h('article', { class: `batch batch--${batch.dir}`, 'aria-label': batchLabel(batch), dataset: { batch: batch.id } },
      h('header', { class: 'batch__head' },
        peer,
        h('div', { class: 'batch__who' },
          h('p', { class: 'batch__title' },
            h('span', { class: 'batch__dir', text: batch.dir === 'in' ? 'From ' : 'To ' }),
            h('strong', { text: batch.peerName })),
          summary),
        actions),
      bar.el,
      files);
    const rec = { el, bar, summary, actions, files };
    batchEls.set(batch.id, rec);
    for (const t of transfers.batchTransfers(batch)) files.append(createRow(t).el);
    list.prepend(el);
    empty.remove();
    updateBatch(batch);
  }

  function updateBatch(batch) {
    const rec = batchEls.get(batch.id);
    if (!rec) return;
    const ts = transfers.batchTransfers(batch);
    const { bytes, size, ratio } = transfers.batchProgress(batch);
    const done = ts.filter((t) => t.status === 'done').length;
    const pending = ts.some((t) => t.status === 'pending');
    const running = ts.some((t) => !isFinal(t) && t.status !== 'pending' && t.status !== 'offered');
    const allFinal = ts.every(isFinal);
    const count = `${ts.length} ${ts.length === 1 ? 'file' : 'files'}`;
    let text = `${count} · ${formatBytes(ts.reduce((s, t) => s + t.size, 0))}`;
    if (running && ts.length > 1) text = `${done} of ${ts.length} done · ${formatBytes(bytes)} of ${formatBytes(size)}`;
    else if (allFinal && done && done < ts.length) text = `${done} of ${ts.length} files ${batch.dir === 'in' ? 'received' : 'delivered'}`;
    setText(rec.summary, text);
    rec.bar.set(ratio);
    rec.bar.el.hidden = ts.length < 2 || pending || allFinal;
    rec.el.dataset.state = pending ? 'pending' : allFinal ? 'final' : 'running';

    // Batch-level actions
    const want = pending ? 'pending' : batch.dir === 'in' && done > 1 ? 'saveall' : running && ts.length > 1 ? 'cancelall' : 'none';
    if (rec.actions.dataset.mode !== want) {
      rec.actions.dataset.mode = want;
      if (want === 'pending') {
        setChildren(rec.actions,
          h('button', { class: 'btn btn--quiet btn--sm', type: 'button', text: 'Decline', onclick: () => transfers.decline(batch.id) }),
          h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => transfers.accept(batch.id) },
            icon('download', { size: 16 }), ts.length > 1 ? 'Accept all' : 'Accept'));
      } else if (want === 'saveall') {
        setChildren(rec.actions, h('button', {
          class: 'btn btn--quiet btn--sm', type: 'button', onclick: () => saveAll(batch),
        }, icon('download', { size: 16 }), 'Save all'));
      } else if (want === 'cancelall') {
        setChildren(rec.actions, h('button', {
          class: 'btn btn--quiet btn--sm', type: 'button', text: 'Cancel all', onclick: () => transfers.cancelBatch(batch.id),
        }));
      } else {
        rec.actions.replaceChildren();
      }
    }
  }

  async function saveAll(batch) {
    // Browsers may ask once to allow multiple downloads; spacing them out avoids dropped saves.
    for (const t of transfers.batchTransfers(batch)) {
      if (t.status !== 'done' || !t.url) continue;
      triggerDownload(t);
      await sleep(350);
    }
  }

  /* ---------------- rows ---------------- */

  function createRow(t) {
    const thumb = h('div', { class: 'file__thumb', 'aria-hidden': 'true' });
    const name = h('p', { class: 'file__name', text: t.name, title: t.name });
    const meta = h('p', { class: 'file__meta' });
    const warn = t.executable
      ? h('p', { class: 'file__warn' }, icon('alert', { size: 14 }), 'Program or script: open it only if you trust the sender.')
      : null;
    const bar = progressBar();
    const actions = h('div', { class: 'file__actions' });
    const el = h('li', { class: 'file' }, thumb, h('div', { class: 'file__body' }, name, meta, warn, bar.el), actions);
    const rec = { el, thumb, meta, bar, actions, mode: null, thumbMode: null };
    rowEls.set(t.id, rec);
    updateRow(t);
    return rec;
  }

  function updateRow(t) {
    const rec = rowEls.get(t.id);
    if (!rec) return;
    const prev = rec.el.dataset.status;
    rec.el.dataset.status = t.status;
    if (prev && prev !== t.status && (t.status === 'done' || t.status === 'failed')) {
      rec.el.classList.remove('just-done', 'just-failed');
      void rec.el.offsetWidth; // restart the one-shot animation
      rec.el.classList.add(t.status === 'done' ? 'just-done' : 'just-failed');
    }

    // Thumbnail: real preview for raster images, otherwise a type icon.
    const thumbMode = t.previewUrl ? 'img' : `icon:${fileKind(t.name, t.type)}`;
    if (rec.thumbMode !== thumbMode) {
      rec.thumbMode = thumbMode;
      if (t.previewUrl) {
        const img = h('img', { src: t.previewUrl, alt: '', loading: 'lazy', decoding: 'async' });
        const btn = h('button', { class: 'file__preview', type: 'button', 'aria-label': `Preview ${t.name}`, onclick: () => preview(t) }, img);
        rec.thumb.removeAttribute('aria-hidden');
        setChildren(rec.thumb, btn);
      } else {
        rec.thumb.setAttribute('aria-hidden', 'true');
        setChildren(rec.thumb, icon(kindIcon(fileKind(t.name, t.type)), { size: 20 }));
      }
    }

    setText(rec.meta, statusText(t, room));
    rec.meta.dataset.tone = t.status === 'failed' ? 'error' : t.status === 'done' ? 'success' : '';
    const showBar = ['active', 'paused', 'verifying', 'queued'].includes(t.status) && t.size > 0;
    rec.bar.el.hidden = !showBar;
    rec.bar.set(t.size ? t.bytes / t.size : 0);
    rec.bar.el.dataset.state = t.status;

    const mode = actionMode(t, room);
    if (rec.mode !== mode) {
      rec.mode = mode;
      setChildren(rec.actions, actionButtons(t, mode));
    }
  }

  function actionButtons(t, mode) {
    const btn = (name, label, onclick, cls = '') => h('button', {
      class: `icon-btn ${cls}`.trim(), type: 'button', 'aria-label': `${label} ${t.name}`, title: label, onclick,
    }, icon(name, { size: 18 }));
    switch (mode) {
      case 'running': return [btn('pause', 'Pause', () => transfers.pause(t.id)), btn('x', 'Cancel', () => transfers.cancel(t.id))];
      case 'paused': return [btn('play', 'Resume', () => transfers.resume(t.id)), btn('x', 'Cancel', () => transfers.cancel(t.id))];
      case 'withdraw': return [btn('x', 'Cancel', () => transfers.cancel(t.id))];
      case 'save': return [h('a', {
        class: 'btn btn--quiet btn--sm', href: t.url, download: t.downloadName, 'aria-label': `Save ${t.name}`,
      }, icon('download', { size: 16 }), 'Save')];
      case 'retry': return [btn('retry', 'Retry', () => transfers.retry(t.id))];
      case 'delivered': return [h('span', { class: 'file__ok', title: 'Delivered and verified' }, icon('check', { size: 18 }))];
      default: return [];
    }
  }

  function preview(t) {
    const img = h('img', { class: 'preview__img', src: t.previewUrl, alt: t.name });
    openDialog({
      title: t.name,
      className: 'dialog--preview',
      body: img,
      actions: t.dir === 'in' && t.url
        ? [h('a', { class: 'btn btn--primary', href: t.url, download: t.downloadName }, icon('download', { size: 18 }), 'Save')]
        : [],
    });
  }

  /* ---------------- scheduling ---------------- */

  function schedule(t) {
    dirty.add(t.id);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function flush() {
    frame = 0;
    const touched = new Set();
    for (const id of dirty) {
      const t = transfers.transfers.get(id);
      if (!t) continue;
      updateRow(t);
      touched.add(t.batchId);
    }
    dirty.clear();
    for (const id of touched) { const b = transfers.batches.get(id); if (b) updateBatch(b); }
    updateClear();
  }

  function rebuild() {
    for (const [, rec] of batchEls) rec.el.remove();
    batchEls.clear();
    rowEls.clear();
    const batches = [...transfers.batches.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const b of batches) createBatch(b);
    if (!batches.length) list.append(empty);
    updateClear();
  }

  function updateClear() {
    const any = [...transfers.batches.values()].some((b) => transfers.batchTransfers(b).every(isFinal));
    clearBtn.hidden = !any;
  }

  function refreshAll() {
    for (const t of transfers.transfers.values()) dirty.add(t.id);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  clearBtn.addEventListener('click', onClear);
  function onClear() { transfers.clearFinished(); }

  const unsubs = [
    transfers.on('batch', createBatch),
    transfers.on('update', schedule),
    transfers.on('progress', schedule),
    transfers.on('reset', rebuild),
    transfers.on('staged', renderStaged),
    // Peer names and reachability affect labels and retry buttons.
    room.on('peer:update', refreshAll),
    room.on('peer:join', refreshAll),
    room.on('peer:leave', refreshAll),
  ];
  rebuild();
  renderStaged(transfers.staged);

  return () => {
    unsubs.forEach((u) => u());
    cancelAnimationFrame(frame);
    clearBtn.removeEventListener('click', onClear);
    list.replaceChildren();
    staged.replaceChildren();
    staged.hidden = true;
  };
}

/* -------------------------------------------------------------------- */

function progressBar() {
  const fill = h('span', { class: 'bar__fill' });
  const el = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  let last = -1;
  return {
    el,
    set(ratio) {
      const r = Math.max(0, Math.min(1, ratio || 0));
      if (Math.abs(r - last) < 0.001) return;
      last = r;
      fill.style.transform = `scaleX(${r})`;
      el.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    },
  };
}

function kindIcon(kind) {
  return { image: 'image', video: 'video', audio: 'audio', archive: 'archive', doc: 'doc', code: 'code' }[kind] || 'file';
}

function batchLabel(batch) {
  return batch.dir === 'in' ? `Files from ${batch.peerName}` : `Files to ${batch.peerName}`;
}

function peerName(t, room) {
  return room.links.get(t.peerId)?.name || t.peerName;
}

function statusText(t, room) {
  const size = formatBytes(t.size);
  const who = peerName(t, room);
  switch (t.status) {
    case 'pending': return `${size} · Waiting for you to accept`;
    case 'offered': return `${size} · Waiting for ${who} to accept`;
    case 'queued': return `${size} · ${t.bytes ? 'Resuming…' : 'Queued'}`;
    case 'active': {
      const parts = [`${formatBytes(t.bytes)} of ${size}`];
      if (t.speed) parts.push(formatSpeed(t.speed));
      if (t.eta != null) parts.push(`${formatDuration(t.eta)} left`);
      return parts.join(' · ');
    }
    case 'paused': return `${formatBytes(t.bytes)} of ${size} · Paused by ${t.pausedBy === 'me' ? 'you' : who}`;
    case 'verifying': return `${size} · Verifying…`;
    case 'done': return t.dir === 'in' ? `${size} · Received and verified` : `${size} · Delivered and verified`;
    case 'declined': return t.dir === 'in' ? `${size} · Declined` : `${size} · ${who} declined`;
    case 'cancelled': return `${size} · ${t.error || 'Cancelled'}`;
    case 'failed': return t.error || 'Transfer failed';
    default: return size;
  }
}

function actionMode(t, room) {
  const connected = room.links.get(t.peerId)?.status === 'connected';
  switch (t.status) {
    case 'queued':
    case 'active': return 'running';
    case 'paused': return 'paused';
    case 'offered': return 'withdraw';
    case 'done': return t.dir === 'in' ? (t.url ? 'save' : 'none') : 'delivered';
    case 'failed':
    case 'cancelled': return t.dir === 'out' && t.file && connected ? 'retry' : 'none';
    default: return 'none';
  }
}

function triggerDownload(t) {
  const a = h('a', { href: t.url, download: t.downloadName, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}
