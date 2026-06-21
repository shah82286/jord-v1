// AI Help Agent widget (#PHASE-3, v3.77). Mount on any admin page with:
//   <script src="/js/jord-help-agent.js"></script>
//   <script>JORD.mountHelpAgent({ eventId: '...', page: 'editor' });</script>
//
// Both args are optional — without them the chat still works, just without
// event context. The widget lives bottom-right (mirrors the banter chat
// pattern from round-join.html).
(function (global) {
  if (!global.JORD || global.JORD.mountHelpAgent) return; // idempotent
  const APP = global.JORD;
  const esc = APP.escapeHtml;

  const SESSION_KEY = 'jord_help_session_id';

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function injectCSS() {
    if (document.getElementById('jord-help-agent-css')) return;
    const s = document.createElement('style');
    s.id = 'jord-help-agent-css';
    s.textContent = `
      .jha-fab { position:fixed; bottom:18px; right:18px; z-index:9100;
        display:flex; align-items:center; gap:6px; padding:10px 16px;
        background:#1A1A1A; color:#FAF7F2; border:none; border-radius:999px;
        font-family:inherit; font-weight:600; font-size:14px; cursor:pointer;
        box-shadow:0 6px 20px rgba(0,0,0,.20); -webkit-tap-highlight-color:transparent; }
      .jha-fab:hover { background:#000; }
      .jha-panel { position:fixed; bottom:18px; right:18px; z-index:9101;
        width:min(380px, calc(100vw - 24px));
        height:min(560px, calc(100vh - 80px));
        background:#FAF7F2; border:1px solid #D4CFC4; border-radius:14px;
        box-shadow:0 16px 50px rgba(0,0,0,.30); display:none; flex-direction:column; overflow:hidden; }
      .jha-panel.is-open { display:flex; }
      .jha-head { padding:12px 14px; border-bottom:1px solid #D4CFC4;
        display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .jha-head h3 { font-family:'Playfair Display', Georgia, serif; font-size:1.05rem; margin:0; flex:1; }
      .jha-head .quota { font-size:10.5px; color:#5A5A5A; font-weight:500; white-space:nowrap; }
      .jha-head .x { background:none; border:none; color:#5A5A5A; font-size:22px;
        cursor:pointer; padding:0 6px; line-height:1; }
      .jha-msgs { flex:1; overflow-y:auto; padding:12px; display:flex;
        flex-direction:column; gap:10px; font-size:14px; line-height:1.45; }
      .jha-msg { padding:9px 11px; border-radius:10px; border:1px solid #D4CFC4;
        background:#fff; max-width:90%; word-wrap:break-word; }
      .jha-msg.user { background:rgba(184,136,77,.10); border-color:rgba(184,136,77,.30);
        align-self:flex-end; }
      .jha-msg.assistant { align-self:flex-start; }
      .jha-msg pre { background:#F0EBE2; padding:6px 8px; border-radius:6px;
        overflow-x:auto; font-size:12px; }
      .jha-msg code { background:#F0EBE2; padding:1px 4px; border-radius:3px; font-size:12.5px; }
      .jha-empty { text-align:center; color:#9A9A9A; padding:30px 16px; font-size:13px; }
      .jha-empty strong { color:#1A1A1A; }
      .jha-typing { font-size:12px; color:#5A5A5A; font-style:italic; padding:0 12px 6px; display:none; }
      .jha-typing.is-on { display:block; }
      .jha-form { display:flex; gap:6px; padding:10px; border-top:1px solid #D4CFC4; }
      .jha-form textarea { flex:1; padding:9px 12px; border:1px solid #D4CFC4;
        border-radius:8px; background:#fff; font-size:14px; font-family:inherit;
        resize:none; max-height:140px; min-height:42px; }
      .jha-form button { padding:0 14px; background:#B8884D; color:#fff;
        border:none; border-radius:8px; font-weight:600; cursor:pointer; font-size:14px; }
      .jha-form button:disabled { opacity:.5; cursor:default; }
      .jha-tools { display:flex; gap:6px; padding:0 10px 8px; }
      .jha-tools button { background:transparent; border:1px solid #D4CFC4; border-radius:8px;
        padding:5px 10px; font-size:11.5px; color:#5A5A5A; cursor:pointer; font-family:inherit; }
      .jha-tools button:hover { color:#1A1A1A; border-color:#1A1A1A; }
      .jha-tools .escalate { color:#A12C2C; border-color:rgba(161,44,44,.35); }
      .jha-tools .escalate.is-suggested { background:rgba(161,44,44,.08); }
      .jha-banner { padding:8px 12px; background:rgba(161,44,44,.08); color:#A12C2C;
        font-size:12.5px; border-top:1px solid rgba(161,44,44,.30); }
    `;
    document.head.appendChild(s);
  }

  // Tiny markdown subset — paragraphs, bold, inline code, code fence.
  // Keeps the chat readable without dragging in a full parser.
  function fmt(text) {
    if (!text) return '';
    // Code fences first
    let out = esc(text);
    out = out.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Bullet lists
    out = out.replace(/(?:^|\n)- (.+)/g, '\n• $1');
    return out.replace(/\n/g, '<br>');
  }

  APP.mountHelpAgent = function (opts = {}) {
    if (document.getElementById('jha-fab')) return; // already mounted
    injectCSS();
    const fab = el(`<button class="jha-fab" id="jha-fab" type="button">🆘 Help</button>`);
    const panel = el(`<aside class="jha-panel" id="jha-panel" role="dialog" aria-label="JORD Help Agent">
      <div class="jha-head">
        <h3>🆘 JORD Help</h3>
        <span class="quota" id="jha-quota"></span>
        <button class="x" type="button" id="jha-close" aria-label="Close">×</button>
      </div>
      <div class="jha-msgs" id="jha-msgs">
        <div class="jha-empty">Ask anything about running your event. <br><br>
          <strong>Try:</strong><br>
          "How do I add a sponsor logo?"<br>
          "Why is my pairings poster blank?"<br>
          "Can I refund a player?"
        </div>
      </div>
      <div class="jha-typing" id="jha-typing">Thinking…</div>
      <div class="jha-tools">
        <button type="button" id="jha-new">+ New chat</button>
        <button type="button" class="escalate" id="jha-escalate">🆘 Escalate to super admin</button>
      </div>
      <form class="jha-form" id="jha-form">
        <textarea id="jha-input" rows="1" maxlength="4000" placeholder="Ask the JORD Help Agent…" required></textarea>
        <button type="submit" id="jha-send">Send</button>
      </form>
    </aside>`);
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    // State
    const ctx = { event_id: opts.eventId || null, page: opts.page || null };
    let sessionId = (function(){ try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } })();
    let cap = 0, used = 0;

    const $ = (id) => document.getElementById(id);
    const msgs = $('jha-msgs');

    function setQuota(u, c) {
      used = u; cap = c;
      const pct = c ? Math.round((u / c) * 100) : 0;
      $('jha-quota').textContent = c ? `${pct}% of daily quota` : '';
      $('jha-quota').style.color = pct >= 90 ? '#A12C2C' : '#5A5A5A';
    }

    function appendMsg(role, content) {
      // First message clears the empty-state placeholder.
      const empty = msgs.querySelector('.jha-empty');
      if (empty) empty.remove();
      const m = document.createElement('div');
      m.className = 'jha-msg ' + role;
      m.innerHTML = fmt(content);
      msgs.appendChild(m);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function setTyping(on) { $('jha-typing').classList.toggle('is-on', on); }
    function suggestEscalate(on) { $('jha-escalate').classList.toggle('is-suggested', on); }

    async function loadQuota() {
      try {
        const r = await APP.api('/api/admin/help-agent/usage-today');
        setQuota(r.used, r.cap);
      } catch {}
    }

    async function loadSession() {
      if (!sessionId) return;
      try {
        const r = await APP.api(`/api/admin/help-agent/sessions/${encodeURIComponent(sessionId)}`);
        if (Array.isArray(r.messages) && r.messages.length) {
          msgs.innerHTML = '';
          for (const m of r.messages) appendMsg(m.role, m.content);
        }
      } catch (e) {
        // Stale session id (e.g. server restart) — drop it and start fresh.
        try { sessionStorage.removeItem(SESSION_KEY); } catch {}
        sessionId = null;
      }
    }

    async function send(text) {
      appendMsg('user', text);
      setTyping(true); $('jha-send').disabled = true;
      try {
        const r = await APP.api('/api/admin/help-agent/chat', {
          method: 'POST',
          body: { message: text, session_id: sessionId || null, context: ctx },
        });
        sessionId = r.session_id;
        try { sessionStorage.setItem(SESSION_KEY, sessionId); } catch {}
        appendMsg('assistant', r.reply || '(no response)');
        if (typeof r.usage_today === 'number') setQuota(r.usage_today, r.cap);
        suggestEscalate(!!r.stuck_hint);
      } catch (e) {
        // 429 = daily cap; surface the friendly message attached to err.data.
        const friendly = (e && e.data && e.data.message) || e.message || 'Something went wrong. Try again, or escalate.';
        appendMsg('assistant', '⚠ ' + friendly);
      } finally {
        setTyping(false); $('jha-send').disabled = false;
        $('jha-input').focus();
      }
    }

    function openPanel() {
      panel.classList.add('is-open');
      fab.style.display = 'none';
      loadQuota();
      if (sessionId && msgs.querySelector('.jha-empty')) loadSession();
      setTimeout(() => $('jha-input').focus(), 50);
    }
    function closePanel() {
      panel.classList.remove('is-open');
      fab.style.display = '';
    }

    fab.onclick = openPanel;
    $('jha-close').onclick = closePanel;
    $('jha-new').onclick = () => {
      sessionId = null;
      try { sessionStorage.removeItem(SESSION_KEY); } catch {}
      msgs.innerHTML = '<div class="jha-empty">New chat started.</div>';
      suggestEscalate(false);
    };
    $('jha-escalate').onclick = async () => {
      if (!sessionId) { alert('Send at least one message before escalating.'); return; }
      const note = prompt('Add a note for the super admin (optional):', '');
      if (note === null) return;
      try {
        await APP.api('/api/admin/help-agent/escalate', {
          method: 'POST', body: { session_id: sessionId, note: note || '' },
        });
        appendMsg('assistant', '✓ Flagged for a super admin. They\'ll see your full conversation here and reach out.');
      } catch (e) {
        alert('Could not escalate: ' + (e.message || 'try again'));
      }
    };
    $('jha-form').onsubmit = (ev) => {
      ev.preventDefault();
      const ta = $('jha-input');
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      send(text);
    };
    // Enter sends, Shift+Enter adds a newline.
    $('jha-input').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('jha-form').requestSubmit();
      }
    };
  };
})(window);
