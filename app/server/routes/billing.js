const express = require('express');
const crypto = require('node:crypto');
const { run, get } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const { verifyTransaction, chargeAuthorization, refundTransaction } = require('../paystack');
const { sendEmail, appUrl } = require('../mailer');

const router = express.Router();

// Public config the browser needs to open the Paystack popup — the secret key
// never leaves the server.
router.get('/config', (req, res) => {
  res.json({ paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || null });
});

const PLAN_PRICES_KOBO = {
  starter: 1148900,   // ₦11,489 a month (100 responses)
  business: 4488900,  // ₦44,889 a month (500 responses)
  pro: 7488900,       // ₦74,889 a month (1,000 responses)
};

router.get('/plan-prices', (req, res) => {
  res.json({ plans: Object.entries(PLAN_PRICES_KOBO).map(([key, amountKobo]) => ({ key, amountKobo })) });
});

// Called after Paystack's popup reports success client-side. We re-verify the
// transaction server-side with the secret key before trusting it — never trust
// a "success" callback from the browser alone. (Subscriptions — kept as a
// secondary billing mode alongside credits and pay-per-lead below.)
router.post('/verify', requireAuth, async (req, res) => {
  const { reference, plan } = req.body || {};
  if (!reference || !PLAN_PRICES_KOBO[plan]) {
    return res.status(400).json({ error: 'Missing payment reference or unknown plan.' });
  }
  try {
    const data = await verifyTransaction(reference, { expectedAmountKobo: PLAN_PRICES_KOBO[plan] });
    if (!data.status || data.data.status !== 'success') {
      return res.status(402).json({ error: 'Payment was not successful.' });
    }
    if (data.data.amount !== PLAN_PRICES_KOBO[plan]) {
      return res.status(402).json({ error: 'Amount paid does not match the selected plan.' });
    }
    // No recurring charge behind this — the business is expected to come
    // back and pay again next month. plan_expires_at is how a lapsed
    // subscription gets detected (see billingGate and scorecards.js's
    // create-gate) once that month is up.
    await run(
      "UPDATE users SET plan = ?, has_ever_paid = true, plan_expires_at = now() + interval '30 days' WHERE id = ?",
      [plan, req.user.id]
    );
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Paystack to verify this payment. Try again.' });
  }
});

// --- Credit bundles (prepaid response credits — Nigerian SMEs who don't want
// a recurring subscription top up in one go, spend it down as leads come in) ---

const CREDIT_BUNDLES = {
  starter50: { credits: 50, amountKobo: 658900, label: '50 credits — ₦6,589' },
  growth200: { credits: 200, amountKobo: 2177200, label: '200 credits — ₦21,772', badge: 'Most Popular' },
  scale1000: { credits: 1000, amountKobo: 8788900, label: '1,000 credits — ₦87,889', badge: 'Best Value' },
};

router.get('/credit-bundles', (req, res) => {
  res.json({ bundles: Object.entries(CREDIT_BUNDLES).map(([key, b]) => ({ key, ...b })) });
});

router.post('/credits/verify', requireAuth, async (req, res) => {
  const { reference, bundleKey } = req.body || {};
  const bundle = CREDIT_BUNDLES[bundleKey];
  if (!reference || !bundle) {
    return res.status(400).json({ error: 'Missing payment reference or unknown bundle.' });
  }
  try {
    const data = await verifyTransaction(reference, { expectedAmountKobo: bundle.amountKobo });
    if (!data.status || data.data.status !== 'success') {
      return res.status(402).json({ error: 'Payment was not successful.' });
    }
    if (data.data.amount !== bundle.amountKobo) {
      return res.status(402).json({ error: 'Amount paid does not match the selected bundle.' });
    }
    await run('UPDATE users SET credit_balance = credit_balance + ?, credit_exhausted_notified_at = NULL, has_ever_paid = true WHERE id = ?', [bundle.credits, req.user.id]);
    await run(
      'INSERT INTO credit_purchases (id, user_id, amount_kobo, credits_added, paystack_reference) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomUUID(), req.user.id, bundle.amountKobo, bundle.credits, reference]
    );
    const updated = await get('SELECT credit_balance FROM users WHERE id = ?', [req.user.id]);
        res.json({ ok: true, creditsAdded: bundle.credits, creditBalance: updated.credit_balance });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Paystack to verify this payment. Try again.' });
  }
});

// --- Pay-per-qualified-lead (CPL) — no upfront spend at all; a card is saved
// once via a ₦100 verification charge, then each qualified lead is billed
// individually in real time as it comes in. ---

const CPL_DEFAULT_RATE_KOBO = 38900; // ₦389 per qualified lead (accounts that saved a card earlier keep the rate they signed up at)
const CARD_VERIFY_AMOUNT_KOBO = 10000; // ₦100 — this charge only proves the card is real, it's never kept. Paystack itself never refunds it automatically (see refundTransaction in paystack.js) — we request the refund ourselves, right after verification, so it's automatic from the cardholder's side without anyone at the business doing it by hand.

