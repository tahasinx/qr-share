/** Starts the sub-path static server and a local PeerJS signaling server for tests. */
import { PeerServer } from 'peer';
import { startServer } from '../../scripts/serve.mjs';

export const APP_PORT = 8181;
export const SIGNAL_PORT = 9181;
export const APP_URL = `http://localhost:${APP_PORT}/qr-share/`;

export async function startAll() {
  const web = await startServer(APP_PORT);
  const signal = await new Promise((ok) => {
    PeerServer({ port: SIGNAL_PORT, path: '/', expire_timeout: 3000, alive_timeout: 20000 }, (server) => ok(server));
  });
  return async () => {
    await new Promise((r) => web.close(r));
    await new Promise((r) => signal.close(r));
  };
}

/** Init script: point the app at the local signaling server. */
export const LOCAL_CONFIG = `window.QRSHARE_CONFIG = { signaling: { host: 'localhost', port: ${SIGNAL_PORT}, path: '/', secure: false, key: 'peerjs' }, debug: true };`;
