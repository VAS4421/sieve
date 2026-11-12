// Security checks that don't need a database: headers, HTTPS, CSRF, script nonces, input cleaning, uploads, lockout.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-security-tests-only';
const sec = require('../security');

test('links a visitor can click must be plain http(s)', () => {
  assert.equal(sec.safeHttpUrl('https://wa.me/2348031234567'), 'https://wa.me/2348031234567');
  assert.equal(sec.safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(sec.safeHttpUrl('JaVaScRiPt:alert(1)'), '');
  assert.equal(sec.safeHttpUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(sec.safeHttpUrl('https://x.com/"><script>'), '');
  assert.equal(sec.safeCoverImage('/uploads/abc-123.png'), '/uploads/abc-123.png');
  assert.equal(sec.safeCoverImage('/uploads/../server/.env'), '');
  assert.equal(sec.safeCoverImage("x') ; background:url(javascript:alert(1)"), '');
});

test('score tiers are cleaned: bad links dropped, lengths capped, scores bounded', () => {
  const [t] = sec.sanitizeTiers([{ min: 250, label: 'Hot', recommendation: 'x'.repeat(5000), recommendationUrl: 'javascript:alert(document.cookie)', recommendationLabel: 'Book', extra: { evil: true } }]);
  assert.equal(t.min, 100); assert.equal(t.recommendation.length, 800); assert.equal(t.recommendationUrl, undefined); assert.equal(t.extra, undefined);
  const [ok] = sec.sanitizeTiers([{ min: 70, label: 'Ready', recommendationUrl: 'https://calendly.com/me', signs: ['a', 'b'] }]);
  assert.equal(ok.recommendationUrl, 'https://calendly.com/me'); assert.deepEqual(ok.signs, ['a', 'b']);
  assert.deepEqual(sec.sanitizeCategories([{ key: 'money<script>', label: 'Money' }, { key: '', label: 'x' }]), [{ key: 'moneyscript', label: 'Money' }]);
});

test('the result page button never links to javascript:, even from old saved data', () => {
  const { buildPersonalizedResult } = require('../personalize');
  const scorecard = { title: 'T', categories: JSON.stringify([{ key: 'a', label: 'A' }]), questions: JSON.stringify([{ text: 'Q?', options: [{ label: 'Yes', score: { a: 10 } }, { label: 'No', score: { a: 0 } }] }]),
    tiers: JSON.stringify([{ min: 0, label: 'Any', recommendation: 'Talk to us', recommendationUrl: 'javascript:alert(1)' }]), profile_capture: '{}' };
  const p = buildPersonalizedResult({ scorecard, lead: { firstName: 'A' }, answers: [0], categoryScores: { a: 100 }, overall: 100, tierLabel: 'Any', leadId: 'x' });
  assert.ok(!String(p.recommendationUrl || '').toLowerCase().startsWith('javascript'), 'no script link');
});

test('uploaded pictures must really be pictures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-up-'));
  const png = path.join(dir, 'a.png'); fs.writeFileSync(png, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]));
  const fake = path.join(dir, 'b.png'); fs.writeFileSync(fake, '<script>alert(1)</script>');
  const html = path.join(dir, 'c.html'); fs.writeFileSync(html, '<html>');
  assert.equal(sec.imageBytesOk(png), true); assert.equal(sec.imageBytesOk(fake), false); assert.equal(sec.imageBytesOk(html), false);
});

test('8 wrong passwords lock that email for 15 minutes', () => {
  const e = 'lock-test@x.ng';
  for (let i = 0; i < 7; i++) sec.loginFailed(e);
  assert.equal(sec.loginLocked(e), 0);
  sec.loginFailed(e);
  assert.ok(sec.loginLocked(e) > 0);
  sec.loginSucceeded(e); assert.equal(sec.loginLocked(e), 0);
});

test('passwords: 8 to 72 characters; emails must look real', () => {
  assert.ok(sec.passwordProblem('short')); assert.ok(sec.passwordProblem('x'.repeat(73))); assert.equal(sec.passwordProblem('a-good-password'), '');
  assert.equal(sec.emailOk('a@b.ng'), true); assert.equal(sec.emailOk('not-an-email'), false);
});

test('server: headers, CSRF, script nonces, framing rules', async () => {
  const app = require('../index');
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/login.html');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
    assert.ok(nonce, 'pages carry a script nonce');
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'inline scripts without the nonce are refused');
    const html = await page.text();
    assert.ok(html.includes(`<script nonce="${nonce}"`), 'the page\'s own scripts carry it');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(page.headers.get('x-powered-by'), null);
    const take = await fetch(base + '/take/index.html');
    assert.match(take.headers.get('content-security-policy'), /frame-ancestors \*/, 'the scorecard can be embedded on business websites');
    assert.equal(take.headers.get('x-frame-options'), null);
    // CSRF: a request from another website is refused before it reaches the login code
    const evil = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(evil.status, 403);
    const evil2 = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' });
    assert.equal(evil2.status, 403);
    // the server's own files are never served
    assert.equal((await fetch(base + '/app/server/db.js')).status, 404);
    assert.equal((await fetch(base + '/app/server/.env')).status, 404);
    // admin needs a login
    assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
    // a forged session cookie is refused
    assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie: 'sieve_session=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.' } })).status, 401);
  } finally { server.close(); }
});
