// Abandoned-quiz email nudge job — fires every 5 minutes.
// Emails visitors who filled the gate form but never submitted,
// 30+ minutes after they started. Business/Pro/Enterprise plans only.

const { all, run } = require('./db');
const { sendEmail, appUrl, escapeHtml } = require('./mailer');

const NUDGE_PLANS = new Set(['business', 'pro', 'enterprise']);
const NUDGE_DELAY_MINUTES = 30;
const JOB_INTERVAL_MS = 5 * 60 * 1000;

async function runNudgeJob() {
  try {
    const rows = await all(`
      SELECT ns.id, ns.first_name, ns.email, ns.scorecard_slug,
             sc.title AS scorecard_title,
             u.plan, u.business_name AS owner_name
      FROM scorecard_nudge_starts ns
      JOIN scorecards sc ON sc.id = ns.scorecard_id
      JOIN users u ON u.id = sc.user_id
      WHERE ns.completed_at IS NULL
        AND ns.nudge_sent_at IS NULL
        AND ns.email IS NOT NULL
        AND ns.created_at < now() - interval '${NUDGE_DELAY_MINUTES} minutes'
    `, []);

    for (const row of rows) {
      if (!NUDGE_PLANS.has(row.plan)) continue;
      const brandName = row.owner_name || 'Sieve';
      const link = `${appUrl()}/take/index.html?slug=${encodeURIComponent(row.scorecard_slug)}`;
      await sendEmail({
        to: row.email,
        subject: `You didn't finish — here's your ${row.scorecard_title} result waiting`,
        html: `<p>Hi ${escapeHtml(row.first_name || 'there')},</p>
               <p>You started the <strong>${escapeHtml(row.scorecard_title)}</strong> scorecard from <strong>${escapeHtml(brandName)}</strong> but didn't finish.</p>
               <p>Your personalised result is just a few questions away.</p>
               <p><a href="${escapeHtml(link)}">Continue where you left off →</a></p>`,
      });
      await run('UPDATE scorecard_nudge_starts SET nudge_sent_at = now() WHERE id = ?', [row.id]);
    }
  } catch (err) {
    console.error('[nudge] job error:', err);
  }
}

function startNudgeJob() {
  setInterval(runNudgeJob, JOB_INTERVAL_MS);
  console.log(`[nudge] abandoned-quiz email job started — checks every ${JOB_INTERVAL_MS / 60000} minutes`);
}

module.exports = { startNudgeJob };
