const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { run, get } = require('../db');
const { setSessionCookie, clearSessionCookie } = require('../auth');
const requireAuth = require('../middleware/requireAuth');
const rateLimit = require('../middleware/rateLimit');
const { passwordResetEmail } = require('../mailer');
const { loginLocked, loginFailed, loginSucceeded, emailOk, passwordProblem } = require('../security');
// stronger bcrypt for new hashes (existing ones still verify); the dummy hash keeps response times equal for unknown emails
const BCRYPT_COST = 12;
const DUMMY_HASH = bcrypt.hashSync('timing-pad-not-a-password', 10);

const router = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts — wait a few minutes and try again.' });

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    const { businessName, email, password } = req.body || {};
    if (!businessName || !email || !password) {
      return res.status(400).json({ error: 'Business name, email, and password are all required.' });
    }
    const pwBad = passwordProblem(password); if (pwBad) return res.status(400).json({ error: pwBad });
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!emailOk(normalizedEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (String(businessName).trim().length > 120) return res.status(400).json({ error: 'Business name is too long (120 characters at most).' });
    const existing = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await run(
      'INSERT INTO users (id, business_name, email, password_hash) VALUES (?, ?, ?, ?)',
      [id, String(businessName).trim(), normalizedEmail, passwordHash]
    );

    const user = await get('SELECT id, business_name, email, plan, created_at FROM users WHERE id = ?', [id]);
    setSessionCookie(res, user.id);
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password are required.' });
    const normalizedEmail = email.toLowerCase().trim().slice(0, 254);
    const locked = loginLocked(normalizedEmail);
    if (locked) return res.status(429).json({ error: `Too many wrong passwords. Login for this account is paused for ${locked} minute${locked === 1 ? '' : 's'}.` });

    const owner = await get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    if (owner && await bcrypt.compare(password, owner.password_hash)) {
      loginSucceeded(normalizedEmail);
      const user = { id: owner.id, business_name: owner.business_name, email: owner.email, plan: owner.plan, created_at: owner.created_at };
      setSessionCookie(res, user.id, null, owner.session_version || 0);
      return res.json({ user });
    }

    const member = await get('SELECT * FROM team_members WHERE email = ? AND active = 1', [normalizedEmail]);
    if (member && member.password_hash && await bcrypt.compare(password, member.password_hash)) {
      loginSucceeded(normalizedEmail);
      const account = await get('SELECT id, business_name, email, plan, created_at FROM users WHERE id = ?', [member.account_id]);
      setSessionCookie(res, account.id, member.id, member.session_version || 0);
      return res.json({ user: account });
    }
    if (!owner && !member) await bcrypt.compare(password, DUMMY_HASH);   // same work either way, so timing reveals nothing

    loginFailed(normalizedEmail);
    res.status(401).json({ error: 'Incorrect email or password.' });
  } catch (err) {
    next(err);
  }
});

// Logging out ends this session and every other one for the same login (a stolen copy of the cookie stops working).
router.post('/logout', async (req, res) => {
  try {
    const { readSession } = require('../auth');
    const s = readSession(req);
    if (s && s.memberId) await run('UPDATE team_members SET session_version = session_version + 1 WHERE id = ? AND account_id = ? AND session_version = ?', [s.memberId, s.sub, s.v || 0]);
    else if (s) await run('UPDATE users SET session_version = session_version + 1 WHERE id = ? AND session_version = ?', [s.sub, s.v || 0]);
  } catch (err) { console.error('[auth] logout:', err.message); }
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const { isAdminUser } = require('../adminAccess');
  res.json({ user: req.user, isOwner: req.isOwner, member: req.member || null, isAdmin: isAdminUser(req.user, req.isOwner) });
});

// Always responds the same way whether or not the email exists, so this
// endpoint can't be used to find out who has an account.
router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await get('SELECT id, email FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      await run(
        'INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
        [crypto.randomUUID(), user.id, hashToken(token), expiresAt]
      );
      passwordResetEmail(user.email, token).catch(err => console.error('[auth] reset email failed:', err));
    }

    res.json({ ok: true, message: 'If that email has an account, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword || typeof token !== 'string') return res.status(400).json({ error: 'Token and new password are required.' });
    const pwBad = passwordProblem(newPassword); if (pwBad) return res.status(400).json({ error: pwBad });

    const tokenHash = hashToken(token);
    const record = await get(
      `SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at::timestamptz > now() ORDER BY created_at DESC LIMIT 1`,
      [tokenHash]
    );
    if (!record) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    // new password, every old session signed out, and every other reset link for this account cancelled
    await run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [await bcrypt.hash(newPassword, BCRYPT_COST), record.user_id]);
    await run('UPDATE password_resets SET used = 1 WHERE user_id = ?', [record.user_id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/accept-invite', authLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || typeof token !== 'string') return res.status(400).json({ error: 'Token and password are required.' });
    const pwBad = passwordProblem(password); if (pwBad) return res.status(400).json({ error: pwBad });

    const tokenHash = hashToken(token);
    const member = await get(
      `SELECT * FROM team_members WHERE invite_token_hash = ? AND active = 0 AND invite_expires_at::timestamptz > now()`,
      [tokenHash]
    );
    if (!member) return res.status(400).json({ error: 'This invite link is invalid or has expired.' });

    await run(
      'UPDATE team_members SET password_hash = ?, active = 1, invite_token_hash = NULL, invite_expires_at = NULL WHERE id = ?',
      [await bcrypt.hash(password, BCRYPT_COST), member.id]
    );

    const account = await get('SELECT id, business_name, email, plan, created_at FROM users WHERE id = ?', [member.account_id]);
    setSessionCookie(res, account.id, member.id, member.session_version || 0);
    res.status(201).json({ user: account });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
