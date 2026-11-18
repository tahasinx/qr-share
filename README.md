# QRShare

**Send files and messages straight from one browser to another.** Open QRShare, scan the code with another device, and share. Nothing is uploaded, and no account is needed.

**Live:** https://tahasinx.github.io/qr-share

---

## Features

**Connecting**
- Each visit creates a private room with a 10-character code (e.g. `K7QM3-XRPWA`), a QR code and a link.
- Join by scanning with any phone camera, opening the link, typing the code, or scanning in-app (where the browser supports `BarcodeDetector`).
- Up to 8 devices per room, each linked directly to every other (full mesh).
- The room survives its creator leaving: another member takes over, and the same link keeps working.
- Live participant list showing connection state and route (*same network*, *direct*, or *relayed through TURN*).
- Per-device **verification codes** to check that nobody is intercepting the connection.
- Automatic recovery: signaling reconnects with backoff, interrupted links redial for 30 s, background tabs are tolerated, and a reloaded tab replaces its old entry instead of leaving a ghost.

**Files**
- Drag and drop anywhere, paste from the clipboard, or choose files. Multiple files go as one batch.
- Receiver accepts or declines each batch. One offer to several devices is tracked per recipient.
- Per-file and per-batch progress, speed and time left, all measured from real bytes on the wire.
- Pause, resume and cancel from either side, plus retry for failed sends.
- **Integrity check:** both ends SHA-256 every chunk, and the sender shows *Delivered and verified* only after the receiver confirms the hashes match.
- Streams with bounded memory and DataChannel backpressure (`bufferedAmount` / `bufferedamountlow`). The UI stays responsive during multi-GB transfers.
- Image thumbnails and previews, duplicate-name handling (`notes (2).txt`), and warnings on executable files.
- Pick files before anyone joins: they're offered to the first device that arrives.
- Keeps the screen awake during transfers (Wake Lock API) and warns before closing mid-transfer.

**Chat**
- Grouped messages, timestamps and per-recipient delivery receipts.
- Copy button, safe link detection (http/https only), and smart auto-scroll with a *New messages* button.
- Join/leave system messages and unread badges.

**App**
- Light and dark themes (follows the system; remembered when set).
- Installable PWA with an offline app shell.
- Fully keyboard-operable, screen-reader friendly, and respects reduced motion.
- No build step, no frameworks, and no third-party requests besides the signaling and STUN servers.

---

## How it works

```
 Device A ──┐                    ┌── Device B
            │  signaling only     │
            └──► PeerJS server ◄──┘   (room code, IPs, connection setup)
 Device A ◄═══════ WebRTC DataChannel (DTLS-encrypted) ═══════► Device B
                   files + messages, never via a server
```

1. **Rendezvous.** Every device opens an *identity* peer with a random ID on the PeerJS signaling server. One member also holds the room's *beacon* ID (derived from the room code). A newcomer first tries to claim the beacon. If the room is empty that succeeds instantly; otherwise it asks the beacon holder for the member list.
2. **Mesh.** The newcomer links directly to every member. Simultaneous dials are resolved deterministically, and if the beacon holder leaves, a remaining member claims the beacon.
3. **Transfer protocol.** Control messages are JSON. File data is binary frames (`[uint32 transfer#][≤64 KiB payload]`) on a reliable, ordered DataChannel. The sender reads 1 MiB from disk at a time and pauses while the channel buffer is above 4 MiB. The receiver hands data to the browser's Blob store every 8 MiB, so the JavaScript heap stays small (measured at about 40 MB after a 256 MB file).

### Code layout

```
index.html               App shell + strict Content-Security-Policy
sw.js                    Offline app-shell service worker (bump VERSION on deploy)
manifest.webmanifest     PWA manifest
assets/
  css/app.css            Design tokens + all component styles
  js/
    app.js               Routing, room lifecycle, layout state, dialogs, drag/drop/paste
    config.js            Signaling, ICE/TURN, limits (deploy-time settings)
    room.js              RoomSession: beacon, mesh, liveness, reconnection, route + safety code
    transfer.js          TransferManager: offers, queue, streaming, backpressure, hashing
    chat.js              ChatStore: messages + receipts
    views/               transfers.js, chat.js, people.js (DOM rendering)
    ui/                  dom, icons, toast, dialog, qr, scanner helpers
  vendor/                PeerJS 1.5.5, qrcode-generator 1.4.4 (pinned, self-hosted)
  fonts/ icons/
scripts/                 Local sub-path dev server, icon renderer (not needed in production)
tests/                   Unit (node:test) + end-to-end (Playwright) suites
```

---

## Running locally

QRShare is a static site, so any HTTPS or `localhost` server works (browsers only allow WebRTC on secure origins).

```sh
npm install        # dev tooling only: Playwright, local signaling server
npm run serve      # http://localhost:8080/qr-share/  (mirrors the GitHub Pages sub-path)
```

Without Node, `python3 -m http.server` from the repo root also works (open `http://localhost:8000/`).

### Tests

```sh
npx playwright install chromium   # once
npm test                          # unit tests + full end-to-end suite
```

