// Fixed option lists for audience-profile capture (Brand Campaign Insight
// Reporting). Fixed, not free-text, so aggregation in the report is clean —
// "Lagos" and "lagos state" never end up as two different bars on a chart.

const AGE_RANGES = ['Under 18', '18-24', '25-34', '35-44', '45-54', '55+'];

const GENDERS = ['Male', 'Female', 'Prefer not to say'];

// Phrased as everyday income brackets, not research jargon (SEC A/B/C/D/E),
// since these are answered by an ordinary respondent, not a market researcher.
const SOCIAL_CLASSES = ['High income', 'Upper middle income', 'Middle income', 'Lower income', 'Prefer not to say'];

const LOCATIONS = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe',
  'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos',
  'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara', 'Outside Nigeria',
];

// Normalizes a profile_capture JSON blob into the full, always-complete shape.
// The column's own DB default is just '{"enabled":false}' — a scorecard that
// was created but never saved through the builder has exactly that, missing
// every other key — so every reader needs this, not just the PUT writer.
function sanitizeProfileCapture(input) {
  const pc = input && typeof input === 'object' ? input : {};
  return {
    enabled: !!pc.enabled,
    captureAge: !!pc.captureAge,
    captureGender: !!pc.captureGender,
    captureLocation: !!pc.captureLocation,
    captureSocialClass: !!pc.captureSocialClass,
    interestQuestion: String(pc.interestQuestion || '').trim().slice(0, 200),
    interestOptions: Array.isArray(pc.interestOptions)
      ? pc.interestOptions.map(o => String(o).trim()).filter(Boolean).slice(0, 12)
      : [],
    leadCapture: sanitizeLeadCapture(pc.leadCapture),
    landing: sanitizeLanding(pc.landing),
    theme: sanitizeTheme(pc.theme),
    results: sanitizeResults(pc.results),
    integrations: sanitizeIntegrations(pc.integrations),
  };
}

// Brand look for the quiz and result pages.
function sanitizeTheme(input) {
  const t = input && typeof input === 'object' ? input : {};
  const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v).toUpperCase() : '');
  const logo = String(t.logo || '').trim().slice(0, 500);
  return {
    accent: hex(t.accent),
    logo: /^(https:\/\/|\/uploads\/|\/covers\/)/.test(logo) && !/["'<>\s()]/.test(logo) ? logo : '',
    font: ['modern', 'classic', 'friendly'].includes(t.font) ? t.font : 'modern',
    corners: ['rounded', 'soft', 'square'].includes(t.corners) ? t.corners : 'rounded',
  };
}

// Where each new lead is sent. Never sent to the quiz page.
function sanitizeIntegrations(input) {
  const i = input && typeof input === 'object' ? input : {};
  let url = String(i.webhookUrl || '').trim().slice(0, 500);
  try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) url = ''; } catch { url = ''; }
  const secret = /^[a-f0-9]{32,64}$/.test(String(i.webhookSecret || '')) ? String(i.webhookSecret) : '';
  return { webhookUrl: url, webhookSecret: secret };
}

// Which result sections show, and in what order. The score reveal always
// comes first; everything else can be moved or hidden.
const RESULT_SECTIONS = ['signs', 'pair', 'map', 'gap', 'areas', 'told', 'cta'];
function sanitizeResults(input) {
  const r = input && typeof input === 'object' ? input : {};
  const order = Array.isArray(r.order) ? r.order.filter((k, i, a) => RESULT_SECTIONS.includes(k) && a.indexOf(k) === i) : [];
  RESULT_SECTIONS.forEach(k => { if (!order.includes(k)) order.push(k); });
  const hidden = Array.isArray(r.hidden) ? r.hidden.filter((k, i, a) => RESULT_SECTIONS.includes(k) && a.indexOf(k) === i) : [];
  // One next-step button used by every tier that has no button of its own.
  let ctaUrl = String(r.ctaUrl || '').trim().slice(0, 500);
  try { const u = new URL(ctaUrl); if (!/^https?:$/.test(u.protocol) || /["'<>\s]/.test(ctaUrl)) ctaUrl = ''; } catch { ctaUrl = ''; }
  const ctaLabel = String(r.ctaLabel || '').trim().slice(0, 60);
  return { order, hidden, ctaUrl, ctaLabel };
}

// Where the lead form sits and what it asks. Stored inside the scorecard's
// existing settings JSON (profile_capture), so no new database columns.
//   position 'start' — before the questions (the original behaviour)
//   position 'end'   — after the questions, just before the result
function sanitizeLeadCapture(input) {
  const lc = input && typeof input === 'object' ? input : {};
  const str = (v, n) => String(v || '').trim().slice(0, n);
  return {
    position: lc.position === 'end' ? 'end' : 'start',
    phone: ['required', 'optional', 'off'].includes(lc.phone) ? lc.phone : 'required',
    headline: str(lc.headline, 120),
    note: str(lc.note, 200),
  };
}

// Extra landing page sections shown before the first question.
function sanitizeLanding(input) {
  const l = input && typeof input === 'object' ? input : {};
  const str = (v, n) => String(v || '').trim().slice(0, n);
  return {
    bullets: Array.isArray(l.bullets) ? l.bullets.map(b => str(b, 120)).filter(Boolean).slice(0, 4) : [],
    audience: str(l.audience, 200),
    trust: str(l.trust, 200),
    button: str(l.button, 40),
  };
}

function parseProfileCapture(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson || '{"enabled":false}');
  } catch {
    parsed = {};
  }
  return sanitizeProfileCapture(parsed);
}

module.exports = { AGE_RANGES, GENDERS, SOCIAL_CLASSES, LOCATIONS, sanitizeProfileCapture, parseProfileCapture, sanitizeLeadCapture, sanitizeLanding, sanitizeTheme, sanitizeResults, sanitizeIntegrations, RESULT_SECTIONS };
