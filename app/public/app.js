// Shared helpers for every page under /app/public.

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// Call at the top of any protected page. Redirects to login if not signed in,
// otherwise resolves with the current user and paints their business name in.
async function requireUser() {
  try {
    const { user, isAdmin } = await api('/auth/me');
    document.querySelectorAll('[data-user-business]').forEach(el => { el.textContent = user.business_name; });
    // VASNET admins see the Admin link; everyone else never does
    if (isAdmin) document.querySelectorAll('[data-admin-link]').forEach(el => { el.hidden = false; });
    user.isAdmin = !!isAdmin;
    return user;
  } catch {
    window.location.href = '/login.html';
    return null;
  }
}

// ---------- On-screen alerts — replaces window.alert()/confirm() with an
// in-page toast and a small modal, so nothing pops a native browser dialog.
function escapeToastHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toastStack() {
  let el = document.getElementById('toast-stack');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-stack';
    document.body.appendChild(el);
  }
  return el;
}

function dismissToast(el) {
  if (!el.isConnected) return;
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 200);
}

// showToast(message, type) — type is 'error' (default), 'success', or 'info'.
function showToast(message, type = 'error') {
  const stack = toastStack();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'info' ? 'ⓘ' : '!';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeToastHtml(message)}</span>`;
  el.addEventListener('click', () => dismissToast(el));
  stack.appendChild(el);
  setTimeout(() => dismissToast(el), 5000);
}

// showConfirm(message) — returns a Promise<boolean>, so a call site written as
// `if (!confirm('...')) return;` inside an async function becomes
// `if (!(await showConfirm('...'))) return;`.
function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${escapeToastHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" data-choice="cancel">Cancel</button>
          <button class="btn btn-primary btn-sm" data-choice="ok">Confirm</button>
        </div>
      </div>
    `;
    const finish = (result) => { overlay.remove(); resolve(result); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelector('[data-choice="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-choice="ok"]').addEventListener('click', () => finish(true));
    document.body.appendChild(overlay);
  });
}

function showError(el, message) {
  el.textContent = message;
  el.classList.add('show');
}
function hideError(el) {
  el.classList.remove('show');
}

// Turns a templates.html card into a real, owned scorecard: creates it, then
// fills in the template's categories/questions/tiers in one PUT. Used both
// when a logged-in visitor clicks a template directly, and after a fresh
// signup that arrived via a template link (see signup.html).
//
// Each template carries one suggested `ctaLabel` (not per-tier, since these
// are lean starter templates) — it's applied as the recommendation text on
// the top tier only, the one tier a call-to-action like "Book a viewing"
// actually makes sense for. The link itself is deliberately left blank: no
// template can invent a real booking page or WhatsApp number, so the owner
// fills that in themselves (or overrides/adds recommendations on any other
// tier) once they're in the builder.
async function createScorecardFromTemplate(template) {
  const { scorecard } = await api('/scorecards', { method: 'POST', body: { title: template.title } });
  const tiers = (template.tiers || []).map((t, i) => (
    i === 0 && template.ctaLabel ? { ...t, recommendation: template.ctaLabel } : { ...t }
  ));
  await api(`/scorecards/${scorecard.id}`, {
    method: 'PUT',
    body: {
      title: template.title,
      intro: template.intro || '',
      categories: template.categories,
      questions: template.questions,
      tiers,
      coverImage: template.coverImage || '',
    },
  });
  return scorecard.id;
}

async function wireLogout() {
  document.querySelectorAll('[data-logout]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  });
}

// ---------- Password show/hide toggle ----------
// Wires up any `<button data-toggle-password="inputId">` next to a password
// field (see login.html / signup.html) to flip that input between masked
// and plain text, swapping an eye / eye-off icon as it goes.
const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.6 20.6 0 0 1 5.06-6.06M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a20.6 20.6 0 0 1-3.22 4.44M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function wirePasswordToggles() {
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    btn.innerHTML = EYE_ICON;
    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  });
}
document.addEventListener('DOMContentLoaded', wirePasswordToggles);
document.addEventListener('DOMContentLoaded', wireLogout);
