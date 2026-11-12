// Security helpers shared by the server: response headers, HTTPS, per-page script nonces (CSP), input cleaning for
// scorecards, upload checks and a per-account login lockout. Pure Node (no packages) so it can be unit-tested anywhere.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROD = process.env.NODE_ENV === 'production';

/* ---------- headers + HTTPS ---------- */
// Every response: no MIME sniffing, a strict referrer, no camera/mic/location, HSTS on the live site.
// Pages may only be framed by Sieve itself, except /take (the scorecard), which businesses embed on their own sites.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.paystack.com")');
  if (!req.path.startsWith('/take')) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
}
// HTTPS everywhere: anything that reaches the live server over plain HTTP is sent to the HTTPS address.
function httpsRedirect(req, res, next) {
  if (!PROD || req.path === '/healthz') return next();
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto && proto !== 'https') return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  next();
}

/* ---------- pages with a Content-Security-Policy nonce ---------- */
// Only Sieve's own scripts run: each HTML page is served with a fresh random nonce stamped on its <script> tags, and
// the policy refuses any script without it. Injected markup can't run code even if something slipped past escaping.
function cspFor(nonce, framable) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://js.paystack.co`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://paystack.com https://*.paystack.com https://*.paystack.co",
    "font-src 'self' data: https://fonts.gstatic.com https://paystack.com https://*.paystack.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://api.paystack.co https://*.paystack.co https://*.paystack.com",
    'frame-src https://checkout.paystack.com https://*.paystack.co https://*.paystack.com',
    `frame-ancestors ${framable ? '*' : "'self'"}`,
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(PROD ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
function htmlWithNonce(roots) {
  // roots: [{ prefix: '/take', dir }, { prefix: '', dir }, ...] in the same order as the static servers
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch { return next(); }
    if (p.endsWith('/')) p += 'index.html';
    if (path.extname(p) !== '.html') return next();
    for (const { prefix, dir } of roots) {
      if (prefix && !p.startsWith(prefix + '/')) continue;
      const rel = prefix ? p.slice(prefix.length) : p;
      const file = path.normalize(path.join(dir, rel));
      if (!file.startsWith(dir + path.sep)) continue;
      if (path.basename(file).startsWith('.')) continue;
      let html;
      try { if (!fs.statSync(file).isFile()) continue; html = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const nonce = crypto.randomBytes(16).toString('base64');
      res.setHeader('Content-Security-Policy', cspFor(nonce, p.startsWith('/take/')));
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html');
      return res.send(html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`));
    }
    next();
  };
}

/* ---------- input cleaning ---------- */
const str = (v, n) => String(v ?? '').trim().slice(0, n);
// a link a visitor can click: only plain http(s) addresses (blocks javascript:, data: and the like)
function safeHttpUrl(v, max = 500) {
  const s = String(v ?? '').trim();
  if (!s || s.length > max || !/^https?:\/\//i.test(s) || /["'<>\s\\]/.test(s)) return '';
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? s : ''; } catch { return ''; }
}
// a cover picture: Sieve's own uploads/covers, or a plain https image address
function safeCoverImage(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\/(uploads|covers)\/[\w.-]{1,120}$/.test(s)) return s;
  return safeHttpUrl(s, 600);
}
function sanitizeCategories(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((c) => ({ key: str(c && c.key, 40).replace(/[^\w-]/g, ''), label: str(c && c.label, 60) })).filter((c) => c.key && c.label);
}
function sanitizeTiers(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((t) => {
    t = t || {};
    const min = Math.max(0, Math.min(100, Math.round(Number(t.min) || 0)));
    const out = { min, label: str(t.label, 80) };
    for (const k of ['headline', 'message', 'recommendation']) if (t[k] != null && t[k] !== '') out[k] = str(t[k], 800);
    if (t.recommendationLabel) out.recommendationLabel = str(t.recommendationLabel, 60);
    const url = safeHttpUrl(t.recommendationUrl);
    if (url) out.recommendationUrl = url;
    if (Array.isArray(t.signs)) out.signs = t.signs.slice(0, 10).map((x) => str(x, 200)).filter(Boolean);
    else if (typeof t.signs === 'string' && t.signs.trim()) out.signs = str(t.signs, 1200);
    return out;
  }).filter((t) => t.label);
}

/* ---------- uploads ---------- */
// the first bytes of a picture must match its type: a script renamed .png is refused
const MAGIC = { '.png': ['89504e47'], '.jpg': ['ffd8ff'], '.gif': ['47494638'], '.webp': ['52494646'] };
function imageBytesOk(file) {
  const want = MAGIC[path.extname(file).toLowerCase()];
  if (!want) return false;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(12);
  try { fs.readSync(fd, buf, 0, 12, 0); } finally { fs.closeSync(fd); }
  const hex = buf.toString('hex');
  if (path.extname(file).toLowerCase() === '.webp' && buf.slice(8, 12).toString() !== 'WEBP') return false;
  return want.some((m) => hex.startsWith(m));
}

/* ---------- login lockout ---------- */
// 8 wrong passwords for one email lock that email's login for 15 minutes (on top of the per-IP limit).
const LOCK_AFTER = 8, LOCK_MS = 15 * 60 * 1000;
const fails = new Map();
function loginLocked(email) { const f = fails.get(email); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function loginFailed(email) {
  const now = Date.now();
  let f = fails.get(email);
  // a lock that ran out, or wrong tries older than 15 minutes, start a fresh count
  if (!f || (f.until && f.until < now) || (!f.until && now - f.first > LOCK_MS)) f = { n: 0, until: 0, first: now };
  f.n += 1; if (f.n >= LOCK_AFTER) { f.until = now + LOCK_MS; f.n = 0; }
  fails.set(email, f);
}
function loginSucceeded(email) { fails.delete(email); }
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if ((f.until && f.until < now) || (!f.until && now - f.first > LOCK_MS)) fails.delete(k); }, 30 * 60 * 1000).unref();

const emailOk = (e) => typeof e === 'string' && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// bcrypt only uses the first 72 bytes of a password, so longer ones are refused rather than silently shortened
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(pw, 'utf8') > 72) return 'Password is too long (72 characters at most).';
  return '';
}

module.exports = { securityHeaders, httpsRedirect, htmlWithNonce, cspFor, safeHttpUrl, safeCoverImage, sanitizeCategories, sanitizeTiers, imageBytesOk, loginLocked, loginFailed, loginSucceeded, emailOk, passwordProblem };