router.get('/cpl-rate', (req, res) => {
  res.json({ rateKobo: CPL_DEFAULT_RATE_KOBO });
});

router.post('/cpl/save-card', requireAuth, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'Missing payment reference.' });
  try {
    const data = await verifyTransaction(reference, { expectedAmountKobo: CARD_VERIFY_AMOUNT_KOBO });
    if (!data.status || data.data.status !== 'success') {
      return res.status(402).json({ error: 'Card verification was not successful.' });
    }
    // Matches the same check /verify and /credits/verify already do — without
    // it, any successful Paystack reference (paid for any amount, for
    // anything) would be accepted as a valid card verification.
    if (data.data.amount !== CARD_VERIFY_AMOUNT_KOBO) {
      return res.status(402).json({ error: 'Amount charged for card verification does not match.' });
    }
    const authCode = data.data.authorization && data.data.authorization.authorization_code;
    if (!authCode) {
      return res.status(502).json({ error: 'Paystack did not return a reusable card authorization. Try a different card.' });
    }
    await run(
      'UPDATE users SET paystack_authorization_code = ?, cpl_rate_kobo = ?, cpl_charge_failing = false, has_ever_paid = true WHERE id = ?',
      [authCode, CPL_DEFAULT_RATE_KOBO, req.user.id]
    );
    // Request the refund
    let refundInitiated = false;
    try {
      const refund = await refundTransaction(reference, { merchantNote: 'Sieve card-verification charge — refunded automatically.' });
      refundInitiated = !!refund.status;
      if (!refund.status) console.error('[billing] card-verify refund request was not accepted by Paystack:', refund.message || refund);
    } catch (refundErr) {
      console.error('[billing] card-verify refund request failed:', refundErr);
    }
    res.json({ ok: true, rateKobo: CPL_DEFAULT_RATE_KOBO, refundInitiated });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Paystack to verify this card. Try again.' });
  }
});

// Switches which billing mode new charges/deductions use. Subscription is the
// default/secondary fallback; credits and cpl both require their own setup
// step to have already happened (a positive balance, or a saved card).
router.post('/mode', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!['subscription', 'credits', 'cpl'].includes(mode)) {
      return res.status(400).json({ error: 'Unknown billing mode.' });
    }
    const user = await get('SELECT credit_balance, paystack_authorization_code, cpl_charge_failing FROM users WHERE id = ?', [req.user.id]);
    if (mode === 'cpl' && !user.paystack_authorization_code) {
      return res.status(400).json({ error: 'Save a card for pay-per-lead billing before switching to it.' });
    }
    if (mode === 'cpl' && user.cpl_charge_failing) {
      return res.status(400).json({ error: 'Your card on file is failing to charge — replace it before switching back to pay-per-lead.' });
    }
    await run('UPDATE users SET billing_mode = ? WHERE id = ?', [mode, req.user.id]);
    res.json({ ok: true, billingMode: mode });
  } catch (err) {
    console.error('[billing] /mode failed:', err);
    res.status(500).json({ error: 'Could not switch billing mode. Try again.' });
  }
});

// Response limits: free accounts get 10 responses per scorecard; subscriptions get a monthly allowance (then credits).
const FREE_PLAN_RESPONSE_LIMIT = 10;
const RESPONSE_LIMITS = { free: 10, starter: 100, business: 500, pro: 1000, enterprise: Infinity };

// How much of its limit an account has used, for the dashboard warning (80% and 100%). The monthly count resets 30 days
// after the last reset, the same rule the response gate in public.js uses.
async function usageFor(user, userId) {
  if (!user.has_ever_paid) {
    const r = await get('SELECT COALESCE(MAX(c), 0) AS used FROM (SELECT COUNT(*) AS c FROM leads l JOIN scorecards s ON s.id = l.scorecard_id WHERE s.user_id = ? GROUP BY s.id) t', [userId]);
    return { kind: 'free', used: Number(r.used), limit: FREE_PLAN_RESPONSE_LIMIT, resetsAt: null };
  }
  if (user.billing_mode !== 'subscription') return null;
  const limit = RESPONSE_LIMITS[user.plan] ?? RESPONSE_LIMITS.free;
  if (!Number.isFinite(limit)) return null;
  const resetAt = user.monthly_reset_at ? new Date(user.monthly_reset_at) : null;
  const fresh = !resetAt || Date.now() - resetAt.getTime() > 30 * 86400000;
  return { kind: 'monthly', used: fresh ? 0 : Number(user.monthly_responses_used) || 0, limit, resetsAt: fresh ? null : new Date(resetAt.getTime() + 30 * 86400000).toISOString() };
}

