// Sends each new lead to the owner's own URL (Zapier, Make, a CRM, their
// own server). Fire-and-forget: a slow or broken endpoint never affects the
// person taking the scorecard.
//
// Safety: https only, no redirects, a 6-second timeout, and the target host
// must resolve to a public address (no localhost, private networks or cloud
// metadata), so the feature can't be pointed back at Sieve's own network.
// Every request is signed: X-Sieve-Signature = HMAC-SHA256(secret, body).

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

function checkUrlShape(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: 'That doesn\'t look like a web address.' }; }
  if (u.protocol !== 'https:') return { error: 'The webhook address must start with https://' };
  if (u.username || u.password) return { error: 'Remove the username and password from the address.' };
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) return { error: 'That address is not reachable from the internet.' };
  return { url: u };
}

async function assertPublicHost(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(r => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error('That address is not reachable from the internet.');
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliver(urlString, secret, payload) {
  const shape = checkUrlShape(urlString);
  if (shape.error) throw new Error(shape.error);
  await assertPublicHost(shape.url);
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(shape.url, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Sieve-Webhooks/1.0',
        'X-Sieve-Event': payload.event,
        ...(secret ? { 'X-Sieve-Signature': sign(secret, body) } : {}),
      },
      body,
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300 };
  } finally {
    clearTimeout(timer);
  }
}

// The JSON every webhook receives for a new lead.
function leadPayload({ scorecard, leadId, lead, overall, tier, categoryScores, personalization, profile, reportUrl, test = false }) {
  return {
    event: 'lead.created',
    test,
    createdAt: new Date().toISOString(),
    scorecard: { id: scorecard.id, slug: scorecard.slug, title: scorecard.title },
    lead: {
      id: leadId,
      firstName: lead.firstName || '',
      lastName: lead.lastName || '',
      email: lead.email || '',
      phone: lead.phone || '',
      overallScore: overall,
      tier,
      categoryScores,
      aboutYou: (personalization && personalization.aboutYou) || [],
      helpWanted: ((personalization && personalization.helpWanted) || []).map(h => h.question),
      profile: profile || null,
    },
    reportUrl: reportUrl || '',
  };
}

module.exports = { deliver, leadPayload, checkUrlShape, isPrivateIp, sign };
