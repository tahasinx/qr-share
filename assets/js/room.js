/**
 * RoomSession — peer discovery, mesh links, liveness and recovery.
 *
 * Topology
 *  - Every device opens an *identity* peer with a random ID. All real traffic
 *    (chat, files) flows over direct links between identity peers (full mesh).
 *  - One member also holds the room *beacon*: a peer whose ID is derived from
 *    the room code. Newcomers connect to the beacon only to receive the member
 *    list, then link to every member directly. If the beacon holder leaves,
 *    a remaining member claims the beacon so the room stays joinable.
 *
 * Wire format (PeerJS "raw" serialization, i.e. the bare RTCDataChannel):
 *  - string  → JSON control message `{ t: <type>, ... }`
 *  - binary  → file data frame (see transfer.js)
 */
import { Emitter } from './emitter.js';
import { randomString, sleep, sanitizeDisplayName } from './util.js';

const PROTOCOL_VERSION = 1;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BEACON_PREFIX = 'qrshare-r-';
const DEVICE_PREFIX = 'qrshare-d-';

const CONNECT_TIMEOUT_MS = 20_000;
const SIGNAL_OPEN_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const LIVENESS_TIMEOUT_MS = 25_000;
const LIVENESS_TIMEOUT_AWAY_MS = 150_000; // background tabs get their timers throttled to ~1/min
const RECONNECT_WINDOW_MS = 30_000;
const MAX_CONTROL_MESSAGE = 256 * 1024;
const FATAL_SIGNAL_ERRORS = new Set(['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable']);

const beaconIdFor = (code) => BEACON_PREFIX + code.toLowerCase();

