/**
 * TransferManager — file offers, queueing, streaming, verification.
 *
 * Protocol (control messages are JSON, see room.js):
 *   offer   { batch, files: [{ id, num, name, size, type }] }   sender → receiver
 *   accept  { ids: [] } / decline { ids: [] }                  receiver → sender
 *   pause / resume / cancel { id }                              either side
 *   end     { id, hash }                                        sender → receiver, after the last chunk
 *   result  { id, ok }                                          receiver → sender, after verifying
 *
 * Data frames are binary: [uint32 num][payload]. `num` is unique per sender and
 * maps the frame to its transfer. The DataChannel is reliable and ordered, so
 * frames for a file arrive in order and `end` arrives after its last frame.
 *
 * Integrity: both sides SHA-256 every chunk as it passes, then SHA-256 the
 * concatenated chunk digests. The receiver compares against the sender's value
 * and reports back; the sender only shows "Delivered" after a positive result.
 */
import { Emitter } from './emitter.js';
import {
  randomString, sanitizeFileName, sanitizeMime, uniqueName, isExecutableName, isPreviewableType,
} from './util.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newId = () => randomString(12, ID_ALPHABET);
const FINAL = new Set(['done', 'failed', 'cancelled', 'declined']);
const MAX_PENDING_OFFERS_PER_PEER = 10;
export const isFinal = (t) => FINAL.has(t.status);

export class TransferManager extends Emitter {
  constructor(room, config) {
    super();
    this.room = room;
    this.cfg = config.transfer;
    /** @type {Map<string, object>} */
    this.transfers = new Map();
    /** @type {Map<string, object>} */
    this.batches = new Map();
    this.staged = [];
    this._nextNum = 1;
    this._incoming = new Map(); // `${peerId}:${num}` → transfer
    this._pumps = new Set();
    this._takenNames = new Set();
    this._unsubs = [
      room.on('message', (link, msg) => this._onMessage(link, msg)),
      room.on('binary', (link, data) => this._onBinary(link, data)),
      room.on('peer:interrupted', (link) => this._onPeerLost(link, 'Connection to the device was interrupted.')),
      room.on('peer:leave', (link) => this._onPeerLost(link, `${link.name} left the room.`, true)),
      room.on('peer:join', (link) => this._offerStaged(link)),
    ];
  }

