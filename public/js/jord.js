/* ─────────────────────────────────────────────────────────────────────────
   JORD Golf — Shared Frontend Library
   v1.0.0
   ───────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'jord_admin_token';
  const APP = {};

  /* ─── Auth token (admin) ─────────────────────────────────────────── */
  APP.getToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
  APP.setToken = (t) => sessionStorage.setItem(TOKEN_KEY, t || '');
  APP.clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

  /* ─── API client ─────────────────────────────────────────────────── */
  APP.api = async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const tok = APP.getToken();
    if (tok) headers['x-admin-token'] = tok;
    const init = {
      method: opts.method || 'GET',
      headers,
      credentials: 'same-origin',
    };
    if (opts.body !== undefined) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const res = await fetch(path, init);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  /* ─── Geolocation ─────────────────────────────────────────────────── */
  APP.getLocation = function (opts = {}) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('Geolocation not supported in this browser'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
        (e) => reject(new Error(e.message || 'Could not get location — please enable GPS')),
        Object.assign({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }, opts)
      );
    });
  };

  /* ─── Toasts ─────────────────────────────────────────────────────── */
  function ensureStack() {
    let s = document.getElementById('toast-stack');
    if (!s) { s = document.createElement('div'); s.id = 'toast-stack'; document.body.appendChild(s); }
    return s;
  }
  APP.toast = function (msg, kind = 'info', ms = 3500) {
    const stack = ensureStack();
    const el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(40px)'; setTimeout(() => el.remove(), 240); }, ms);
  };
  APP.success = (m) => APP.toast(m, 'success');
  APP.error   = (m) => APP.toast(m, 'error', 5000);
  APP.warn    = (m) => APP.toast(m, 'warn');

  /* ─── SSE ─────────────────────────────────────────────────────────── */
  APP.subscribe = function (eventId, onMessage, onError) {
    const url = `/api/leaderboard/${encodeURIComponent(eventId)}/stream`;
    const es = new EventSource(url);
    es.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.warn('Bad SSE payload', err); } };
    es.onerror = (e) => { if (onError) onError(e); };
    return () => es.close();
  };

  /* ─── DOM helpers ─────────────────────────────────────────────────── */
  APP.$  = (sel, root = document) => root.querySelector(sel);
  APP.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  APP.el = function (tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'on' && typeof v === 'object') { for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); }
      else if (k === 'style' && typeof v === 'object') { Object.assign(e.style, v); }
      else if (k.startsWith('data-')) e.setAttribute(k, v);
      else e[k] = v;
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return e;
  };

  /* ─── Modal ───────────────────────────────────────────────────────── */
  APP.modal = function ({ title, body, footer, lg = false } = {}) {
    const backdrop = APP.el('div', { class: 'modal-backdrop is-open' });
    const m = APP.el('div', { class: 'modal' + (lg ? ' modal-lg' : '') });
    const header = APP.el('div', { class: 'modal-header' },
      APP.el('div', { class: 'modal-title' }, title || ''),
      APP.el('button', { class: 'modal-close', on: { click: close } }, '×')
    );
    const bodyEl = APP.el('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);
    const footerEl = APP.el('div', { class: 'modal-footer' });
    if (typeof footer === 'string') footerEl.innerHTML = footer;
    else if (footer) footerEl.appendChild(footer);

    m.appendChild(header); m.appendChild(bodyEl); if (footer) m.appendChild(footerEl);
    backdrop.appendChild(m);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);

    function close() { backdrop.remove(); }
    return { close, body: bodyEl, footer: footerEl };
  };

  APP.confirm = function (msg, { okText = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      const okBtn = APP.el('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), on: { click: () => { m.close(); resolve(true); } } }, okText);
      const noBtn = APP.el('button', { class: 'btn btn-ghost', on: { click: () => { m.close(); resolve(false); } } }, 'Cancel');
      const footer = APP.el('div', { class: 'row gap-3' }, noBtn, okBtn);
      const m = APP.modal({ title: 'Are you sure?', body: APP.el('p', null, msg), footer });
    });
  };

  /* ─── QR Scanner (uses jsQR via CDN) ─────────────────────────────── */
  APP.QRScanner = class {
    constructor(container, onCode) {
      this.container = container;
      this.onCode = onCode;
      this.video = null;
      this.canvas = null;
      this.ctx = null;
      this.stream = null;
      this.raf = null;
      this.alive = false;
      this.lastCode = null;
      this.lastTime = 0;
    }
    async start() {
      if (typeof jsQR === 'undefined') {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
          s.onload = res; s.onerror = () => rej(new Error('Could not load QR library'));
          document.head.appendChild(s);
        });
      }
      this.container.innerHTML = '';
      const wrap = APP.el('div', { class: 'qr-wrap' });
      this.video = APP.el('video', { autoplay: true, playsInline: true, muted: true });
      const overlay = APP.el('div', { class: 'qr-overlay' });
      const frame = APP.el('div', { class: 'qr-frame' });
      wrap.appendChild(this.video); wrap.appendChild(overlay); wrap.appendChild(frame);
      this.container.appendChild(wrap);
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
      } catch (e) {
        throw new Error('Camera blocked or unavailable. You can also enter your code by hand below.');
      }
      this.video.srcObject = this.stream;
      await this.video.play();
      this.alive = true;
      this._tick();
    }
    _tick() {
      if (!this.alive) return;
      if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
        this.canvas.width = this.video.videoWidth;
        this.canvas.height = this.video.videoHeight;
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          const now = Date.now();
          if (code.data !== this.lastCode || now - this.lastTime > 1500) {
            this.lastCode = code.data; this.lastTime = now;
            this.onCode(code.data);
          }
        }
      }
      this.raf = requestAnimationFrame(() => this._tick());
    }
    stop() {
      this.alive = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.container) this.container.innerHTML = '';
    }
  };

  /* Extract a drop code from a scanned QR payload (URL or raw code) */
  APP.extractDropCode = function (raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // Try as a URL with /scan/CODE or ?code=CODE
    try {
      const u = new URL(s);
      const m = u.pathname.match(/\/scan\/([A-Z0-9]+)/i);
      if (m) return m[1].toUpperCase();
      const q = u.searchParams.get('code') || u.searchParams.get('drop');
      if (q) return q.trim().toUpperCase();
    } catch {}
    // Else assume it IS the code
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  };

  /* ─── Topbar render ───────────────────────────────────────────────── */
  const JORD_LOGO     = 'https://jordgolf.com/cdn/shop/files/logo_4b5652a8-0699-40c3-978e-6a2dd03ba41d_small.svg?v=1738678077';
  const JORD_LOGO_INV = 'https://jordgolf.com/cdn/shop/files/logo-inverted_70x.svg?v=1738687297';

  APP.renderTopbar = function (subtitle = '', right = null, { dark = false } = {}) {
    const logoSrc = dark ? JORD_LOGO_INV : JORD_LOGO;
    const bar = APP.el('header', { class: 'topbar' },
      APP.el('div', { class: 'topbar-inner' },
        APP.el('a', { class: 'brand', href: '/admin' },
          APP.el('img', { src: logoSrc, alt: 'JORD Golf', style: { height: '36px', width: 'auto' } }),
          APP.el('div', null,
            APP.el('div', { class: 'brand-name' }, 'JORD GOLF'),
            subtitle ? APP.el('div', { class: 'brand-sub' }, subtitle) : null
          )
        ),
        APP.el('div', { class: 'topbar-right' }, right || '')
      )
    );
    document.body.insertBefore(bar, document.body.firstChild);
    return bar;
  };

  /* ─── Format helpers ──────────────────────────────────────────────── */
  APP.fmt = {
    date: (d) => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
    datetime: (d) => d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—',
    yards: (n) => n == null ? '—' : `${Math.round(n)} yd`,
    feet:  (n) => n == null ? '—' : `${Number(n).toFixed(1)} ft`,
    pct:   (n) => n == null ? '—' : `${Math.round(n)}%`,
    short: (s, n = 24) => !s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s,
  };

  /* ─── Misc ────────────────────────────────────────────────────────── */
  APP.copyToClipboard = async (txt) => {
    try { await navigator.clipboard.writeText(txt); APP.success('Copied to clipboard'); }
    catch { APP.warn('Could not copy — please copy by hand'); }
  };
  APP.qs = function (key, fallback = '') {
    return new URL(window.location.href).searchParams.get(key) || fallback;
  };
  APP.path = (i) => window.location.pathname.split('/').filter(Boolean)[i];

  global.JORD = APP;
})(window);
