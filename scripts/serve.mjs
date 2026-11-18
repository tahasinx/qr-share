/**
 * Local static server that mimics GitHub Pages project hosting: the site is served
 * under a sub-path (/qr-share/) so broken absolute asset paths show up locally.
 *
 *   npm run serve            → http://localhost:8080/qr-share/
 *   PORT=9090 npm run serve
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = '/qr-share/';
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
};

/**
 * @param {number} port
 * @param {{ transform?: (relPath: string, body: Buffer) => Buffer|string }} [options]
 *   `transform` lets tests rewrite a file on the fly (e.g. simulate a deploy of a new sw.js).
 */
export function startServer(port = PORT, { transform } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/qr-share') { res.writeHead(302, { location: BASE }); res.end(); return; }
    if (!url.pathname.startsWith(BASE)) { res.writeHead(404); res.end('Not found'); return; }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT + sep) || /(^|[\\/])(node_modules|\.git|tests|scripts)([\\/]|$)/.test(rel)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      let body = await readFile(file);
      if (transform) body = transform(rel, body);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(() => console.log(`QRShare → http://localhost:${PORT}${BASE}`));
}
