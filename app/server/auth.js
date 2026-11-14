const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — copy .env.example to .env and fill it in before starting the server.');
}

// On the live site the cookie carries the __Host- prefix: browsers then only accept it over HTTPS, for this exact
// domain and the whole site, so no other subdomain or plain-HTTP page can plant or overwrite it. Local dev runs on
// plain http://localhost, where that prefix isn't allowed, so it keeps the old name there.
const COOKIE_NAME = process.env.NODE_ENV === 'production' ? '__Host-sieve_session' : 'sieve_session';
const OLD_COOKIE_NAME = 'sieve_session';
// 24 hours, and slid forward on every authenticated request (see
// requireAuth.js) — an active user is never logged out mid-session, but 24
// hours with no activity at all signs them out and they have to log back in.
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// `secure` must be true once this runs behind real HTTPS (any real deployment)
// so the session cookie is never sent over plain HTTP — but forcing it true
// locally would silently break login, since local dev runs on plain
// http://localhost. Set NODE_ENV=production in whatever hosts this
// (Railway/Render/Fly all do this automatically) to turn it on.
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

// `sub` is always the ACCOUNT id (the owning row in `users`), for both the
// owner's own login and any team member's login — every existing route that
// resolves req.user from session.sub keeps working unchanged either way.
// `memberId` is null for the owner, or the team_members.id for a teammate.
function signSession(accountId, memberId = null, version = 0) {
  return jwt.sign({ sub: accountId, memberId, v: version || 0 }, JWT_SECRET, { expiresIn: '24h', algorithm: 'HS256' });
}

function setSessionCookie(res, accountId, memberId = null, version = 0) {
  const token = signSession(accountId, memberId, version);
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearSessionCookie(res) {
  // Browsers only reliably clear a cookie when the clearing call's options
  // (secure/sameSite/httpOnly) match how it was set — omitting them here
  // worked in dev (secure was always false) but would silently fail to log
  // people out in production once secure:true is in play.
  const { maxAge, ...clearOptions } = cookieOptions();
  res.clearCookie(COOKIE_NAME, clearOptions);
  if (OLD_COOKIE_NAME !== COOKIE_NAME) res.clearCookie(OLD_COOKIE_NAME, clearOptions);   // tidy up the pre-prefix cookie
}

function readSession(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

module.exports = { COOKIE_NAME, signSession, setSessionCookie, clearSessionCookie, readSession };