export class RoomSession extends Emitter {
  /**
   * @param {{ code: string, config: object, profile: {name: string, device: string}, deviceKey: string }} opts
   */
  constructor({ code, config, profile, deviceKey }) {
    super();
    this.code = code;
    this.config = config;
    this.profile = { ...profile };
    this.deviceKey = deviceKey;
    this.beaconId = beaconIdFor(code);
    /** @type {Map<string, Link>} */
    this.links = new Map();
    this.state = 'idle';
    this.stateDetail = null;
    this.signalOnline = false;
    this.isBeacon = false;
    this.relayAvailable = false;
    this.selfId = null;

    this._identity = null;
    this._beacon = null;
    this._joined = false;
    this._joinAttempts = 0;
    this._closed = false;
    this._away = document.hidden;
    this._timers = new Set();
    this._heartbeat = null;
    this._signalRetry = 0;
    this._beaconRetry = 0;
    this._onVisibility = () => this._handleVisibility();
    this._onOnline = () => this._reconnectSignaling(true);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start() {
    if (typeof window.Peer !== 'function' || typeof RTCPeerConnection !== 'function') {
      return this._fail('unsupported');
    }
    this._setState('connecting');
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('online', this._onOnline);

    this.iceServers = await this._resolveIceServers();
    if (this._closed) return;
    this.relayAvailable = this.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

    try {
      await this._openIdentity();
    } catch (err) {
      if (!this._closed) this._fail('signaling', err?.type || String(err));
      return;
    }
    if (this._closed) return;
    this._heartbeat = setInterval(() => this._tick(), HEARTBEAT_MS);
    // Claiming first is fast either way: success means the room is empty (we keep it),
    // an immediate "unavailable-id" means someone is here, so we ask them who's in the room.
    this._claimBeacon();
  }

  /** Leaves the room: tells peers, closes every connection, removes listeners. */
  async leave({ fast = false } = {}) {
    if (this._closed) return;
    this._closed = true;
    for (const link of this.links.values()) this._sendRaw(link, { t: 'bye' });
    if (!fast) await sleep(120); // let "bye" flush before tearing down transports
    this._teardown();
    this._setState('closed');
  }

  _teardown() {
    clearInterval(this._heartbeat);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('online', this._onOnline);
    for (const link of this.links.values()) {
      clearTimeout(link.reconnectTimer);
      try { link.conn?.close(); } catch { /* already closed */ }
    }
    this.links.clear();
    try { this._probe?.close(); } catch { /* ignore */ }
    try { this._beacon?.destroy(); } catch { /* ignore */ }
    try { this._identity?.destroy(); } catch { /* ignore */ }
    this._beacon = null;
    this._identity = null;
  }

  /** Diagnostic trace, only when CONFIG.debug is on (automated tests). */
  _debug(...args) {
    if (this.config.debug) console.debug('[qrshare]', Math.round(performance.now()), ...args);
  }

  _later(fn, ms) {
    const t = setTimeout(() => { this._timers.delete(t); if (!this._closed) fn(); }, ms);
    this._timers.add(t);
    return t;
  }

  _setState(state, detail = null) {
    this.state = state;
    this.stateDetail = detail;
    this.emit('state', state, detail);
  }

  _fail(reason, detail) {
    this._closed = true;
    this._teardown();
    this._setState('failed', { reason, detail });
  }

  /* ------------------------------------------------------------------ */
  /* Signaling                                                           */
  /* ------------------------------------------------------------------ */

  async _resolveIceServers() {
    const base = [...(this.config.iceServers || [])];
    if (!this.config.iceServersUrl) return base;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(this.config.iceServersUrl, { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const extra = await res.json();
      if (Array.isArray(extra)) return base.concat(extra.filter((s) => s && s.urls));
      throw new Error('unexpected response');
    } catch (err) {
      this.emit('notice', 'relay-unavailable', String(err?.message || err));
      return base;
    }
  }

  _peerOptions() {
    return { debug: 0, ...(this.config.signaling || {}), config: { iceServers: this.iceServers } };
  }

  _openIdentity(attempt = 0) {
    return new Promise((resolve, reject) => {
      const id = DEVICE_PREFIX + randomString(16, ID_ALPHABET);
      const peer = new window.Peer(id, this._peerOptions());
      this._identity = peer;
      let opened = false;
      // A blocked WebSocket (firewall, proxy, CSP) can fail silently; don't wait forever.
      const openTimer = setTimeout(() => {
        if (opened || this._closed) return;
        try { peer.destroy(); } catch { /* ignore */ }
        reject({ type: 'timeout' });
      }, SIGNAL_OPEN_TIMEOUT_MS);

      peer.on('open', () => {
        this.signalOnline = true;
        this._signalRetry = 0;
        this.emit('signal', true);
        if (!opened) {
          opened = true;
          clearTimeout(openTimer);
          this.selfId = id;
          resolve();
        } else if (this._isAlone() && !this._beacon) {
          this._claimBeacon(); // re-registered after an outage while alone: make sure we're findable
        }
      });
      peer.on('connection', (conn) => this._acceptConnection(conn));
      peer.on('disconnected', () => {
        if (this._closed || peer.destroyed) return;
        this.signalOnline = false;
        this.emit('signal', false);
        this._reconnectSignaling();
      });
      peer.on('error', (err) => {
        if (this._closed) return;
        const type = err?.type;
        if (!opened) {
          clearTimeout(openTimer);
          try { peer.destroy(); } catch { /* ignore */ }
          if (type === 'unavailable-id' && attempt < 3) {
            this._openIdentity(attempt + 1).then(resolve, reject);
          } else {
            reject(err);
          }
          return;
        }
        if (type === 'peer-unavailable') {
          const missing = /peer (\S+)/.exec(err.message || '')?.[1];
          if (missing) this._handlePeerUnavailable(missing);
        } else if (FATAL_SIGNAL_ERRORS.has(type)) {
          this._fail('signaling', type);
        }
        // network/socket errors are followed by "disconnected" and handled there
      });
      peer.on('close', () => {
        if (!this._closed && peer === this._identity) this._fail('signaling', 'closed');
      });
    });
  }

  _reconnectSignaling(immediate = false) {
    const peer = this._identity;
    if (!peer || peer.destroyed || !peer.disconnected || this._closed) return;
    clearTimeout(this._signalTimer);
    const delay = immediate ? 0 : Math.min(30_000, 1000 * 2 ** this._signalRetry++);
    this._signalTimer = this._later(() => {
      if (peer.disconnected && !peer.destroyed) {
        try { peer.reconnect(); } catch { /* retried on next disconnected event */ }
        this._later(() => this._reconnectSignaling(), 8000);
      }
    }, delay);
    if (this._beacon?.disconnected && !this._beacon.destroyed) {
      this._later(() => { try { this._beacon?.reconnect(); } catch { /* ignore */ } }, delay);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Joining & the beacon                                                */
  /* ------------------------------------------------------------------ */

  _join() {
    this._debug('join: probing beacon', { isBeacon: this.isBeacon, probing: !!this._probe });
    if (this._closed || this.isBeacon || this._probe) return;
    this._joinAttempts++;
    const conn = this._identity.connect(this.beaconId, {
      reliable: true,
      serialization: 'raw',
      metadata: { probe: true, v: PROTOCOL_VERSION },
    });
    if (!conn) return;
    this._probe = conn;
    let done = false;
    let ask = null;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      clearInterval(ask);
      try { conn.close(); } catch { /* ignore */ }
      if (this._probe === conn) this._probe = null;
    };
    const timer = this._later(() => {
      if (done) return;
      finish();
      // The beacon exists (its ID is registered) but we can't reach it peer-to-peer.
      if (this._joined || !this._isAlone()) return;
      if (this._joinAttempts < 3) this._later(() => this._join(), 1000);
      else this._fail('unreachable');
    }, PROBE_TIMEOUT_MS);

    conn.on('open', () => {
      this._debug('probe open', conn.connectionId);
      // The very first message on a fresh channel is occasionally lost in the open race,
      // so keep asking until the roster arrives instead of relying on a single push.
      const request = () => this._sendOn(conn, { t: 'roster?' });
      request();
      ask = setInterval(() => { if (!done) request(); }, 800);
    });
    conn.on('close', () => this._debug('probe closed', conn.connectionId, { done }));
    conn.on('data', (raw) => {
      const msg = parseControl(raw);
      if (!msg || msg.t !== 'roster' || done) return;
      finish();
      if (msg.full && !this._joined) { this._fail('full'); return; }
      this._joined = true;
      this._joinAttempts = 0;
      this._beaconRetry = 0;
      const members = Array.isArray(msg.peers)
        ? msg.peers.filter((p) => typeof p === 'string' && p.length <= 64 && p.startsWith(DEVICE_PREFIX)).slice(0, this.config.maxPeers)
        : [];
      for (const id of members) if (id !== this.selfId) this._connectTo(id);
      if (this.state !== 'online') this._setState('online');
    });
    conn.on('error', () => { /* covered by timeout / peer-unavailable */ });
    this._probeFinish = finish;
  }

  _claimBeacon() {
    this._debug('claim beacon', { has: !!this._beacon });
    if (this._beacon || this._closed) return;
    const peer = new window.Peer(this.beaconId, this._peerOptions());
    this._beacon = peer;
    peer.on('open', () => {
      if (this._closed) return;
      this._beaconRetry = 0;
      if (!this.isBeacon) {
        this.isBeacon = true;
        this._joined = true;
        this.broadcast({ t: 'presence', beacon: true });
        this.emit('beacon', true);
      }
      if (this.state !== 'online') this._setState('online');
    });
    peer.on('connection', (conn) => this._serveRoster(conn));
    peer.on('disconnected', () => {
      if (!this._closed && !peer.destroyed) this._later(() => { try { peer.reconnect(); } catch { /* ignore */ } }, 2000);
    });
    peer.on('error', (err) => {
      this._debug('beacon error', err?.type);
      if (this._closed || peer !== this._beacon) return;
      if (err?.type === 'unavailable-id') {
        // Someone else holds the beacon. Drop ours and ask the holder who's in the room. When we were
        // already in the room this also merges the two groups if the room ever split during an outage.
        try { peer.destroy(); } catch { /* ignore */ }
        this._beacon = null;
        if (this.isBeacon) { this.isBeacon = false; this.emit('beacon', false); }
        if (this._beaconRetry++ < 5) this._later(() => this._join(), this._joined ? 500 : 0);
        else if (!this._joined) this._fail('unreachable');
      }
    });
  }

  _serveRoster(conn) {
    this._debug('beacon: incoming probe', conn.peer);
    let closer = null;
    const reply = () => {
      const peers = [this.selfId, ...[...this.links.values()].filter((l) => l.status === 'connected').map((l) => l.id)];
      const full = peers.length >= this.config.maxPeers;
      this._sendOn(conn, { t: 'roster', v: PROTOCOL_VERSION, peers: full ? [] : peers, full });
      // Probes are short-lived; close a few seconds after the last request.
      clearTimeout(closer);
      closer = setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 4000);
    };
    conn.on('open', () => { this._debug('beacon: probe open'); reply(); });
    conn.on('data', (raw) => { if (parseControl(raw)?.t === 'roster?') reply(); });
    conn.on('close', () => clearTimeout(closer));
  }

  _handlePeerUnavailable(id) {
    this._debug('peer unavailable', id);
    if (id === this.beaconId) {
      // The beacon holder vanished between our claim and our probe. Try to take over.
      this._probeFinish?.();
      this._later(() => this._claimBeacon(), 200 + Math.random() * 600);
      return;
    }
    const link = this.links.get(id);
    if (link) this._removeLink(link, 'lost');
  }

  _isAlone() {
    for (const l of this.links.values()) if (l.status !== 'failed') return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Mesh links                                                          */
  /* ------------------------------------------------------------------ */

  _ensureLink(id) {
    let link = this.links.get(id);
    if (!link) {
      link = {
        id,
        name: 'Connecting…',
        device: 'computer',
        key: null,
        status: 'connecting',
        everConnected: false,
        away: false,
        beacon: false,
        route: null,
        safetyCode: null,
        conn: null,
        dc: null,
        lastSeen: Date.now(),
        lostAt: 0,
        attempts: 0,
        reconnectTimer: null,
      };
      this.links.set(id, link);
    }
    return link;
  }

  _connectTo(id) {
    if (this._closed || id === this.selfId) return;
    const existing = this.links.get(id);
    if (existing?.conn && (existing.conn.open || existing.status === 'connecting' && existing.connInitiator)) return;
    const link = this._ensureLink(id);
    link.attempts++;
    const conn = this._identity.connect(id, { reliable: true, serialization: 'raw', metadata: { v: PROTOCOL_VERSION } });
    if (conn) this._attach(link, conn, true);
  }

  _acceptConnection(conn) {
    if (this._closed) { try { conn.close(); } catch { /* ignore */ } return; }
    if (conn.metadata?.probe) { try { conn.close(); } catch { /* ignore */ } return; }
    const id = conn.peer;
    const existing = this.links.get(id);
    if (existing?.conn && existing.conn !== conn) {
      const current = existing.conn;
      // Simultaneous dials: both sides keep the connection dialed by the smaller ID.
      // An incoming dial replacing an earlier incoming one means the peer restarted the link.
      const keepIncoming = !existing.connInitiator || id < this.selfId || !current.open && existing.status !== 'connecting';
      if (!keepIncoming) { try { conn.close(); } catch { /* ignore */ } return; }
      existing.conn = null;
      try { current.close(); } catch { /* ignore */ }
    }
    const connected = [...this.links.values()].filter((l) => l.status === 'connected' && l.id !== id).length;
    if (!existing && connected + 1 >= this.config.maxPeers) {
      conn.on('open', () => { this._sendOn(conn, { t: 'bye', reason: 'full' }); setTimeout(() => conn.close(), 500); });
      return;
    }
    this._attach(this._ensureLink(id), conn, false);
  }

  _attach(link, conn, initiator) {
    this._debug(initiator ? 'dial' : 'accept', link.id, conn.connectionId);
    link.conn = conn;
    link.connInitiator = initiator;
    link.dc = null;
    const timeout = setTimeout(() => {
      const pc = conn.peerConnection;
      this._debug('connect timeout', link.id, { ice: pc?.iceConnectionState, sig: pc?.signalingState, gather: pc?.iceGatheringState, dc: conn.dataChannel?.readyState });
      if (link.conn === conn && !conn.open) this._connFailed(link, conn);
    }, CONNECT_TIMEOUT_MS);

    const onOpen = () => {
      this._debug('link open', link.id);
      clearTimeout(timeout);
      if (link.conn !== conn) return;
      link.dc = conn.dataChannel;
      link.dc.bufferedAmountLowThreshold = this.config.transfer.bufferLow;
      link.lastSeen = Date.now();
      link.attempts = 0;
      clearTimeout(link.reconnectTimer);
      link.gotHello = false;
      this._sendHello(link);
      // Repeat until the other side's hello arrives (the first message can be lost in the open race).
      const resend = setInterval(() => {
        if (link.conn !== conn || !conn.open || link.gotHello || this._closed) { clearInterval(resend); return; }
        this._sendHello(link);
      }, 1000);
      this._inspectTransport(link);
    };
    if (conn.open) onOpen(); else conn.on('open', onOpen);
    conn.on('data', (data) => {
      if (link.conn === conn) this._onData(link, data);
    });
    conn.on('close', () => { clearTimeout(timeout); if (link.conn === conn) this._connClosed(link); });
    conn.on('error', () => { if (link.conn === conn && !conn.open) { clearTimeout(timeout); this._connFailed(link, conn); } });
    conn.on('iceStateChanged', (s) => {
      if (link.conn === conn && (s === 'connected' || s === 'completed')) this._inspectTransport(link); });
  }

  _connFailed(link, conn) {
    try { conn.close(); } catch { /* ignore */ }
    if (link.conn !== conn) return;
    link.conn = null;
    link.dc = null;
    if (this._closed) return;
    if (link.everConnected) { this._connClosed(link); return; }
    if (link.connInitiator && link.attempts < 2) { this._later(() => this._connectTo(link.id), 1500); return; }
    this._removeLink(link, 'failed');
  }

  _connClosed(link) {
    link.conn = null;
    link.dc = null;
    if (this._closed || !this.links.has(link.id)) return;
    if (link.byeReceived || !link.everConnected) { this._removeLink(link, link.byeReceived ? 'left' : 'failed'); return; }
    if (link.status !== 'reconnecting') {
      link.status = 'reconnecting';
      link.lostAt = Date.now();
      this.emit('peer:update', link);
      this.emit('peer:interrupted', link);
    }
    if (link.beacon) {
      // Keeper of the room is gone; one of us should take over so newcomers can still join.
      this._later(() => { if (!this._beacon) this._claimBeacon(); }, 200 + Math.random() * 1500);
    }
    this._scheduleReconnect(link);
  }

  _scheduleReconnect(link) {
    clearTimeout(link.reconnectTimer);
    const elapsed = Date.now() - link.lostAt;
    if (elapsed > RECONNECT_WINDOW_MS) { this._removeLink(link, 'lost'); return; }
    // Only the smaller ID redials so the two sides don't race each other; the other side waits.
    const delay = Math.min(8000, 1000 * 2 ** Math.min(link.attempts, 3));
    link.reconnectTimer = this._later(() => {
      if (link.status !== 'reconnecting') return;
      if (this.selfId < link.id && this.signalOnline) this._connectTo(link.id);
      this._scheduleReconnect(link);
    }, delay);
  }

  _removeLink(link, reason) {
    clearTimeout(link.reconnectTimer);
    if (!this.links.has(link.id)) return;
    this.links.delete(link.id);
    const conn = link.conn;
    link.conn = null;
    link.dc = null;
    try { conn?.close(); } catch { /* ignore */ }
    if (link.everConnected) this.emit('peer:leave', link, reason);
    else if (reason === 'failed') this.emit('peer:failed', link);
    if (link.beacon && !this._beacon) this._later(() => this._claimBeacon(), 200 + Math.random() * 1500);
    if (this._isAlone() && !this.isBeacon && !this._closed) this._later(() => { if (this._isAlone() && !this.isBeacon) this._claimBeacon(); }, 2500);
  }

  async _inspectTransport(link) {
    const pc = link.conn?.peerConnection;
    if (!pc) return;
    try {
      if (!link.safetyCode) link.safetyCode = await safetyCodeFor(pc);
      link.route = await routeFor(pc);
      this.emit('peer:update', link);
    } catch { /* stats are best-effort */ }
  }

  /* ------------------------------------------------------------------ */
  /* Messages                                                            */
  /* ------------------------------------------------------------------ */

  _sendHello(link, ack = false) {
    this._sendRaw(link, {
      t: 'hello',
      ack,
      v: PROTOCOL_VERSION,
      name: this.profile.name,
      device: this.profile.device,
      key: this.deviceKey,
      beacon: this.isBeacon,
      away: this._away,
    });
  }

  _onData(link, data) {
    link.lastSeen = Date.now();
    if (typeof data !== 'string') {
      if (link.status === 'connected') this.emit('binary', link, data);
      return;
    }
    const msg = parseControl(data);
    if (!msg) return;
    switch (msg.t) {
      case 'hello': return this._onHello(link, msg);
      case 'roster?':
        return; // only the beacon answers these (see _serveRoster)
      case 'ping':
        if (msg.probe) this._sendRaw(link, { t: 'pong' });
        return;
      case 'pong': return;
      case 'presence':
        if (typeof msg.away === 'boolean') link.away = msg.away;
        if (typeof msg.beacon === 'boolean') link.beacon = msg.beacon;
        this.emit('peer:update', link);
        return;
      case 'bye':
        link.byeReceived = true;
        if (msg.reason === 'full' && !link.everConnected) this.emit('notice', 'peer-full');
        return;
      default:
        if (link.status === 'connected') this.emit('message', link, msg);
    }
  }

  _onHello(link, msg) {
    const first = !link.gotHello;
    link.gotHello = true;
    // Answer a first hello so the other side learns about us even if our own first hello was lost.
    if (first && !msg.ack) this._sendHello(link, true);
    link.name = sanitizeDisplayName(msg.name) || 'Unnamed device';
    link.device = ['phone', 'tablet', 'computer'].includes(msg.device) ? msg.device : 'computer';
    link.away = !!msg.away;
    link.beacon = !!msg.beacon;
    link.protocol = msg.v;
    if (typeof msg.key === 'string' && msg.key) {
      // Same browser tab reloaded: retire its stale link without waiting for the liveness timeout.
      // Keys are visible to everyone in the room, so a live device is never evicted on a key match
      // alone: it gets a probe and is only removed if it stays silent.
      for (const other of this.links.values()) {
        if (other === link || other.key !== msg.key.slice(0, 64)) continue;
        if (other.status !== 'connected') { this._removeLink(other, 'replaced'); continue; }
        const probedAt = Date.now();
        this._sendRaw(other, { t: 'ping', probe: true });
        this._later(() => { if (this.links.get(other.id) === other && other.lastSeen < probedAt) this._removeLink(other, 'replaced'); }, 3000);
      }
      link.key = msg.key.slice(0, 64);
    }
    const resumed = link.status === 'reconnecting';
    link.status = 'connected';
    link.lostAt = 0;
    if (!link.everConnected) {
      link.everConnected = true;
      this._joined = true;
      if (this.state !== 'online') this._setState('online');
      this.emit('peer:join', link);
    } else {
      this.emit('peer:update', link);
      if (resumed) this.emit('peer:resumed', link);
    }
  }

  _sendOn(conn, obj) {
    try {
      if (conn?.dataChannel?.readyState === 'open') { conn.dataChannel.send(JSON.stringify(obj)); return true; }
    } catch { /* channel closed underneath us */ }
    return false;
  }

  _sendRaw(link, obj) { return this._sendOn(link.conn, obj); }

  /** Sends a control message to one connected peer. Returns false if it could not be queued. */
  send(peerId, obj) {
    const link = this.links.get(peerId);
    return !!link && link.status === 'connected' && this._sendRaw(link, obj);
  }

  sendBinary(peerId, buffer) {
    const link = this.links.get(peerId);
    if (!link || link.status !== 'connected' || link.dc?.readyState !== 'open') return false;
    try { link.dc.send(buffer); return true; } catch { return false; }
  }

  broadcast(obj) {
    let n = 0;
    for (const link of this.links.values()) if (link.status === 'connected' && this._sendRaw(link, obj)) n++;
    return n;
  }

  /** Largest message the peer accepts (from SCTP negotiation); 64 KiB if the browser doesn't say. */
  maxMessageSize(peerId) {
    const size = this.links.get(peerId)?.conn?.peerConnection?.sctp?.maxMessageSize;
    return Number.isFinite(size) && size > 0 ? size : 64 * 1024;
  }

  bufferedAmount(peerId) {
    return this.links.get(peerId)?.dc?.bufferedAmount ?? 0;
  }

  /** Resolves once the peer's send buffer drains below the low-water mark; rejects if the link drops. */
  waitForDrain(peerId) {
    const link = this.links.get(peerId);
    const dc = link?.dc;
    if (!dc || dc.readyState !== 'open') return Promise.reject(new Error('link closed'));
    if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (ok) => {
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
        clearInterval(poll);
        ok ? resolve() : reject(new Error('link closed'));
      };
      const onLow = () => done(true);
      const onClose = () => done(false);
      // Some engines occasionally skip bufferedamountlow; poll as a safety net.
      const poll = setInterval(() => {
        if (dc.readyState !== 'open' || link.dc !== dc) done(false);
        else if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) done(true);
      }, 250);
      dc.addEventListener('bufferedamountlow', onLow);
      dc.addEventListener('close', onClose);
    });
  }

