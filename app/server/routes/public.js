const express = require('express');
const crypto = require('node:crypto');
const { run, get } = require('../db');
const { computeScore } = require('../scoring');
const { publicQuestion, validateAnswers } = require('../questions');
const { buildPersonalizedResult } = require('../personalize');
const { buildReportPdf } = require('../pdf');
const rateLimit = require('../middleware/rateLimit');
const { newLeadEmail, leadResultsEmail, creditsExhaustedEmail, appUrl } = require('../mailer');
const { AGE_RANGES, GENDERS, SOCIAL_CLASSES, LOCATIONS, parseProfileCapture } = require('../demographics');
const { chargeCplLead } = require('./billing');
const { deliver, leadPayload } = require('../webhooks');

const router = express.Router();

// Looser than the auth limiter — this endpoint takes real visitor traffic,
// but still needs a ceiling against a scripted submission flood.
const submitLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, message: 'Too many submissions from this connection — try again shortly.' });
const startLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 120, message: 'Too many requests from this connection — try again shortly.' });

// A scorecard's own brand_name (set in the builder — the agency/white-label
// case) wins; otherwise it falls back to the account owner's business name.
async function resolveBrandName(scorecardRow) {
  if (scorecardRow.brand_name && scorecardRow.brand_name.trim()) return scorecardRow.brand_name.trim();
  const owner = await get('SELECT business_name FROM users WHERE id = ?', [scorecardRow.user_id]);
  return (owner && owner.business_name) || 'Sieve';
}

// Usage-based billing check, run only when a NEW visitor loads a scorecard —
// never mid-quiz. Subscription mode has no per-response gate at all (that's
// the whole point of a flat monthly fee). Credits mode blocks once the
// balance has run out; CPL mode blocks if no card is on file to charge.
// Returns null when the scorecard is available, or a user-facing reason.
const FREE_PLAN_RESPONSE_LIMIT = 10;

// Monthly response quotas by plan (subscription mode only).
const RESPONSE_LIMITS = { free: 10, starter: 100, business: 500, pro: 1000, enterprise: Infinity };

// One brand-neutral message for every gated reason below — a random visitor
// never needs (or should see) *why* a scorecard stopped accepting responses
// (out of credits, no card on file, past the free-plan limit) — that's not a
// professional thing to air to the public. The real reason still reaches the
// owner: see the credits-exhausted email + dashboard/billing banner below.
const GATED_MESSAGES = {
  freePlanLimit: "This scorecard isn't accepting responses right now — please check back soon.",
  subscriptionExpired: "This scorecard isn't accepting responses right now — please check back soon.",
  creditsExhausted: "This scorecard isn't accepting new responses right now — the owner is out of credits.",
  cplFailing: "This scorecard isn't accepting responses right now — please check back soon.",
  monthlyQuotaExceeded: "This scorecard isn't accepting new responses right now — the monthly quota has been reached.",
};

async function billingGate(scorecardRow) {
  const owner = await get(
    'SELECT billing_mode, credit_balance, paystack_authorization_code, cpl_charge_failing, has_ever_paid, plan_expires_at, plan, monthly_responses_used, monthly_reset_at, is_admin FROM users WHERE id = ?',
    [scorecardRow.user_id]
  );
  if (!owner) return null;

  // Internal/operator accounts are never gated — see requireAdmin.js.
  if (owner.is_admin) return null;

  // has_ever_paid is a one-way flag (set the first time a subscription
  // payment, a credit top-up, or a CPL card save succeeds — see billing.js —
  // and never cleared again), so an account that has paid before can never
  // fall back into the free-trial allowance again, no matter what its
  // current billing_mode or balance is. This replaces an earlier version of
  // this check that inferred "never paid" from current state, which broke
  // the moment someone drained a credit balance back to 0.
  if (!owner.has_ever_paid) {
    const { count } = await get('SELECT COUNT(*) as count FROM leads WHERE scorecard_id = ?', [scorecardRow.id]);
    if (Number(count) >= FREE_PLAN_RESPONSE_LIMIT) return GATED_MESSAGES.freePlanLimit;
    return null;
  }

  // No recurring charge behind subscription mode — plan_expires_at is set
  // 30 days out on each successful payment (see billing.js /verify), so a
  // lapsed subscription that was never renewed gates the same as any other
  // exhausted billing mode instead of silently staying open forever.
  if (owner.billing_mode === 'subscription') {
    if (owner.plan_expires_at && new Date(owner.plan_expires_at) < new Date()) return GATED_MESSAGES.subscriptionExpired;

    // Monthly response quota check for subscription plans.
    const limit = RESPONSE_LIMITS[owner.plan] ?? RESPONSE_LIMITS.free;
    if (limit !== Infinity) {
      const now = new Date();
      const resetAt = owner.monthly_reset_at ? new Date(owner.monthly_reset_at) : null;
      // Reset counter if it has never been set or if more than 30 days have passed.
      if (!resetAt || now - resetAt > 30 * 24 * 60 * 60 * 1000) {
        await run('UPDATE users SET monthly_responses_used = 0, monthly_reset_at = now() WHERE id = ?', [scorecardRow.user_id]);
        owner.monthly_responses_used = 0;
      }
      if (Number(owner.monthly_responses_used) >= limit) {
        return GATED_MESSAGES.monthlyQuotaExceeded;
      }
    }
    return null;
  }
  if (owner.billing_mode === 'credits' && owner.credit_balance <= 0) return GATED_MESSAGES.creditsExhausted;
  if (owner.billing_mode === 'cpl' && (!owner.paystack_authorization_code || owner.cpl_charge_failing)) return GATED_MESSAGES.cplFailing;
  return null;
}

