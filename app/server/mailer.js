// Thin wrapper around Resend's REST API (https://resend.com) using the built-in
// fetch — no email SDK dependency. If RESEND_API_KEY isn't set, sends are skipped
// and logged instead, so the rest of the app (password reset, invites, lead
// notifications, personalized results) keeps working in local dev without an
// email account.

// Every value below that ends up inside an <html> template comes from data a
// person typed somewhere — a scorecard owner's business name or recommendation
// copy, a respondent's own name/email, a category label. None of it is safe to
// drop into HTML unescaped: a business name of `<script>...` or a category
// label containing `"` would either break the layout or, worse, actually
// execute in whatever inbox renders it. escapeHtml() is applied to every one
// of those interpolations below — the only exception is content this file
// itself builds server-side from fixed markup (colors, percentages, style
// attributes), which never contains anything a user typed.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A URL used as an href needs two different protections: HTML-entity escaping
// (so a `&` in the URL doesn't break the attribute), and scheme validation —
// recommendationUrl is written by a scorecard owner in the builder, and
// nothing stops someone from typing `javascript:...` there instead of a real
// link. Only http/https links are ever rendered as a clickable href; anything
// else is dropped rather than guessed at.
function safeHref(url) {
  const trimmed = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return escapeHtml(trimmed);
}

async function sendEmail({ to, subject, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Sieve <onboarding@resend.dev>';

  if (!apiKey && process.env.NODE_ENV === 'production') {
    console.error(`[mailer] RESEND_API_KEY not set on the live server — email "${subject}" not sent.`);
    return { skipped: true };
  }
  if (!apiKey) {
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const linkLines = links.length ? `\n  Link: ${links.join('\n        ')}` : '';
    const attachmentLine = attachments && attachments.length ? `\n  Attachment: ${attachments.map(a => a.filename).join(', ')}` : '';
    console.log(`[mailer] RESEND_API_KEY not set — email not sent.\n  To: ${to}\n  Subject: ${subject}\n  Body: ${plain}${linkLines}${attachmentLine}`);
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html, ...(attachments ? { attachments } : {}) }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[mailer] Resend send failed (${res.status}): ${body}`);
    return { skipped: false, ok: false };
  }
  return { skipped: false, ok: true };
}

function appUrl() {
  return process.env.APP_URL || 'http://localhost:5500';
}

function passwordResetEmail(email, token) {
  const link = `${appUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to: email,
    subject: 'Reset your Sieve password',
    html: `<p>Someone requested a password reset for this account.</p>
           <p><a href="${escapeHtml(link)}">Click here to set a new password</a> — this link expires in 1 hour.</p>
           <p>If you didn't request this, you can ignore this email.</p>`,
  });
}

function teamInviteEmail(email, businessName, token) {
  const link = `${appUrl()}/accept-invite.html?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to: email,
    subject: `You've been invited to ${businessName} on Sieve`,
    html: `<p>You've been invited to join <strong>${escapeHtml(businessName)}</strong>'s Sieve account.</p>
           <p><a href="${escapeHtml(link)}">Click here to accept and set a password</a> — this link expires in 3 days.</p>`,
  });
}

function newLeadEmail(ownerEmail, scorecardTitle, lead) {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Someone';
  return sendEmail({
    to: ownerEmail,
    subject: `New lead on "${scorecardTitle}" — ${lead.overall}% (${lead.tier})`,
    html: `<p><strong>${escapeHtml(name)}</strong> just completed <strong>${escapeHtml(scorecardTitle)}</strong>.</p>
           <p>Score: <strong>${lead.overall}%</strong> — ${escapeHtml(lead.tier)}</p>
           ${lead.phone ? `<p>Phone: ${escapeHtml(lead.phone)}</p>` : ''}
           ${lead.email ? `<p>Email: ${escapeHtml(lead.email)}</p>` : ''}`,
  });
}

