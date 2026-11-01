// Modified: 2026-11-01
// ==UserScript==
// @name         MetadataRemoverX
// @namespace    https://github.com/hutaoshusband/MetadataRemoverX
// @version      1.0.5
// @description  Removes share-link tracking parameters from x.com post URLs and blocks the server-side link minting.
// @author       hutaoshusband
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.5';
  const IS_TOP = window.top === window;
  const SHOW_UI = true;
  const STRIP_PARAMS = ['s', 't', 'si', 'a', 'cashtagTimeframe', 'cashtagRestId'];
  const MINT_IDS = ['HEXyjS9m5F2kJsx8FnqRJQ', 'nnBWIT3igGpvPWts7FXwiw'];
  const MINT_RESPONSE = JSON.stringify({ data: { create_share_link: { url: null } } });

  const status = { fetch: 'fail', copy: 'fail', dom: 'fail', history: 'fail', hooks: 'fail' };
  const counts = { mintBlocked: 0, copyCleaned: 0, linksCleaned: 0, reapplied: 0 };

  console.log('[MetadataRemoverX] ' + VERSION + ' boot @ ' + new Date().toISOString() + ' readyState=' + document.readyState);
  window.addEventListener('error', function (e) {
    console.log('[MetadataRemoverX] error: ' + e.message + ' @ ' + (e.filename || '') + ':' + e.lineno);
  });

  function isStatusUrl(value) {
    try {
      const u = new URL(value, location.origin);
      return (u.host === 'x.com' || u.host === 'twitter.com' || u.host === 'www.x.com' || u.host === 'www.twitter.com')
        && /\/status\/\d+/.test(u.pathname);
    } catch { return false; }
  }

  function cleanUrl(text) {
    if (!isStatusUrl(text)) return text;
    try {
      const u = new URL(text, location.origin);
      let changed = false;
      for (const p of STRIP_PARAMS) {
        if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; }
      }
      if (!changed) return text;
      if (text.charAt(0) === '/') return u.pathname + u.search + u.hash;
      return u.href;
    } catch { return text; }
  }

  function noteCopy(before, after) {
    if (before !== after) {
      counts.copyCleaned++;
      console.log('[MetadataRemoverX] copy cleaned: ' + before + '  ->  ' + after);
    }
  }

  window.__mrx = { version: VERSION, status, counts, cleanUrl };

  function isMint(url, body) {
    const u = String(url || '');
    if (!u.includes('/graphql/')) return false;
    if (/createsharelink/i.test(u)) return true;
    const b = typeof body === 'string' ? body : '';
    return MINT_IDS.some((id) => u.includes(id) || b.includes(id))
      || u.includes('shareButtonCreateShareLinkMutation') || b.includes('create_share_link');
  }

  function fakeMintLog(via) {
    counts.mintBlocked++;
    console.log('[MetadataRemoverX] mint blocked (' + via + ')');
  }

  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      let url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch { }
      if (isMint(url, init && init.body)) {
        fakeMintLog('fetch');
        return Promise.resolve(new Response(MINT_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return origFetch.apply(this, arguments);
    };
    status.fetch = 'ok';
  } catch (e) { console.log('[MetadataRemoverX] fetch patch failed: ' + e.message); }

  try {
    const xhrProto = XMLHttpRequest.prototype;
    const xhrOpen = xhrProto.open;
    const xhrSend = xhrProto.send;
    xhrProto.open = function (method, url) {
      this.__mrxUrl = url;
      return xhrOpen.apply(this, arguments);
    };
    xhrProto.send = function (body) {
      if (isMint(this.__mrxUrl, body)) {
        fakeMintLog('xhr');
        const self = this;
        setTimeout(function () {
          Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
          Object.defineProperty(self, 'status', { value: 200, configurable: true });
          Object.defineProperty(self, 'responseText', { value: MINT_RESPONSE, configurable: true });
          Object.defineProperty(self, 'response', { value: MINT_RESPONSE, configurable: true });
          self.dispatchEvent(new Event('readystatechange'));
          self.dispatchEvent(new ProgressEvent('load'));
          self.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
        return;
      }
      return xhrSend.apply(this, arguments);
    };
  } catch (e) { console.log('[MetadataRemoverX] xhr patch failed: ' + e.message); }

  let writeTextWrapper = null;
  let writeWrapper = null;
  let realWriteText = null;

  function cleanItems(items) {
    const list = Array.isArray(items) ? items : [items];
    return Promise.all(list.map(function (item) {
      if (!(item && item.getType) || !item.getType('text/plain')) return Promise.resolve(item);
      return item.getType('text/plain').then(function (blob) { return blob.text(); }).then(function (text) {
        const cleaned = cleanUrl(text);
        if (cleaned === text) return item;
        noteCopy(text, cleaned);
        return new ClipboardItem({ 'text/plain': new Blob([cleaned], { type: 'text/plain' }) });
      }).catch(function () { return item; });
    }));
  }

  function applyCopyPatches() {
    const clip = navigator.clipboard;
    if (!clip) return;
    if (typeof clip.writeText === 'function' && clip.writeText !== writeTextWrapper) {
      const orig = (writeTextWrapper && writeTextWrapper.__mrxOrig) || clip.writeText.bind(clip);
      if (!realWriteText) realWriteText = orig;
      writeTextWrapper = function (text) {
        const cleaned = cleanUrl(String(text));
        noteCopy(text, cleaned);
        return orig(cleaned);
      };
      writeTextWrapper.__mrxOrig = orig;
      clip.writeText = writeTextWrapper;
    }
    if (typeof clip.write === 'function' && clip.write !== writeWrapper) {
      const orig = (writeWrapper && writeWrapper.__mrxOrig) || clip.write.bind(clip);
      writeWrapper = function (items) {
        try {
          return cleanItems(items).then(function (newItems) { return orig(newItems); });
        } catch { return orig(items); }
      };
      writeWrapper.__mrxOrig = orig;
      clip.write = writeWrapper;
    }
  }

  try {
    applyCopyPatches();
    status.copy = 'ok';

    const origExec = document.execCommand;
    document.execCommand = function (cmd) {
      if (cmd !== 'copy') return origExec.apply(this, arguments);
      let text = '';
      try { text = String(document.getSelection() || ''); } catch { }
      if (!text) {
        try {
          const ae = document.activeElement;
          if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
            text = ae.value.substring(ae.selectionStart || 0, ae.selectionEnd || ae.value.length);
          }
        } catch { }
      }
      const cleaned = cleanUrl(text);
      const r = origExec.apply(this, arguments);
      if (cleaned !== text) {
        noteCopy(text, cleaned);
        const w = realWriteText || (navigator.clipboard && navigator.clipboard.writeText.bind(navigator.clipboard));
        if (w) w(cleaned).catch(function () { });
      }
      return r;
    };
  } catch (e) { console.log('[MetadataRemoverX] copy patch failed: ' + e.message); }

  try {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (state, title, url) {
      if (typeof url === 'string') {
        const cleaned = cleanUrl(url);
        if (cleaned !== url) return origPush.call(this, state, title, cleaned);
      }
      return origPush.apply(this, arguments);
    };
    history.replaceState = function (state, title, url) {
      if (typeof url === 'string') {
        const cleaned = cleanUrl(url);
        if (cleaned !== url) return origReplace.call(this, state, title, cleaned);
      }
      return origReplace.apply(this, arguments);
    };
    status.history = 'ok';
    if (location.search) {
      const cleanedHere = cleanUrl(location.href);
      if (cleanedHere !== location.href) history.replaceState(null, '', cleanedHere);
    }
  } catch (e) { console.log('[MetadataRemoverX] history patch failed: ' + e.message); }

  function cleanHref(el) {
    const href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    if (!/\/status\/\d+/.test(href)) return;
    const cleaned = cleanUrl(href);
    if (cleaned !== href) {
      el.setAttribute('href', cleaned);
      counts.linksCleaned++;
    }
  }

  function sanitizeTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'A') cleanHref(root);
    const links = root.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) cleanHref(links[i]);
  }

  try {
    const observer = new MutationObserver(function (records) {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.type === 'attributes') { cleanHref(r.target); continue; }
        for (let j = 0; j < r.addedNodes.length; j++) sanitizeTree(r.addedNodes[j]);
      }
    });

    let observerStarted = false;
    function startDomWatch() {
      if (observerStarted || !document.documentElement) return;
      observerStarted = true;
      sanitizeTree(document.documentElement);
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['href']
      });
      status.dom = 'ok';
    }
    startDomWatch();

    let domTries = 0;
    const domTimer = setInterval(function () {
      startDomWatch();
      if (observerStarted || ++domTries > 100) clearInterval(domTimer);
    }, 200);
  } catch (e) { console.log('[MetadataRemoverX] dom watch failed: ' + e.message); }

  function checkHooks() {
    try {
      applyCopyPatches();
      const clip = navigator.clipboard;
      const ok = clip && clip.writeText === writeTextWrapper;
      if (ok && status.hooks !== 'ok') status.hooks = 'ok';
      if (!ok) {
        counts.reapplied++;
        console.log('[MetadataRemoverX] writeText clobbered, reapplied');
      }
    } catch { }
  }

  function renderUi() {
    const el = document.getElementById('mrx-status');
    if (!el) return;
    const line = (name, extra) => name + ': ' + status[name] + (extra ? ' (' + extra + ')' : '');
    el.textContent = 'MetadataRemoverX ' + VERSION + '\n'
      + line('fetch', counts.mintBlocked + ' blocked') + '\n'
      + line('copy', counts.copyCleaned + ' cleaned') + '\n'
      + line('dom', counts.linksCleaned + ' links') + '\n'
      + line('history') + '\n'
      + line('hooks', counts.reapplied + ' reapplied');
  }

  function mountUi() {
    if (!IS_TOP || !SHOW_UI || document.getElementById('mrx-status')) return;
    if (!document.body) return;
    const el = document.createElement('div');
    el.id = 'mrx-status';
    el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#000;color:#fff;'
      + 'font:11px/1.5 monospace;padding:6px 8px;border:1px solid #666;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
    renderUi();
    setInterval(function () { checkHooks(); renderUi(); }, 1000);
  }

  let mountTries = 0;
  const mountTimer = setInterval(function () {
    mountUi();
    if (document.getElementById('mrx-status') || ++mountTries > 100) clearInterval(mountTimer);
  }, 200);

  // Mint: POST /i/api/graphql/<id>/CreateShareLink (id HEXyjS9m5F2kJsx8FnqRJQ) fires when the
  // share menu opens; a fake {url:null} makes the copy handler fall back to the clean canonical_url.
  // Copy exit: _handleCopyLink -> n.setString -> document.execCommand('copy') with the URL as the
  // selection; the execCommand wrapper cleans the selection text and rewrites the clipboard.
  // Legacy names (shareButtonCreateShareLinkMutation / nnBWIT3igGpvPWts7FXwiw) kept for older builds.
  // dom/history: strip tracked params from rendered /status/ hrefs and SPA navigation.
})();