// Shapes the profile-capture config for the public gate — the option lists a
// visitor picks from live here (never invented client-side), so aggregation
// in the report always lines up cleanly against a fixed vocabulary.
// Landing sections and lead-form settings the quiz page needs.
function publicPageSettings(row) {
  const pc = parseProfileCapture(row.profile_capture);
  return { leadCapture: pc.leadCapture, landing: pc.landing, theme: pc.theme, results: pc.results };
}

function publicProfileCapture(row) {
  const pc = parseProfileCapture(row.profile_capture);
  if (!pc.enabled) return { enabled: false };
  return {
    enabled: true,
    captureAge: pc.captureAge, ageRanges: pc.captureAge ? AGE_RANGES : [],
    captureGender: pc.captureGender, genders: pc.captureGender ? GENDERS : [],
    captureLocation: pc.captureLocation, locations: pc.captureLocation ? LOCATIONS : [],
    captureSocialClass: pc.captureSocialClass, socialClasses: pc.captureSocialClass ? SOCIAL_CLASSES : [],
    interestQuestion: pc.interestQuestion || '',
    interestOptions: pc.interestOptions || [],
  };
}

// Validates a submitted profile against the scorecard's own enabled fields —
// required whenever the owner turned a field on, same as name/email are
// required today, so the report is built from real, complete answers.
function validateProfile(pc, profile) {
  if (!pc.enabled) return { ok: true, clean: null };
  const p = profile && typeof profile === 'object' ? profile : {};
  const clean = {};

  if (pc.captureAge) {
    if (!AGE_RANGES.includes(p.ageRange)) return { ok: false, error: 'Please select an age range.' };
    clean.ageRange = p.ageRange;
  }
  if (pc.captureGender) {
    if (!GENDERS.includes(p.gender)) return { ok: false, error: 'Please select a gender option.' };
    clean.gender = p.gender;
  }
  if (pc.captureLocation) {
    if (!LOCATIONS.includes(p.location)) return { ok: false, error: 'Please select a location.' };
    clean.location = p.location;
  }
  if (pc.captureSocialClass) {
    if (!SOCIAL_CLASSES.includes(p.socialClass)) return { ok: false, error: 'Please select an income bracket.' };
    clean.socialClass = p.socialClass;
  }
  if (pc.interestOptions && pc.interestOptions.length) {
    if (!pc.interestOptions.includes(p.interest)) return { ok: false, error: 'Please select an interest.' };
    clean.interest = p.interest;
  }
  return { ok: true, clean };
}

// What an anonymous visitor is allowed to see before taking a scorecard —
// question text and option labels only. Scoring weights and insight copy
// never reach the browser before it's their own result.
router.get('/scorecards/:slug', async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM scorecards WHERE slug = ? AND published = 1', [req.params.slug]);
    if (!row) return res.status(404).json({ error: 'This scorecard is not available.' });
    const gateReason = await billingGate(row);
    if (gateReason) return res.status(503).json({ error: gateReason });

    const questions = JSON.parse(row.questions).map(publicQuestion);

    res.json({
      slug: row.slug,
      title: row.title,
      intro: row.intro,
      brandName: await resolveBrandName(row),
      coverImage: row.cover_image || '',
      engagementMode: !!row.engagement_mode,
      shareTemplate: row.share_template || '',
      profileCapture: publicProfileCapture(row),
      ...publicPageSettings(row),
      questions,
    });
  } catch (err) {
    next(err);
  }
});

