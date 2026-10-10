/* Keep the first screen and recovery code inside the HTML, before any network bundle. */
(function () {
  'use strict';
  var ready = false, running = false, attempts = 0, fallback = '', slowTimer, retryTimer;
  var status = window.__TYW_STARTUP = { ready: false, attempts: 0 };
  if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', {
    value: function (i) { i = Math.trunc(i) || 0; return this[i < 0 ? i + this.length : i]; }, configurable: true, writable: true
  });
  if (!Promise.withResolvers) Promise.withResolvers = function () {
    var resolve, reject, promise = new Promise(function (a, b) { resolve = a; reject = b; });
    return { promise: promise, resolve: resolve, reject: reject };
  };
  if (window.AbortSignal && !AbortSignal.timeout) AbortSignal.timeout = function (ms) {
    var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal;
  };
  if (window.AbortSignal && !AbortSignal.any) AbortSignal.any = function (signals) {
    var c = new AbortController(), listeners = [];
    function finish(s) { if (c.signal.aborted) return; c.abort(s.reason); listeners.forEach(function (p) { p[0].removeEventListener('abort', p[1]); }); }
    signals.forEach(function (s) { if (s.aborted) finish(s); else if (!c.signal.aborted) {
      var f = function () { finish(s); }; listeners.push([s, f]); s.addEventListener('abort', f, { once: true });
    } }); return c.signal;
  };
  function message(text) { var p = document.getElementById('boot-status'); if (p) p.textContent = text; }
  function bindRetry() {
    var button = document.getElementById('boot-retry');
    if (button) button.onclick = function () { if (!running && !ready) { clearTimeout(retryTimer); attempts = 0; start(); } };
  }
  function restore() {
    if (!ready && fallback) { document.getElementById('app').innerHTML = fallback; bindRetry(); }
  }
  function assetPath(path, extension) {
    return typeof path === 'string' && new RegExp('^/assets/[a-zA-Z0-9_.-]+\\.' + extension + '$').test(path);
  }
  function stylesheet(path, build, attempt) {
    var existing = Array.from(document.querySelectorAll('link[data-tyw-style]')).find(function (link) { return link.dataset.tywStyle === path && link.sheet; });
    if (existing) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var link = document.createElement('link'), timer;
      function finish(error) { clearTimeout(timer); link.onload = link.onerror = null; if (error) { link.remove(); reject(error); } else resolve(); }
      link.rel = 'stylesheet'; link.dataset.tywStyle = path; link.href = path + '?v=' + build + '&retry=' + attempt;
      link.onload = function () { finish(); }; link.onerror = function () { finish(new Error('stylesheet')); };
      timer = setTimeout(function () { finish(new Error('stylesheet timeout')); }, 12000);
      document.head.appendChild(link);
    });
  }
  async function start() {
    if (ready || running) return;
    if (typeof BigInt !== 'function') { message('这个浏览器版本太旧，请升级钱包 App 后再打开。'); return; }
    running = true; attempts++; status.attempts = attempts;
    var button = document.getElementById('boot-retry'); if (button) button.disabled = true;
    message(attempts === 1 ? '正在打开交易界面…' : '刚才的资源没有加载完成，正在重新连接…');
    slowTimer = setTimeout(function () { if (!ready) message('网络有些慢，正在等交易界面加载。独立赎回入口仍可打开。'); }, 10000);
    try {
      var response = await fetch('/app.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('manifest');
      var text = await response.text(); if (text.length > 8192) throw new Error('manifest size');
      var manifest = JSON.parse(text);
      if (!/^[a-f0-9]{64}$/.test(manifest.build) || !assetPath(manifest.entry, 'js') ||
          !Array.isArray(manifest.styles) || manifest.styles.length > 20 ||
          !manifest.styles.every(function (path) { return assetPath(path, 'css'); })) throw new Error('manifest format');
      await Promise.all(manifest.styles.map(function (path) { return stylesheet(path, manifest.build, attempts); }));
      // Retry only rejected imports. A slow but pending import must never start a second application.
      await import(manifest.entry + '?v=' + manifest.build + '&retry=' + attempts);
      if (!ready) throw new Error('initialization');
    } catch (_) {
      if (!ready) {
        restore();
        if (attempts < 3) retryTimer = setTimeout(start, attempts * 1200);
        else message('交易界面暂时没能打开。可以重试，或直接打开下面的独立赎回入口。');
      }
    } finally {
      running = false; clearTimeout(slowTimer);
      var retry = document.getElementById('boot-retry'); if (retry) retry.disabled = false;
    }
  }
  window.addEventListener('nomtf:ready', function () { ready = status.ready = true; clearTimeout(slowTimer); });
  window.addEventListener('vite:preloadError', function (event) {
    // Startup's rejected import handles recovery. Never reload a working wallet transaction.
    if (!ready) event.preventDefault();
  });
  document.addEventListener('DOMContentLoaded', function () {
    fallback = document.getElementById('app').innerHTML; bindRetry(); start();
  }, { once: true });
})();
