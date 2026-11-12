const { readSession, setSessionCookie } = require('../auth');
const { get } = require('../db');

async function requireAuth(req, res, next) {
  try {
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Not signed in.' });

    const account = await get('SELECT id, business_name, email, plan, has_ever_paid, created_at, is_admin, session_version FROM users WHERE id = ?', [session.sub]);
    if (!account) return res.status(401).json({ error: 'Not signed in.' });
    const { session_version: ownerVersion, ...accountPublic } = account;

    req.user = accountPublic; // the account being acted on — unchanged shape for every existing route
    req.isOwner = !session.memberId;

    if (session.memberId) {
      const member = await get('SELECT id, email, active, session_version FROM team_members WHERE id = ? AND account_id = ?', [session.memberId, account.id]);
      if (!member || !member.active || (member.session_version || 0) !== (session.v || 0)) return res.status(401).json({ error: 'Not signed in.' });
      req.member = { id: member.id, email: member.email, active: member.active };
    } else if ((ownerVersion || 0) !== (session.v || 0)) {
      return res.status(401).json({ error: 'Not signed in.' });   // logged out, or the password changed since
    }
    req.sessionVersion = session.v || 0;

    // Sliding 24-hour session: every authenticated request re-issues the
    // cookie with a fresh 24h expiry, so someone actively using the app never
    // gets logged out mid-session — only 24 hours of no activity signs them out.
    setSessionCookie(res, session.sub, session.memberId, session.v || 0);

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAuth;
