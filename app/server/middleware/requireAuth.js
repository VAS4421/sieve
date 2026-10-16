const { readSession, setSessionCookie } = require('../auth');
const { get } = require('../db');

async function requireAuth(req, res, next) {
  try {
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'Not signed in.' });

    const account = await get('SELECT id, business_name, email, plan, has_ever_paid, created_at, is_admin FROM users WHERE id = ?', [session.sub]);
    if (!account) return res.status(401).json({ error: 'Not signed in.' });

    req.user = account; // the account being acted on — unchanged shape for every existing route
    req.isOwner = !session.memberId;

    if (session.memberId) {
      const member = await get('SELECT id, email, active FROM team_members WHERE id = ? AND account_id = ?', [session.memberId, account.id]);
      if (!member || !member.active) return res.status(401).json({ error: 'Not signed in.' });
      req.member = member;
    }

    // Sliding 24-hour session: every authenticated request re-issues the
    // cookie with a fresh 24h expiry, so someone actively using the app never
    // gets logged out mid-session — only 24 hours of no activity signs them out.
    setSessionCookie(res, session.sub, session.memberId);

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAuth;