  updateProfile(profile) {
    this.profile = { ...this.profile, ...profile };
    for (const link of this.links.values()) if (link.status === 'connected') this._sendHello(link);
  }

  connectedPeers() {
    return [...this.links.values()].filter((l) => l.status === 'connected');
  }

  /* ------------------------------------------------------------------ */
  /* Liveness                                                            */
  /* ------------------------------------------------------------------ */

  _tick() {
    const now = Date.now();
    for (const link of this.links.values()) {
      if (!link.dc || link.dc.readyState !== 'open') continue;
      this._sendRaw(link, { t: 'ping' });
      if (this._away) continue; // our own timers are throttled while hidden; don't judge others
      const limit = link.away ? LIVENESS_TIMEOUT_AWAY_MS : LIVENESS_TIMEOUT_MS;
      if (link.status === 'connected' && now - link.lastSeen > limit) {
        const conn = link.conn;
        link.conn = null;
        try { conn?.close(); } catch { /* ignore */ }
        this._connClosed(link);
      }
    }
  }

  _handleVisibility() {
    this._away = document.hidden;
    this.broadcast({ t: 'presence', away: this._away });
    if (!this._away) {
      const now = Date.now();
      for (const link of this.links.values()) link.lastSeen = now; // grace period after waking
      this._reconnectSignaling(true);
    }
  }

