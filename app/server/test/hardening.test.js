// Second security pass (Nov 2026): one Paystack payment can only be used once, no fake payments on the live server,
// signed-in requests must come from Sieve's own pages, and the smaller input checks. Runs against real Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, cleanupDb, makeClient } = require('./helpers');

let server, a, b;

test.before(async () => {
  server = await startServer();
  a = makeClient(server.baseUrl);
  b = makeClient(server.baseUrl);
  await a.post('/api/auth/signup', { businessName: 'Payer A', email: 'payer-a@test.com', password: 'password123' });
  await b.post('/api/auth/signup', { businessName: 'Payer B', email: 'payer-b@test.com', password: 'password123' });
});
test.after(async () => { await server.close(); await cleanupDb(); });

test('a credit payment adds credits once; replaying it (same or another account) adds nothing', async () => {
  const first = await a.post('/api/billing/credits/verify', { reference: 'ref-replay-1', bundleKey: 'starter50' });
  assert.equal(first.status, 200);
  assert.equal(first.data.creditBalance, 50);
  const again = await a.post('/api/billing/credits/verify', { reference: 'ref-replay-1', bundleKey: 'starter50' });
  assert.equal(again.status, 409);
  const other = await b.post('/api/billing/credits/verify', { reference: 'ref-replay-1', bundleKey: 'starter50' });
  assert.equal(other.status, 409);
  assert.equal((await a.get('/api/billing/wallet')).data.creditBalance, 50);
  assert.equal((await b.get('/api/billing/wallet')).data.creditBalance, 0);
});

test('two requests racing with the same payment: only one wins', async () => {
  const [x, y] = await Promise.all([
    a.post('/api/billing/credits/verify', { reference: 'ref-race-1', bundleKey: 'growth200' }),
    a.post('/api/billing/credits/verify', { reference: 'ref-race-1', bundleKey: 'growth200' }),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal((await a.get('/api/billing/wallet')).data.creditBalance, 250);
});

test('a payment used for credits cannot also buy a plan or save a card', async () => {
  assert.equal((await a.post('/api/billing/verify', { reference: 'ref-replay-1', plan: 'starter' })).status, 409);
  assert.equal((await a.post('/api/billing/cpl/save-card', { reference: 'ref-replay-1' })).status, 409);
  assert.equal((await a.post('/api/billing/verify', { reference: 'ref-plan-1', plan: 'starter' })).status, 200);
  assert.equal((await b.post('/api/billing/verify', { reference: 'ref-plan-1', plan: 'starter' })).status, 409);
});

test('odd payment references and made-up bundle names are refused', async () => {
  assert.equal((await a.post('/api/billing/credits/verify', { reference: { $ne: 1 }, bundleKey: 'starter50' })).status, 400);
  assert.equal((await a.post('/api/billing/credits/verify', { reference: 'x'.repeat(200), bundleKey: 'starter50' })).status, 400);
  assert.equal((await a.post('/api/billing/credits/verify', { reference: 'ref-proto', bundleKey: '__proto__' })).status, 400);
  assert.equal((await a.post('/api/billing/verify', { reference: 'ref-proto2', plan: 'toString' })).status, 400);
});

test('on the live server a missing Paystack key refuses payments instead of faking success', async () => {
  const { verifyTransaction, chargeAuthorization } = require('../paystack');
  const env = process.env.NODE_ENV, key = process.env.PAYSTACK_SECRET_KEY;
  process.env.NODE_ENV = 'production'; delete process.env.PAYSTACK_SECRET_KEY;
  try {
    await assert.rejects(verifyTransaction('anything', { expectedAmountKobo: 658900 }));
    await assert.rejects(chargeAuthorization({ authorizationCode: 'x', email: 'a@b.ng', amountKobo: 100 }));
  } finally {
    process.env.NODE_ENV = env; if (key) process.env.PAYSTACK_SECRET_KEY = key;
  }
});

test('a signed-in change with no origin at all is refused (browsers always send one)', async () => {
  // log in by hand to get a cookie, then send a change without Origin/Referer/Sec-Fetch-Site
  const login = await fetch(server.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'payer-a@test.com', password: 'password123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const bare = await fetch(server.baseUrl + '/api/billing/mode', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ mode: 'credits' }) });
  assert.equal(bare.status, 403);
  const same = await fetch(server.baseUrl + '/api/billing/mode', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: server.baseUrl }, body: JSON.stringify({ mode: 'credits' }) });
  assert.equal(same.status, 200);
});

test('the session cookie is HttpOnly, SameSite and site-wide; __Host- prefix on the live site', async () => {
  const login = await fetch(server.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'payer-b@test.com', password: 'password123' }) });
  const sc = login.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i); assert.match(sc, /Path=\//);
  const { execFileSync } = require('node:child_process');
  const name = execFileSync(process.execPath, ['-e', "process.env.JWT_SECRET='x';console.log(require('./auth').COOKIE_NAME)"], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production' } }).toString().trim();
  assert.equal(name, '__Host-sieve_session');
});

test('forms with the wrong kind of value get a clear 400, not a crash', async () => {
  const anon = makeClient(server.baseUrl);
  assert.equal((await anon.post('/api/auth/forgot-password', { email: ['a@b.ng'] })).status, 400);
  assert.equal((await anon.post('/api/auth/signup', { businessName: { x: 1 }, email: 'q@q.ng', password: 'password123' })).status, 400);
  assert.equal((await a.post('/api/team/invite', { email: 'not-an-email' })).status, 400);
  assert.equal((await a.post('/api/team/invite', { email: 42 })).status, 400);
});

test('report links only accept a real lead id', async () => {
  const r = await fetch(server.baseUrl + "/api/public/leads/'%20OR%201=1--/report.pdf");
  assert.equal(r.status, 404);
});

test('one account cannot read, change or delete another account\'s scorecard', async () => {
  const mine = await a.post('/api/scorecards', { title: 'Private card' });
  const id = mine.data.scorecard.id;
  assert.equal((await b.get(`/api/scorecards/${id}`)).status, 404);
  assert.equal((await b.get(`/api/scorecards/${id}/leads`)).status, 404);
  assert.equal((await b.put(`/api/scorecards/${id}`, { title: 'Hijacked' })).status, 404);
  assert.equal((await b.post(`/api/scorecards/${id}/publish`, { published: true })).status, 404);
  assert.equal((await b.del(`/api/scorecards/${id}`)).status, 404);
  assert.equal((await b.post('/api/admin/overview')).status, 404);
  assert.equal((await b.get('/api/admin/overview')).status, 403);
  assert.equal((await a.get(`/api/scorecards/${id}`)).data.scorecard.title, 'Private card');
});