router.get('/wallet', requireAuth, async (req, res) => {
  const user = await get(
    'SELECT plan, billing_mode, credit_balance, cpl_rate_kobo, paystack_authorization_code, cpl_charge_failing, has_ever_paid, plan_expires_at, monthly_responses_used, monthly_reset_at FROM users WHERE id = ?',
    [req.user.id]
  );
  const { total } = await get(
    'SELECT COALESCE(SUM(credits_added), 0) as total FROM credit_purchases WHERE user_id = ?',
    [req.user.id]
  );
  const creditsPurchasedTotal = Number(total);
  const planExpired = !!user.plan_expires_at && new Date(user.plan_expires_at) < new Date();
  res.json({
    plan: user.plan,
    billingMode: user.billing_mode,
    creditBalance: user.credit_balance,
    creditsPurchasedTotal,
    creditsUsed: Math.max(0, creditsPurchasedTotal - user.credit_balance),
    cplRateKobo: user.cpl_rate_kobo || CPL_DEFAULT_RATE_KOBO,
    hasCardOnFile: !!user.paystack_authorization_code,
    cplChargeFailing: !!user.cpl_charge_failing,
    hasEverPaid: !!user.has_ever_paid,
    planExpiresAt: user.plan_expires_at,
    planExpired,
    usage: await usageFor(user, req.user.id),
  });
});

module.exports = router;
module.exports.CREDIT_BUNDLES = CREDIT_BUNDLES;
module.exports.RESPONSE_LIMITS = RESPONSE_LIMITS;
module.exports.FREE_PLAN_RESPONSE_LIMIT = FREE_PLAN_RESPONSE_LIMIT;
module.exports.CPL_DEFAULT_RATE_KOBO = CPL_DEFAULT_RATE_KOBO;
module.exports.CARD_VERIFY_AMOUNT_KOBO = CARD_VERIFY_AMOUNT_KOBO;

// Flags the account so billingGate (routes/public.js) and the
// scorecard-creation cap (routes/scorecards.js) stop collecting further
// leads, and emails the owner what happened and why. Awaited by both call
// sites below (not fire-and-forget) so the block is reliably in place before
// chargeCplLead returns. cpl/save-card is the only place that clears the flag
// again, once the owner replaces their card.
async function markCplChargeFailed(owner) {
  try {
    await run('UPDATE users SET cpl_charge_failing = true WHERE id = ?', [owner.id]);
  } catch (err) {
    console.error('[billing] setting cpl_charge_failing failed:', err);
  }
  sendEmail({
    to: owner.email,
    subject: 'Sieve — we could not charge your card for a new lead',
    html: `<p>A new qualified lead came in, but charging your card on file for it didn't go through — this lead is still saved in your dashboard either way.</p>
           <p><strong>Because of this, your scorecards have stopped accepting new responses</strong> until this is fixed — visitors won't be able to submit or get a result until you sort your card out.</p>
           <p><a href="${appUrl()}/billing.html">Replace your card in Billing</a> to start collecting leads again.</p>`,
  }).catch(err => console.error('[billing] CPL failure notice email failed:', err));
}

// Shared helper used by public.js right after a CPL-mode submission — fires
// a real-time charge against the owner's saved card for one qualified lead
// and logs the attempt either way. A failure blocks further leads until the
// owner fixes their card — see markCplChargeFailed above. Because that block
// takes effect immediately, in practice no *new* lead can reach this
// function again after the first failure — the next attempt only happens
// once cpl/save-card clears the flag.
async function chargeCplLead({ owner, leadId }) {
  const id = crypto.randomUUID();
  try {
    const data = await chargeAuthorization({
      authorizationCode: owner.paystack_authorization_code,
      email: owner.email,
      amountKobo: owner.cpl_rate_kobo || CPL_DEFAULT_RATE_KOBO,
    });
    const success = data.status && data.data && data.data.status === 'success';
    await run(
      'INSERT INTO cpl_charges (id, user_id, lead_id, amount_kobo, status, paystack_reference) VALUES (?, ?, ?, ?, ?, ?)',
      [id, owner.id, leadId, owner.cpl_rate_kobo || CPL_DEFAULT_RATE_KOBO, success ? 'success' : 'failed', (data.data && data.data.reference) || null]
    );
    if (success) {
      // Defensive only — see the comment above for why a failure practically
      // can't be followed by another attempt without cpl/save-card already
      // having cleared this, but keeping it in sync here costs nothing.
      run('UPDATE users SET cpl_charge_failing = false WHERE id = ?', [owner.id])
        .catch(err => console.error('[billing] clearing cpl_charge_failing failed:', err));
    } else {
      await markCplChargeFailed(owner);
    }
    return success;
  } catch (err) {
    await run(
      'INSERT INTO cpl_charges (id, user_id, lead_id, amount_kobo, status) VALUES (?, ?, ?, ?, ?)',
      [id, owner.id, leadId, owner.cpl_rate_kobo || CPL_DEFAULT_RATE_KOBO, 'error']
    );
    await markCplChargeFailed(owner);
    console.error('[billing] CPL charge threw:', err);
    return false;
  }
}
module.exports.chargeCplLead = chargeCplLead;
