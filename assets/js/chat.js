/**
 * ChatStore — room messages with per-recipient delivery receipts.
 *
 *   chat     { id, text }   broadcast to every connected device
 *   chat-ack { id }         returned by each recipient on receipt
 *
 * Timestamps are local (time sent / time received) so a peer's clock can't
 * reorder or misdate the conversation.
 */
import { Emitter } from './emitter.js';
import { randomString } from './util.js';

const MAX_HISTORY = 500;

export class ChatStore extends Emitter {
  constructor(room, config) {
    super();
    this.room = room;
    this.maxLength = config.chat.maxLength;
    this.messages = [];
    this._seen = new Set();
    this._unsubs = [
      room.on('message', (link, msg) => this._onMessage(link, msg)),
      room.on('peer:join', (link) => this.system(`${link.name} joined`, 'join')),
      room.on('peer:leave', (link, reason) => {
        if (reason !== 'replaced') this.system(`${link.name} ${reason === 'left' ? 'left' : 'disconnected'}`, 'leave');
      }),
    ];
  }

  destroy() {
    this._unsubs.forEach((u) => u());
    this.clear();
  }

  /** Returns an error string, or null on success. */
  send(rawText) {
    const text = String(rawText ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) return 'Type a message first.';
    if (text.length > this.maxLength) return `Messages can be up to ${this.maxLength.toLocaleString()} characters.`;
    const peers = this.room.connectedPeers();
    if (!peers.length) return 'No one else is in the room yet.';
    const msg = {
      id: randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789'),
      kind: 'text', mine: true, from: null, name: 'You', text, ts: Date.now(),
      recipients: new Set(), deliveredTo: new Set(),
    };
    for (const link of peers) if (this.room.send(link.id, { t: 'chat', id: msg.id, text })) msg.recipients.add(link.id);
    msg.status = msg.recipients.size ? 'sent' : 'failed';
    this._push(msg);
    return msg.status === 'failed' ? 'Message couldn’t be sent. Check the connection and try again.' : null;
  }

  system(text, tone = 'info') {
    this._push({ id: randomString(10), kind: 'system', tone, text, ts: Date.now() });
  }

  _onMessage(link, msg) {
    if (msg.t === 'chat') {
      if (typeof msg.id !== 'string' || msg.id.length > 40 || typeof msg.text !== 'string') return;
      const key = `${link.id}:${msg.id}`;
      if (this._seen.has(key)) return;
      this._seen.add(key);
      const text = msg.text.slice(0, this.maxLength).trim();
      if (!text) return;
      this.room.send(link.id, { t: 'chat-ack', id: msg.id });
      this._push({ id: key, kind: 'text', mine: false, from: link.id, name: link.name, text, ts: Date.now() });
      this.emit('incoming', this.messages[this.messages.length - 1]);
    } else if (msg.t === 'chat-ack') {
      const m = this.messages.find((x) => x.mine && x.id === msg.id);
      if (!m || !m.recipients.has(link.id)) return;
      m.deliveredTo.add(link.id);
      m.status = m.deliveredTo.size >= m.recipients.size ? 'delivered' : 'partial';
      this.emit('update', m);
    }
  }

  _push(msg) {
    this.messages.push(msg);
    if (this.messages.length > MAX_HISTORY) {
      const dropped = this.messages.splice(0, this.messages.length - MAX_HISTORY);
      this.emit('trim', dropped);
    }
    this.emit('add', msg);
  }
}