  destroy() {
    this._unsubs.forEach((u) => u());
    for (const t of this.transfers.values()) {
      if (!isFinal(t)) t.status = 'cancelled';
      this._releaseUrls(t);
      t.parts = t.blobParts = t.hashes = null;
      t.file = null;
    }
    this.transfers.clear();
    this.batches.clear();
    this.staged = [];
    this.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  batchTransfers(batch) { return batch.ids.map((id) => this.transfers.get(id)).filter(Boolean); }

  /** Bytes moved vs. bytes expected for the batch, ignoring declined/cancelled files. */
  batchProgress(batch) {
    let bytes = 0;
    let size = 0;
    for (const t of this.batchTransfers(batch)) {
      if (t.status === 'declined' || t.status === 'cancelled') continue;
      size += t.size;
      bytes += t.status === 'done' ? t.size : t.bytes;
    }
    return { bytes, size, ratio: size ? bytes / size : 1 };
  }

  hasActiveTransfers() {
    for (const t of this.transfers.values()) if (['queued', 'active', 'verifying', 'paused'].includes(t.status)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Sending                                                             */
  /* ------------------------------------------------------------------ */

  /** Offers files to every connected device, or stages them until someone joins. */
  send(files) {
    const list = [...files];
    if (!list.length) return { offered: 0, staged: 0 };
    const peers = this.room.connectedPeers();
    if (!peers.length) {
      this.staged.push(...list);
      this.emit('staged', this.staged);
      return { offered: 0, staged: list.length };
    }
    for (const link of peers) this._offer(link, list);
    return { offered: list.length, staged: 0 };
  }

  unstage(index) {
    this.staged.splice(index, 1);
    this.emit('staged', this.staged);
  }

  _offerStaged(link) {
    if (!this.staged.length) return;
    const files = this.staged;
    this.staged = [];
    this.emit('staged', this.staged);
    this._offer(link, files);
  }

  _offer(link, files) {
    for (let i = 0; i < files.length; i += this.cfg.maxFilesPerBatch) {
      const chunk = files.slice(i, i + this.cfg.maxFilesPerBatch);
      const batch = { id: newId(), dir: 'out', peerId: link.id, peerName: link.name, ids: [], createdAt: Date.now() };
      const wire = [];
      for (const file of chunk) {
        const t = this._create({
          dir: 'out', batchId: batch.id, peerId: link.id, peerName: link.name,
          name: sanitizeFileName(file.name), size: file.size, type: sanitizeMime(file.type),
          num: this._nextNum++, file, status: 'offered',
        });
        batch.ids.push(t.id);
        wire.push({ id: t.id, num: t.num, name: t.name, size: t.size, type: t.type });
      }
      this.batches.set(batch.id, batch);
      const ok = this.room.send(link.id, { t: 'offer', batch: batch.id, files: wire });
      if (!ok) for (const t of this.batchTransfers(batch)) this._fail(t, 'Couldn’t reach the device.');
      this.emit('batch', batch);
    }
  }

  /** Re-offers a failed outgoing file as a fresh transfer to the same device. */
  retry(id) {
    const t = this.transfers.get(id);
    if (!t || t.dir !== 'out' || !t.file || !['failed', 'cancelled'].includes(t.status)) return false;
    const link = this.room.links.get(t.peerId);
    if (!link || link.status !== 'connected') return false;
    this._remove(t);
    this._offer(link, [t.file]);
    return true;
  }

  _pump(peerId) {
    if (this._pumps.has(peerId)) return;
    this._pumps.add(peerId);
    (async () => {
      try {
        for (;;) {
          const next = [...this.transfers.values()].find((t) => t.dir === 'out' && t.peerId === peerId && t.status === 'queued');
          if (!next) break;
          await this._stream(next);
        }
      } finally {
        this._pumps.delete(peerId);
      }
    })();
  }

  async _stream(t) {
    const { readBlockSize, bufferHigh } = this.cfg;
    const room = this.room;
    // Never exceed what the receiver negotiated (frame = 4-byte header + payload).
    const chunkSize = Math.max(1024, Math.min(this.cfg.chunkSize, room.maxMessageSize(t.peerId) - 4));
    this._setStatus(t, 'active');
    t.startedAt ||= performance.now();
    t.hashes ||= [];
    try {
      while (t.bytes < t.size) {
        if (t.status !== 'active') return;
        const start = t.bytes;
        let block;
        try {
          block = new Uint8Array(await t.file.slice(start, Math.min(t.size, start + readBlockSize)).arrayBuffer());
        } catch {
          room.send(t.peerId, { t: 'cancel', id: t.id });
          this._fail(t, 'Couldn’t read the file. It may have been moved, changed or deleted.');
          return;
        }
        for (let off = 0; off < block.length; off += chunkSize) {
          if (room.bufferedAmount(t.peerId) > bufferHigh) await room.waitForDrain(t.peerId);
          if (t.status !== 'active') return;
          const piece = block.subarray(off, off + chunkSize);
          const frame = new Uint8Array(4 + piece.length);
          new DataView(frame.buffer).setUint32(0, t.num);
          frame.set(piece, 4);
          if (!room.sendBinary(t.peerId, frame)) throw new Error('link closed');
          t.hashes.push(crypto.subtle.digest('SHA-256', piece));
          t.bytes += piece.length;
          this._meter(t);
        }
      }
      if (t.status !== 'active') return;
      const hash = await digestList(t.hashes);
      t.hashes = null;
      if (t.status !== 'active') return;
      if (!room.send(t.peerId, { t: 'end', id: t.id, hash })) throw new Error('link closed');
      this._setStatus(t, 'verifying');
    } catch {
      if (!isFinal(t)) this._fail(t, 'Connection lost during the transfer.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Receiving                                                           */
  /* ------------------------------------------------------------------ */

  _onOffer(link, msg) {
    if (typeof msg.batch !== 'string' || !Array.isArray(msg.files) || !msg.files.length) return;
    if (msg.files.length > this.cfg.maxFilesPerBatch || this.batches.has(msg.batch)) return;
    // Don't let one device pile up unanswered offers.
    const waiting = [...this.batches.values()].filter((b) => b.dir === 'in' && b.peerId === link.id
      && this.batchTransfers(b).some((t) => t.status === 'pending')).length;
    if (waiting >= MAX_PENDING_OFFERS_PER_PEER) {
      this.room.send(link.id, { t: 'decline', ids: msg.files.map((f) => f?.id).filter((id) => typeof id === 'string') });
      return;
    }
    const batch = { id: msg.batch.slice(0, 40), dir: 'in', peerId: link.id, peerName: link.name, ids: [], createdAt: Date.now() };
    for (const f of msg.files) {
      const valid = f && typeof f.id === 'string' && f.id.length <= 40 && Number.isSafeInteger(f.num) && f.num > 0
        && Number.isSafeInteger(f.size) && f.size >= 0 && !this.transfers.has(f.id);
      if (!valid) continue;
      const name = sanitizeFileName(f.name);
      const t = this._create({
        id: f.id, dir: 'in', batchId: batch.id, peerId: link.id, peerName: link.name,
        name, size: f.size, type: sanitizeMime(f.type), num: f.num, status: 'pending',
        executable: isExecutableName(name),
      });
      batch.ids.push(t.id);
    }
    if (!batch.ids.length) return;
    this.batches.set(batch.id, batch);
    this.emit('batch', batch);
    this.emit('offer', batch);
  }

  accept(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.dir !== 'in') return;
    const ids = [];
    for (const t of this.batchTransfers(batch)) {
      if (t.status !== 'pending') continue;
      t.parts = [];
      t.partsBytes = 0;
      t.blobParts = [];
      t.hashes = [];
      this._incoming.set(`${t.peerId}:${t.num}`, t);
      this._setStatus(t, 'queued');
      ids.push(t.id);
    }
    if (ids.length && !this.room.send(batch.peerId, { t: 'accept', ids })) {
      for (const id of ids) this._fail(this.transfers.get(id), 'Couldn’t reach the device.');
    }
  }

  decline(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.dir !== 'in') return;
    const ids = this.batchTransfers(batch).filter((t) => t.status === 'pending').map((t) => t.id);
    for (const id of ids) this._setStatus(this.transfers.get(id), 'declined');
    if (ids.length) this.room.send(batch.peerId, { t: 'decline', ids });
  }

  _onBinary(link, data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return;
    const t = this._incoming.get(`${link.id}:${new DataView(data).getUint32(0)}`);
    if (!t) return;
    if (t.status === 'queued') { this._setStatus(t, 'active'); t.startedAt ||= performance.now(); }
    if (t.status !== 'active' && t.status !== 'paused') return; // e.g. frames still in flight after cancel
    const piece = new Uint8Array(data, 4);
    if (t.bytes + piece.length > t.size) {
      this.room.send(t.peerId, { t: 'cancel', id: t.id });
      this._fail(t, 'The device sent more data than it announced.');
      return;
    }
    t.hashes.push(crypto.subtle.digest('SHA-256', piece));
    t.parts.push(piece);
    t.partsBytes += piece.length;
    t.bytes += piece.length;
    if (t.partsBytes >= this.cfg.blobFlushBytes) {
      // Hand accumulated chunks to the browser's blob store, which can page them to disk.
      t.blobParts.push(new Blob(t.parts));
      t.parts = [];
      t.partsBytes = 0;
    }
    this._meter(t);
  }

  async _onEnd(link, t, hash) {
    if (t.dir !== 'in' || (t.status !== 'active' && t.status !== 'queued' && t.status !== 'paused')) return;
    if (t.bytes !== t.size) {
      this.room.send(t.peerId, { t: 'result', id: t.id, ok: false });
      this._fail(t, 'The transfer ended before the whole file arrived.');
      return;
    }
    this._setStatus(t, 'verifying');
    const local = await digestList(t.hashes);
    t.hashes = null;
    if (t.status !== 'verifying') return;
    this._incoming.delete(`${t.peerId}:${t.num}`);
    if (local !== hash) {
      t.parts = t.blobParts = null;
      this.room.send(t.peerId, { t: 'result', id: t.id, ok: false });
      this._fail(t, 'Integrity check failed: the file was corrupted in transit.');
      return;
    }
    // Only raster images keep their type (for previews). Everything else is opaque bytes so the
    // browser can never render received content as a document in our origin.
    const type = isPreviewableType(t.type) ? t.type : 'application/octet-stream';
    t.blob = new Blob([...t.blobParts, ...t.parts], { type });
    t.parts = t.blobParts = null;
    t.url = URL.createObjectURL(t.blob);
    if (isPreviewableType(t.type) && t.size <= this.cfg.previewMaxBytes) t.previewUrl = t.url;
    t.downloadName = uniqueName(t.name, this._takenNames);
    t.finishedAt = Date.now();
    t.verified = true;
    this.room.send(t.peerId, { t: 'result', id: t.id, ok: true });
    this._setStatus(t, 'done');
    this.emit('received', t);
  }

  /* ------------------------------------------------------------------ */
  /* Control                                                             */
  /* ------------------------------------------------------------------ */

  cancel(id) {
    const t = this.transfers.get(id);
    if (!t || isFinal(t)) return;
    if (t.status === 'pending') { this.room.send(t.peerId, { t: 'decline', ids: [t.id] }); this._setStatus(t, 'declined'); return; }
    this.room.send(t.peerId, { t: 'cancel', id: t.id });
    this._cancelLocal(t);
  }

  cancelBatch(batchId) {
    const batch = this.batches.get(batchId);
    if (batch) for (const t of this.batchTransfers(batch)) this.cancel(t.id);
  }

  pause(id) {
    const t = this.transfers.get(id);
    if (!t || !['queued', 'active'].includes(t.status)) return;
    t.pausedBy = 'me';
    this._setStatus(t, 'paused');
    this.room.send(t.peerId, { t: 'pause', id: t.id });
  }

  resume(id) {
    const t = this.transfers.get(id);
    if (!t || t.status !== 'paused') return;
    t.pausedBy = null;
    this._setStatus(t, 'queued');
    this.room.send(t.peerId, { t: 'resume', id: t.id });
    if (t.dir === 'out') this._pump(t.peerId);
  }

  _cancelLocal(t) {
    this._incoming.delete(`${t.peerId}:${t.num}`);
    t.parts = t.blobParts = t.hashes = null;
    this._setStatus(t, 'cancelled');
  }

  _onMessage(link, msg) {
    const own = (id) => {
      const t = typeof id === 'string' ? this.transfers.get(id) : null;
      return t && t.peerId === link.id ? t : null;
    };
    switch (msg.t) {
      case 'offer': return this._onOffer(link, msg);
      case 'accept':
      case 'decline': {
        if (!Array.isArray(msg.ids)) return;
        for (const id of msg.ids) {
          const t = own(id);
          if (!t || t.dir !== 'out' || t.status !== 'offered') continue;
          this._setStatus(t, msg.t === 'accept' ? 'queued' : 'declined');
        }
        if (msg.t === 'accept') this._pump(link.id);
        else this.emit('declined', link, msg.ids.length);
        return;
      }
      case 'cancel': {
        const t = own(msg.id);
        if (t && !isFinal(t)) { t.error = `Cancelled by ${link.name}.`; this._cancelLocal(t); }
        return;
      }
      case 'pause': {
        const t = own(msg.id);
        if (t && ['queued', 'active'].includes(t.status)) { t.pausedBy = 'peer'; this._setStatus(t, 'paused'); }
        return;
      }
      case 'resume': {
        const t = own(msg.id);
        if (t && t.status === 'paused') {
          t.pausedBy = null;
          this._setStatus(t, 'queued');
          if (t.dir === 'out') this._pump(link.id);
        }
        return;
      }
      case 'end': {
        const t = own(msg.id);
        if (t && typeof msg.hash === 'string') this._onEnd(link, t, msg.hash);
        return;
      }
      case 'result': {
        const t = own(msg.id);
        if (!t || t.dir !== 'out' || t.status !== 'verifying') return;
        if (msg.ok === true) {
          t.verified = true;
          t.finishedAt = Date.now();
          this._setStatus(t, 'done');
          this.emit('delivered', t);
        } else {
          this._fail(t, 'The receiving device reported corrupted data. Try again.');
        }
        return;
      }
      default:
    }
  }

  _onPeerLost(link, reason, left = false) {
    for (const t of this.transfers.values()) {
      if (t.peerId !== link.id || isFinal(t)) continue;
      if (t.status === 'pending' || t.status === 'offered') {
        if (left) { t.error = reason; this._setStatus(t, 'cancelled'); }
        continue; // an offer survives a brief interruption
      }
      this._incoming.delete(`${t.peerId}:${t.num}`);
      t.parts = t.blobParts = t.hashes = null;
      this._fail(t, reason);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Housekeeping                                                        */
  /* ------------------------------------------------------------------ */

  /** Removes finished batches and frees their memory. */
  clearFinished() {
    for (const batch of [...this.batches.values()]) {
      const ts = this.batchTransfers(batch);
      if (ts.every(isFinal)) {
        ts.forEach((t) => this._remove(t, false));
        this.batches.delete(batch.id);
      }
    }
    this.emit('reset');
  }

  _create(fields) {
    const t = {
      id: fields.id || newId(), bytes: 0, speed: 0, eta: null, error: null, pausedBy: null,
      createdAt: Date.now(), startedAt: 0, finishedAt: 0, verified: false, ...fields,
    };
    if (t.dir === 'out' && isPreviewableType(t.type) && t.size <= this.cfg.previewMaxBytes) {
      t.previewUrl = URL.createObjectURL(t.file);
    }
    this.transfers.set(t.id, t);
    return t;
  }

  _remove(t, notify = true) {
    this._releaseUrls(t);
    this.transfers.delete(t.id);
    const batch = this.batches.get(t.batchId);
    if (batch) {
      batch.ids = batch.ids.filter((id) => id !== t.id);
      if (!batch.ids.length) this.batches.delete(batch.id);
    }
    if (notify) this.emit('reset');
  }

  _releaseUrls(t) {
    if (t.previewUrl && t.previewUrl !== t.url) URL.revokeObjectURL(t.previewUrl);
    if (t.url) URL.revokeObjectURL(t.url);
    t.url = t.previewUrl = null;
    t.blob = null;
  }

  _setStatus(t, status) {
    if (!t || t.status === status) return;
    t.status = status;
    if (status !== 'active') { t.speed = 0; t.eta = null; }
    this.emit('update', t);
  }

  _fail(t, reason) {
    if (!t || isFinal(t)) return;
    t.error = reason;
    this._setStatus(t, 'failed');
    this.emit('failed', t);
  }

  /** Smoothed throughput + ETA, sampled at most every 400 ms. */
  _meter(t) {
    const now = performance.now();
    if (!t._mt) { t._mt = now; t._mb = t.bytes; }
    const dt = now - t._mt;
    if (dt >= 400) {
      const inst = ((t.bytes - t._mb) / dt) * 1000;
      t.speed = t.speed ? t.speed * 0.7 + inst * 0.3 : inst;
      t._mt = now;
      t._mb = t.bytes;
      t.eta = now - t.startedAt > 2000 && t.speed > 0 ? (t.size - t.bytes) / t.speed : null;
    }
    this.emit('progress', t);
  }
}

async function digestList(promises) {
  const digests = await Promise.all(promises || []);
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => all.set(new Uint8Array(d), i * 32));
  const final = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...final].map((b) => b.toString(16).padStart(2, '0')).join('');
}
