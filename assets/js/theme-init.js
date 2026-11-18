// Applies the saved theme before first paint to avoid a flash. Kept tiny and synchronous.
(function () {
  try {
    var t = localStorage.getItem('qrshare:theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage unavailable: follow the system */ }
})();