  diagnostics() {
    return {
      selfId: this.selfId,
      state: this.state,
      signalOnline: this.signalOnline,
      isBeacon: this.isBeacon,
      relayConfigured: this.relayAvailable,
      links: [...this.links.values()].map((l) => ({ name: l.name, status: l.status, route: l.route })),
    };
  }
}

/* -------------------------------------------------------------------- */

function parseControl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_CONTROL_MESSAGE) return null;
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg === 'object' && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

/** Describes how the selected ICE candidate pair routes traffic. */
async function routeFor(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair) stats.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s; });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  const remote = stats.get(pair.remoteCandidateId);
  if (!local || !remote) return null;
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay';
  if (local.candidateType === 'host' && remote.candidateType === 'host') return 'local';
  return 'direct';
}

/**
 * A short code derived from both DTLS certificate fingerprints. Both ends compute the same value;
 * if a signaling server tampered with the handshake (man-in-the-middle), the codes differ.
 */
async function safetyCodeFor(pc) {
  const fp = (sdp) => /a=fingerprint:(\S+ \S+)/i.exec(sdp || '')?.[1]?.toUpperCase();
  const a = fp(pc.localDescription?.sdp);
  const b = fp(pc.remoteDescription?.sdp);
  if (!a || !b) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));
  const view = new DataView(digest.buffer);
  return [0, 2, 4].map((o) => String(view.getUint16(o) % 10000).padStart(4, '0')).join(' ');
}
