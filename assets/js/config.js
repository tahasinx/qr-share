/**
 * QRShare runtime configuration.
 *
 * Everything here ships to every visitor's browser, so never put long-lived
 * secrets in this file. See README.md → "Connectivity & TURN" for details.
 *
 * Deployers may override any field without editing this file by defining
 * `window.QRSHARE_CONFIG = { ... }` in a script loaded before the app
 * (shallow-merged per top-level key).
 */
const defaults = {
  /**
   * PeerJS signaling server. `null` uses the free public PeerJS cloud
   * (0.peerjs.com). To self-host, run `npx peerjs --port 9000` and set e.g.
   * { host: 'signal.example.com', port: 443, path: '/', secure: true, key: 'peerjs' }.
   * Remember to allow the host in the Content-Security-Policy in index.html.
   */
  signaling: null,

  /** Public STUN servers used to discover direct routes. No credentials. */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],

  /**
   * Optional HTTPS endpoint that returns short-lived TURN credentials as a
   * JSON array of RTCIceServer objects (e.g. a Metered/Twilio/Cloudflare
   * credential endpoint restricted to your domain). Fetched once per session.
   * Leave `null` to use direct connections only.
   */
  iceServersUrl: null,

  /** Maximum participants per room (full mesh: every device links to every other). */
  maxPeers: 8,

  transfer: {
    /**
     * Bytes per DataChannel message. 64 KiB is safe across Chrome, Firefox and Safari and
     * benchmarked within ~6% of 128 KiB. It is automatically capped to the peer's negotiated
     * SCTP max message size.
     */
    chunkSize: 64 * 1024,
    /** Bytes read from disk at a time (split into chunks). */
    readBlockSize: 1024 * 1024,
    /** Pause sending while the channel buffer is above this many bytes… */
    bufferHigh: 4 * 1024 * 1024,
    /** …and resume when it drains below this. */
    bufferLow: 1024 * 1024,
    /** Received data is consolidated into a Blob every N bytes to bound JS heap use. */
    blobFlushBytes: 8 * 1024 * 1024,
    /** Files per offer. */
    maxFilesPerBatch: 100,
    /** Show image thumbnails for images up to this size. */
    previewMaxBytes: 30 * 1024 * 1024,
  },

  chat: {
    maxLength: 4000,
  },

  /** Exposes the current session as `window.__qrshare` for automated tests. Keep false in production. */
  debug: false,
};

const override = (typeof window !== 'undefined' && window.QRSHARE_CONFIG) || {};

export const CONFIG = Object.freeze({
  ...defaults,
  ...override,
  transfer: Object.freeze({ ...defaults.transfer, ...(override.transfer || {}) }),
  chat: Object.freeze({ ...defaults.chat, ...(override.chat || {}) }),
});
