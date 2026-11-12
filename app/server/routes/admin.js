// VASNET's admin view of the whole platform: every business, its scorecards and leads, and recent leads across
// all of Sieve. Read-only. Only the account owner (not a team member) of an admin account can reach it:
// users.is_admin = true, or the account's email listed in the ADMIN_EMAILS setting (comma-separated).
const express = require('express');
const { get, all } = require('../db');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

const { isAdminUser } = require('../adminAccess');

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user, req.isOwner)) return res.status(403).json({ error: 'Admins only.' });
  next();
}

router.get('/overview', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const totals = await get(`SELECT
        (SELECT COUNT(*) FROM users) AS businesses,
        (SELECT COUNT(*) FROM scorecards) AS scorecards,
        (SELECT COUNT(*) FROM scorecards WHERE published = 1) AS live,
        (SELECT COUNT(*) FROM leads) AS leads,
        (SELECT COUNT(*) FROM leads WHERE created_at::timestamptz > now() - interval '7 days') AS leads_week,
        (SELECT COUNT(*) FROM users WHERE created_at::timestamptz > now() - interval '7 days') AS signups_week,
        (SELECT COALESCE(SUM(amount_kobo), 0) FROM credit_purchases) AS credit_kobo,
        (SELECT COALESCE(SUM(amount_kobo), 0) FROM cpl_charges WHERE status = 'success') AS cpl_kobo`);
    const businesses = await all(`SELECT u.id, u.business_name, u.email, u.plan, u.billing_mode, u.credit_balance, u.has_ever_paid, u.plan_expires_at, u.created_at,
        (SELECT COUNT(*) FROM scorecards s WHERE s.user_id = u.id) AS scorecards,
        (SELECT COUNT(*) FROM scorecards s WHERE s.user_id = u.id AND s.published = 1) AS live,
        (SELECT COUNT(*) FROM leads l JOIN scorecards s ON s.id = l.scorecard_id WHERE s.user_id = u.id) AS leads,
        (SELECT MAX(l.created_at) FROM leads l JOIN scorecards s ON s.id = l.scorecard_id WHERE s.user_id = u.id) AS last_lead
      FROM users u ORDER BY u.created_at DESC LIMIT 1000`);
    const scorecards = await all(`SELECT s.id, s.slug, s.title, s.published, s.created_at, s.updated_at, u.business_name,
        (SELECT COUNT(*) FROM leads l WHERE l.scorecard_id = s.id) AS leads,
        (SELECT COUNT(*) FROM scorecard_starts st WHERE st.scorecard_id = s.id) AS starts
      FROM scorecards s JOIN users u ON u.id = s.user_id ORDER BY s.updated_at DESC LIMIT 1000`);
    const leads = await all(`SELECT l.id, l.first_name, l.last_name, l.phone, l.email, l.overall_score, l.tier, l.created_at, s.title AS scorecard, s.slug, u.business_name
      FROM leads l JOIN scorecards s ON s.id = l.scorecard_id JOIN users u ON u.id = s.user_id ORDER BY l.created_at DESC LIMIT 300`);
    res.json({ totals, businesses, scorecards, leads });
  } catch (err) { next(err); }
});

module.exports = router;