The end-to-end suite runs real peer-to-peer sessions between isolated browser contexts against a local PeerJS server. It covers:
- Rooms: creating, joining, three-device mesh, room handover, reload and rejoin, invalid links, full rooms, blocked signaling, and key-spoofing resistance.
- Transfers: byte-exact SHA-256 comparison of downloaded files, batches with empty and duplicate files, decline, pause/resume, cancel and retry, peer loss mid-transfer, staged files, multiple recipients, and hostile file names.
- Chat: XSS payloads, receipts and scroll behaviour.
- Layout at 320 px through 1920 px including phone landscape, plus axe accessibility checks in both themes.

---

## Deploying to GitHub Pages

1. Push to the branch GitHub Pages serves (Settings → Pages → *Deploy from a branch*, root folder).
2. All asset paths are relative, so the site works from the `/qr-share/` project sub-path or any other path.
3. **On every release, bump `VERSION` in `sw.js`.** Returning visitors then get a *"A new version is ready, Reload"* prompt instead of a stale cached app.

`.nojekyll` is included so GitHub serves every file as-is.

---

## Connectivity & TURN

Direct WebRTC connections work on most home and mobile networks. They fail when both sides sit behind strict NATs or firewalls (some corporate networks, carrier-grade NAT, certain VPNs). There, a **TURN relay** is the only option. It forwards the encrypted data and cannot read it.

QRShare ships **without** TURN credentials on purpose: anything in frontend code is public, and static TURN credentials get abused. To add a relay:

- **Recommended:** set `iceServersUrl` in `assets/js/config.js` to an HTTPS endpoint that returns **short-lived** credentials as a JSON array of `RTCIceServer` objects. Metered, Twilio and Cloudflare Calls all offer such endpoints; restrict them to your domain. Also add the endpoint's origin to `connect-src` in the CSP in `index.html`.
- Or define `window.QRSHARE_CONFIG = { iceServersUrl: '…' }` in a script loaded before the app.

When no relay is configured, QRShare says so in *Connection details* and gives users concrete steps (same Wi-Fi, disable VPN) when a connection fails.

### Self-hosting signaling

The default is the free public PeerJS cloud (`0.peerjs.com`), which has no uptime guarantee. To run your own: `npx peerjs --port 9000`, set `signaling: { host, port, path, secure, key }` in `config.js`, and add the host to the CSP `connect-src`.

> ⚠️ **If you used an older version of this repository:** earlier commits contained hardcoded Metered TURN credentials. They remain in git history, so **rotate them** in your Metered dashboard.

---

## Privacy & security

**What's protected**
- File and message contents travel only over WebRTC DataChannels, which are always encrypted in transit (DTLS). They are never uploaded or stored by QRShare.
- Received files are kept in memory until you save them, clear them, or leave. Nothing is written to storage without your action.
- Room codes come from `crypto.getRandomValues` (~49.5 bits). The code lives in the URL fragment (`#…`), which browsers don't send to the web server.
- All peer-supplied content (names, file names, messages) is rendered as text, never HTML. File names are stripped of path separators, control characters and bidi-override spoofing (`gpj.exe`). Received non-image files are stored as opaque `application/octet-stream` blobs and only offered as downloads.
- Protocol input is size-checked and bounded: control messages ≤ 256 KiB, files can't exceed their announced size, rosters are capped, and offers are rate-limited per device.
- A strict CSP (`script-src 'self'`, no inline scripts or styles, limited `connect-src`), `referrer: no-referrer`, no analytics and no tracking.

**What to know (limitations)**
- **The signaling server sees metadata:** room codes, device IP addresses and connection setup data (including the DTLS fingerprints). It never sees file or message contents.
- **This is not end-to-end encryption in the strict sense.** A malicious signaling server could attempt a man-in-the-middle attack by substituting fingerprints. Use **Verify** next to a device and compare the codes on both screens: if they match, nobody is in between.
- **Anyone with the room link can join.** Share it only with people you trust; the participant list shows everyone present.
- STUN servers (Google and Cloudflare by default) learn your public IP address, as with any WebRTC app.
- The integrity check detects corruption and truncation. It isn't a signature: a malicious *peer* can of course send whatever file it likes. Treat received files like any download.

---

## Browser support & limits

- Current Chrome, Edge, Firefox and Safari (desktop and mobile). In-app QR scanning needs `BarcodeDetector` (Chrome/Edge on Android, macOS, ChromeOS); everywhere else, the phone's camera app or the typed code works.
- **No artificial file-size limit.** The practical limit is the receiver's memory and disk: received data is held by the browser's Blob storage until saved. Chrome pages large blobs to disk; mobile Safari is the most constrained, so very large files (multiple GB) to iPhones may fail.
- Keep both devices on QRShare until transfers finish. Mobile browsers throttle or suspend background tabs.
- Folders can't be sent directly; zip them first.
- Up to 8 devices per room (configurable via `maxPeers`); a full mesh beyond that gets expensive for phones.

---

## License

MIT. See [LICENSE](LICENSE).

Built with [PeerJS](https://peerjs.com/) (MIT), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), the [Schibsted Grotesk](https://github.com/schibsted/schibsted-grotesk) typeface (OFL), and icons adapted from [Lucide](https://lucide.dev) (ISC).

Made by [Tahasinx](https://github.com/tahasinx).
