const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { run, get, all } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const rateLimit = require('../middleware/rateLimit');
const { teamInviteEmail } = require('../mailer');

const router = express.Router();

// Seats include the account owner. Matches the numbers already on the pricing page.
const SEAT_LIMITS = { free: 1, starter: 1, business: 3, pro: 5, enterprise: Infinity };

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function seatLimitFor(plan, billing) {
  const byPlan = SEAT_LIMITS[plan] ?? 1;
  if (billing && billing.has_ever_paid && ['credits', 'cpl'].includes(billing.billing_mode)) return Math.max(3, byPlan);
  return byPlan;
}
const billingOf = (id) => get('SELECT billing_mode, has_ever_paid FROM users WHERE id = ?', [id]);

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const members = await all(
      'SELECT id, email, active, created_at FROM team_members WHERE account_id = ? ORDER BY created_at ASC',
      [req.user.id]
    );
    const seatsUsed = 1 + members.filter(m => m.active).length; // +1 for the owner
    res.json({
      owner: { email: req.user.email, businessName: req.user.business_name },
      members: members.map(m => ({ ...m, pending: !m.active })),
      seatLimit: seatLimitFor(req.user.plan, await billingOf(req.user.id)),
      seatsUsed,
      plan: req.user.plan,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/invite', requireAuth, rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }), async (req, res, next) => {
  try {
    if (!req.isOwner) return res.status(403).json({ error: 'Only the account owner can invite team members.' });

    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const normalizedEmail = email.toLowerCase().trim();

    if (normalizedEmail === req.user.email) {
      return res.status(400).json({ error: "That's your own login email." });
    }

    const existingMembers = await all('SELECT id, active FROM team_members WHERE account_id = ?', [req.user.id]);
    const seatsUsed = 1 + existingMembers.filter(m => m.active).length;
    const limit = seatLimitFor(req.user.plan, await billingOf(req.user.id));
    if (seatsUsed >= limit) {
      return res.status(402).json({ error: `Your account allows ${limit} seat${limit === 1 ? '' : 's'}. Upgrade to invite more people.` });
    }

    const alreadyInvited = await get('SELECT id FROM team_members WHERE email = ?', [normalizedEmail]);
    if (alreadyInvited) return res.status(409).json({ error: 'That email has already been invited to a Sieve account.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days
    const id = crypto.randomUUID();
    await run(
      'INSERT INTO team_members (id, account_id, email, invite_token_hash, invite_expires_at, active) VALUES (?, ?, ?, ?, ?, 0)',
      [id, req.user.id, normalizedEmail, hashToken(token), expiresAt]
    );

    await teamInviteEmail(normalizedEmail, req.user.business_name, token).catch(err => console.error('[team] invite email failed:', err));
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:memberId', requireAuth, async (req, res, next) => {
  try {
    if (!req.isOwner) return res.status(403).json({ error: 'Only the account owner can remove team members.' });
    const member = await get('SELECT * FROM team_members WHERE id = ? AND account_id = ?', [req.params.memberId, req.user.id]);
    if (!member) return res.status(404).json({ error: 'Team member not found.' });
    await run('DELETE FROM team_members WHERE id = ?', [member.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
