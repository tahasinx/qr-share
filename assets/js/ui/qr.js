/**
 * QR rendering on top of qrcode-generator (global `qrcode`, vendored).
 * Always dark modules on white with a 4-module quiet zone: inverted or low-contrast
 * codes fail on many phone scanners, so the code stays light even in dark mode.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const QUIET = 4;
const INK = '#0b1433';

function matrix(text) {
  const qr = window.qrcode(0, 'M'); // ~15% error correction: robust without bloating the code
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r, c) => qr.isDark(r, c) };
}

/** Renders `text` as a crisp SVG QR code. */
export function qrSvg(text, { label = 'QR code' } = {}) {
  const { n, dark } = matrix(text);
  const size = n + QUIET * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      let run = 1;
      while (c + run < n && dark(r, c + run)) run++;
      d += `M${c + QUIET} ${r + QUIET}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('class', 'qr-svg');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', INK);
  svg.append(bg, path);
  return svg;
}

/** PNG of the code (≥1024px, integer module scale for sharp edges). */
export function qrPngBlob(text) {
  const { n, dark } = matrix(text);
  const size = n + QUIET * 2;
  const scale = Math.ceil(1024 / size);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = INK;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (dark(r, c)) ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}