// Fired once when a visitor gets past the gate — powers the completion-rate
// figure in the aggregate report (Signal Desk). No lead identity here, just a
// count; the person may still never finish.
router.post('/scorecards/:slug/start', startLimiter, async (req, res, next) => {
  try {
    const row = await get('SELECT id FROM scorecards WHERE slug = ? AND published = 1', [req.params.slug]);
    if (!row) return res.status(404).json({ error: 'This scorecard is not available.' });
    await run('INSERT INTO scorecard_starts (id, scorecard_id) VALUES (?, ?)', [crypto.randomUUID(), row.id]);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/scorecards/:slug/submit', submitLimiter, async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM scorecards WHERE slug = ? AND published = 1', [req.params.slug]);
    if (!row) return res.status(404).json({ error: 'This scorecard is not available.' });

    const { firstName, lastName, phone, email, profile, timeToCompleteSeconds } = req.body || {};
    const questions = JSON.parse(row.questions);

    const checked = validateAnswers(questions, (req.body || {}).answers);
    if (checked.error && checked.error.startsWith('Answers do not match')) return res.status(400).json({ error: checked.error });
    const { leadCapture } = parseProfileCapture(row.profile_capture);
    const phoneNeeded = leadCapture.phone === 'required';
    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || (phoneNeeded && !phone?.trim())) {
      return res.status(400).json({ error: phoneNeeded ? 'Name, phone number, and email are required.' : 'Name and email are required.' });
    }
    if (checked.error) return res.status(400).json({ error: checked.error });
    const { answers } = checked;

    const pc = parseProfileCapture(row.profile_capture);
    const profileCheck = validateProfile(pc, profile);
    if (!profileCheck.ok) return res.status(400).json({ error: profileCheck.error });

    const timeSeconds = Number.isFinite(timeToCompleteSeconds) && timeToCompleteSeconds >= 0
      ? Math.round(timeToCompleteSeconds)
      : null;

    const { categoryScores, overall, tier } = computeScore(row, answers);
    const lead = { firstName, lastName, phone, email };
    const id = crypto.randomUUID();
    const personalization = buildPersonalizedResult({ scorecard: row, lead, answers, categoryScores, overall, tierLabel: tier, leadId: id });
    const brandName = await resolveBrandName(row);

    await run(
      `INSERT INTO leads (id, scorecard_id, first_name, last_name, phone, email, answers, category_scores, overall_score, tier, personalization, profile, time_to_complete_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.id, firstName || null, lastName || null, phone || null, email || null,
        JSON.stringify(answers), JSON.stringify(categoryScores), overall, tier, JSON.stringify(personalization),
        profileCheck.clean ? JSON.stringify(profileCheck.clean) : null, timeSeconds]
    );

    const owner = await get(
      'SELECT id, email, billing_mode, credit_balance, cpl_rate_kobo, paystack_authorization_code, plan FROM users WHERE id = ?',
      [row.user_id]
    );
    const reportUrl = `${appUrl()}/api/public/leads/${id}/report.pdf`;

    // Owner's webhook (Zapier, Make, CRM): fire-and-forget, never blocks the visitor.
    const { integrations } = parseProfileCapture(row.profile_capture);
    if (integrations.webhookUrl) {
      deliver(integrations.webhookUrl, integrations.webhookSecret, leadPayload({
        scorecard: row, leadId: id, lead, overall, tier, categoryScores, personalization, profile: profileCheck.clean, reportUrl,
      })).catch(err => console.error('[public] webhook failed:', err.message));
    }

    // Usage-based billing settles right here, on a successful submission — this
    // is the one moment a respondent is confirmed "qualified," which is what
    // both the credit and pay-per-lead models actually charge for. Never
    // blocks the response the visitor already gave; only affects future ones.
    if (owner && owner.billing_mode === 'credits') {
      try {
        const { rows } = await run('UPDATE users SET credit_balance = credit_balance - 1 WHERE id = ? RETURNING credit_balance', [owner.id]);
        const balanceAfter = rows[0] ? Number(rows[0].credit_balance) : null;
        if (balanceAfter !== null && balanceAfter <= 0) {
          const { changes } = await run(`UPDATE users SET credit_exhausted_notified_at = now() WHERE id = ? AND credit_exhausted_notified_at IS NULL`, [owner.id]);
          if (changes > 0) creditsExhaustedEmail(owner.email, brandName).catch(err => console.error('[public] credits-exhausted email failed:', err));
        }
      } catch (err) {
        console.error('[public] credit deduction failed:', err);
      }

    } else if (owner && owner.billing_mode === 'cpl' && owner.paystack_authorization_code) {
      chargeCplLead({ owner, leadId: id }).catch(err => console.error('[public] CPL charge failed:', err));
    } else if (owner && owner.billing_mode === 'subscription') {
      // Increment the monthly response counter for subscription accounts.
      run('UPDATE users SET monthly_responses_used = monthly_responses_used + 1 WHERE id = ?', [owner.id])
        .catch(err => console.error('[public] monthly response increment failed:', err));
    }

    // Mark nudge-start as completed if the visitor provided a start_id.
    const { nudgeStartId } = req.body || {};
    if (nudgeStartId) {
      run(
        'UPDATE scorecard_nudge_starts SET completed_at = now() WHERE id = ? AND scorecard_id = ?',
        [nudgeStartId, row.id]
      ).catch(err => console.error('[public] nudge start mark-complete failed:', err));
    }

    // PDF plans gate — B3: only Business+ accounts generate a PDF.
    const PDF_PLANS = new Set(['business', 'pro', 'enterprise']);

    // Fire-and-forget — the browser gets its personalized result immediately
    // below; the PDF and emails happen in the background and never block it.
    (async () => {
      let pdfBuffer;
      if (PDF_PLANS.has(owner && owner.plan)) {
        try {
          pdfBuffer = await buildReportPdf(personalization, brandName);
        } catch (err) {
          console.error('[public] PDF generation failed:', err);
        }
      }
      if (email) {
        leadResultsEmail({ to: email, businessName: brandName, personalization, reportUrl, pdfBuffer })
          .catch(err => console.error('[public] lead results email failed:', err));
      }
      if (owner) {
        newLeadEmail(owner.email, row.title, { firstName, lastName, phone, email, overall, tier })
          .catch(err => console.error('[public] new-lead email failed:', err));
      }
    })();

    res.status(201).json({
      leadId: id,
      reportUrl,
      brandName,
      personalization,
      engagementMode: !!row.engagement_mode,
      shareTemplate: row.share_template || '',
      timeToCompleteSeconds: timeSeconds,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/public/scorecard-nudge-starts
// Called by take.js after the gate form — records a visitor who entered contact
// info but has not yet submitted. Only inserts for Business/Pro/Enterprise owners.
router.post('/scorecard-nudge-starts', startLimiter, async (req, res, next) => {
  try {
    const { slug, firstName, lastName, email, phone } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'Missing slug.' });
    const row = await get('SELECT id, user_id, slug FROM scorecards WHERE slug = ? AND published = 1', [slug]);
    if (!row) return res.status(404).json({ error: 'Scorecard not available.' });
    const owner = await get('SELECT plan FROM users WHERE id = ?', [row.user_id]);
    const NUDGE_PLANS = new Set(['business', 'pro', 'enterprise']);
    if (!owner || !NUDGE_PLANS.has(owner.plan)) return res.json({ ok: true, nudgeStartId: null });
    const id = crypto.randomUUID();
    await run(
      'INSERT INTO scorecard_nudge_starts (id, scorecard_id, scorecard_slug, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, row.id, row.slug, firstName || null, lastName || null, email || null, phone || null]
    );
    res.status(201).json({ ok: true, nudgeStartId: id });
  } catch (err) { next(err); }
});

// Lets a lead (re)download their own PDF from the results page or the emailed
// link. Gated only by knowing the lead's own unguessable id — same model as
// the password-reset/invite tokens elsewhere in this app; no login required
// since leads never get an account.
router.get('/leads/:leadId/report.pdf', async (req, res) => {
  try {
    const lead = await get('SELECT * FROM leads WHERE id = ?', [req.params.leadId]);
    if (!lead || !lead.personalization) return res.status(404).json({ error: 'Report not found.' });

    const scorecard = await get('SELECT * FROM scorecards WHERE id = ?', [lead.scorecard_id]);

    const personalization = JSON.parse(lead.personalization);
    const brandName = scorecard ? await resolveBrandName(scorecard) : 'Sieve';
    const pdfBuffer = await buildReportPdf(personalization, brandName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="your-results.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[public] report.pdf generation failed:', err);
    res.status(500).json({ error: 'Could not generate the report right now.' });
  }
});

module.exports = router;
module.exports.publicProfileCapture = publicProfileCapture;
module.exports.publicPageSettings = publicPageSettings;
module.exports.resolveBrandName = resolveBrandName;
