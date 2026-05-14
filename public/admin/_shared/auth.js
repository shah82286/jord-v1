/**
 * Admin page auth check.
 *
 * Usage at top of any admin module page:
 *
 *   <script src="/js/jord.js"></script>
 *   <script src="/admin/_shared/auth.js"></script>
 *   <script>
 *     ADMIN.requireAuth({ super: true }).then(admin => {
 *       // admin is the current admin record; safe to render the page
 *     });
 *   </script>
 *
 * On failure (no token, expired, or wrong role) this redirects to /admin
 * with ?next=<current-path> so the login page can return the user here.
 */
(function () {
  const ADMIN = window.ADMIN = window.ADMIN || {};

  ADMIN.requireAuth = async function ({ super: needSuper = false } = {}) {
    const token = JORD.getToken();
    const back  = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);

    if (!token) {
      window.location.href = '/admin?next=' + back;
      throw new Error('redirecting to login');
    }

    let admin;
    try {
      admin = await JORD.api('/api/auth/me');
    } catch (err) {
      if (err.status === 401) {
        JORD.clearToken();
        window.location.href = '/admin?next=' + back;
        throw new Error('session expired, redirecting');
      }
      throw err;
    }

    if (needSuper && admin.role !== 'super') {
      // Bounce non-supers to the events list instead of looping at login
      window.location.href = '/admin';
      throw new Error('super admin required');
    }

    ADMIN.currentAdmin = admin;
    return admin;
  };

  /**
   * Render the standard admin topbar with sign-out + the user's name.
   * Returns the bar element.
   */
  ADMIN.renderTopbar = function (subtitle = '') {
    const userLabel = ADMIN.currentAdmin
      ? ADMIN.currentAdmin.name + (ADMIN.currentAdmin.role === 'super' ? ' · Super' : '')
      : '';
    const signOutBtn = JORD.el('button', {
      class: 'btn btn-ghost',
      style: { fontSize: '13px', padding: '6px 12px' },
      on: { click: ADMIN.signOut },
    }, 'Sign out');
    const userEl = userLabel
      ? JORD.el('span', { style: { fontSize: '13px', color: 'var(--ink-2)', marginRight: '12px' } }, userLabel)
      : null;
    const right = JORD.el('div', { class: 'row', style: { alignItems: 'center' } }, userEl, signOutBtn);
    return JORD.renderTopbar(subtitle, right);
  };

  ADMIN.signOut = async function () {
    try { await JORD.api('/api/auth/logout', { method: 'POST' }); } catch {}
    JORD.clearToken();
    window.location.href = '/admin';
  };
})();
