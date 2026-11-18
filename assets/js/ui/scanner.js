/**
 * In-app QR scanning via the native BarcodeDetector API (Chrome/Edge on Android,
 * ChromeOS, macOS). Where it's missing, the join dialog offers code entry instead;
 * phone camera apps also open QRShare links directly.
 */
export async function scannerSupported() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code');
  } catch {
    return false;
  }
}

/**
 * Streams the rear camera into `video` and resolves with the first decoded QR value.
 * Call the returned `stop()` to release the camera at any time.
 */
export function startScanner(video, onResult, onError) {
  let stream = null;
  let stopped = false;
  let timer = null;
  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  const loop = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2) {
        const codes = await detector.detect(video);
        if (codes.length && !stopped) { onResult(codes[0].rawValue); return; }
      }
    } catch { /* transient decode errors are normal; keep scanning */ }
    timer = setTimeout(loop, 180);
  };

  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      video.srcObject = s;
      video.setAttribute('playsinline', '');
      video.muted = true;
      return video.play().then(loop);
    })
    .catch((err) => { if (!stopped) onError(err); });

  return stop;
}