// Sent once — the moment an owner's response-credit balance actually hits
// zero — not on every later visit while it stays at zero (see the
// credit_exhausted_notified_at guard in routes/public.js). Clears and can
// fire again the next time the balance runs out after a top-up.
function creditsExhaustedEmail(ownerEmail, businessName) {
  return sendEmail({
    to: ownerEmail,
    subject: `${businessName || 'Your'} Sieve response credits have run out`,
    html: `<p>Your response credit balance just hit <strong>0</strong>.</p>
           <p>Your scorecards are still live and their links still work, but new visitors won't be able to submit a response — or get a result — until you top up.</p>
           <p><a href="${appUrl()}/billing.html">Top up your credits</a> to start collecting leads again.</p>`,
  });
}

const BAND_COLOR = { strong: '#16825D', developing: '#B3720C', weak: '#B3261E' };

// The email a LEAD receives about their own result — built entirely from the
// personalization bundle (personalize.js), so it matches the results page and
// the PDF exactly. pdfBuffer is optional — attached as a real PDF when present.
function leadResultsEmail({ to, businessName, personalization, reportUrl, pdfBuffer }) {
  const categoryRows = personalization.categoryNarratives.map(c => `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#14162B;font-weight:600;width:140px;">${escapeHtml(c.label)}</td>
      <td style="padding:6px 0;">
        <div style="background:#EEEBE2;border-radius:4px;height:8px;width:160px;overflow:hidden;">
          <div style="background:${BAND_COLOR[c.band] || '#4A4E68'};height:8px;width:${c.score}%;"></div>
        </div>
      </td>
      <td style="padding:6px 0 6px 10px;font-size:13px;font-weight:700;color:#14162B;">${c.score}%</td>
    </tr>
    <tr><td colspan="3" style="padding:0 0 14px;font-size:13px;color:#4A4E68;">${escapeHtml(c.message)}</td></tr>
  `).join('');

  const recommendationHref = safeHref(personalization.recommendationUrl);
  const ctaBlock = personalization.recommendation
    ? `<div style="background:#F7E2D3;border-radius:10px;padding:18px 20px;margin-top:24px;">
         <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#5C220A;">${escapeHtml(personalization.ctaHeadline || 'Want to go deeper on your results?')}</p>
         <p style="margin:0 0 10px;font-size:13.5px;color:#14162B;">${escapeHtml(personalization.recommendation)}</p>
         ${recommendationHref ? `<a href="${recommendationHref}" style="font-size:13.5px;font-weight:700;color:#1F5FE0;">${escapeHtml(personalization.recommendationLabel || 'Book Now')} →</a>` : ''}
       </div>`
    : '';

  const reportHref = safeHref(reportUrl);
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">
      <p style="font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#C1501F;">${escapeHtml(businessName || 'Sieve')}</p>
      <h2 style="font-size:20px;color:#14162B;margin:6px 0 4px;">Hi ${escapeHtml(personalization.greetingName)}, here's your ${escapeHtml(personalization.scorecardTitle)} result</h2>
      <p style="font-size:32px;font-weight:800;color:#14162B;margin:14px 0 2px;">${personalization.overall}%</p>
      <p style="font-size:14px;font-weight:700;color:#C1501F;margin:0 0 14px;">${escapeHtml(personalization.tierHeadline)}</p>
      ${personalization.tierMessage ? `<p style="font-size:14px;color:#4A4E68;line-height:1.6;">${escapeHtml(personalization.tierMessage)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;margin-top:16px;">${categoryRows}</table>
      ${ctaBlock}
      ${reportHref ? `<p style="margin-top:24px;font-size:12.5px;color:#8285A0;">You can also view this online any time: <a href="${reportHref}" style="color:#1F5FE0;">${reportHref}</a></p>` : ''}
    </div>
  `;

  return sendEmail({
    to,
    subject: `${personalization.greetingName}, here's your ${personalization.scorecardTitle} result — ${personalization.overall}%`,
    html,
    attachments: pdfBuffer ? [{ filename: 'your-results.pdf', content: pdfBuffer.toString('base64') }] : undefined,
  });
}

module.exports = { sendEmail, passwordResetEmail, teamInviteEmail, newLeadEmail, leadResultsEmail, creditsExhaustedEmail, appUrl, escapeHtml, safeHref };