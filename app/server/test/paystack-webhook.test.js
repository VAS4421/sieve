// The Paystack webhook is the backup for when a phone closes the payment window before Sieve hears about the payment.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PAYSTACK_SECRET_KEY = 'sk_test_webhook_secret';
const { startServer, cleanupDb, makeClient } = require('./helpers');

// Paystack's verify API, faked: each test says what Paystack holds for a reference
const paystack = new Map();
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.paystack.co/transaction/verify/')) {
    const ref = decodeURIComponent(u.split('/').pop());
    const tx = paystack.get(ref);
    return new Response(JSON.stringify(tx ? { status: true, data: tx } : { status: false, message: 'Transaction reference not found' }), { status: tx ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

let server, client;
const sign = (s) => crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(s).digest('hex');
const hook = (event, opts = {}) => {
  const body = JSON.stringify(event);
  return realFetch(server.baseUrl + '/api/billing/paystack-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': opts.sig ?? sign(body) }, body });
};
const balance = async () => (await client.get('/api/billing/wallet')).data.creditBalance;

test.before(async () => {
  server = await startServer();
  client = makeClient(server.baseUrl);
  await client.post('/api/auth/signup', { businessName: 'Hook Co', email: 'hook@test.com', password: 'password123' });
});
test.after(async () => { await server.close(); await cleanupDb(); global.fetch = realFetch; });

test('a confirmed payment adds the credits even if the browser never reported it', async () => {
  const { CREDIT_BUNDLES } = require('../routes/billing');
  const b = CREDIT_BUNDLES.starter50;
  paystack.set('ref-closed-window', { status: 'success', reference: 'ref-closed-window', amount: b.amountKobo, currency: 'NGN', customer: { email: 'HOOK@test.com' }, metadata: { product: 'sieve', bundleKey: 'starter50' } });
  const before = await balance();
  const r = await hook({ event: 'charge.success', data: { reference: 'ref-closed-window' } });
  assert.equal(r.status, 200);
  assert.equal(await balance(), before + b.credits);
  // Paystack sends the same event again (retries happen): nothing is added twice
  await hook({ event: 'charge.success', data: { reference: 'ref-closed-window' } });
  assert.equal(await balance(), before + b.credits);
  // and the browser reporting it late is accepted without adding again
  const late = await client.post('/api/billing/credits/verify', { reference: 'ref-closed-window', bundleKey: 'starter50' });
  assert.equal(late.status, 200); assert.equal(late.data.alreadyApplied, true);
  assert.equal(await balance(), before + b.credits);
});

test('an older payment with no tag is matched by its amount', async () => {
  const { CREDIT_BUNDLES } = require('../routes/billing');
  const b = CREDIT_BUNDLES.growth200;
  paystack.set('ref-untagged', { status: 'success', reference: 'ref-untagged', amount: b.amountKobo, currency: 'NGN', customer: { email: 'hook@test.com' }, metadata: { businessName: 'Hook Co' } });
  const before = await balance();
  await hook({ event: 'charge.success', data: { reference: 'ref-untagged' } });
  assert.equal(await balance(), before + b.credits);
});

test('forged, failed, wrong-amount and card-check payments change nothing', async () => {
  const before = await balance();
  paystack.set('ref-forged', { status: 'success', reference: 'ref-forged', amount: 50000, currency: 'NGN', customer: { email: 'hook@test.com' }, metadata: { bundleKey: 'starter50' } });
  assert.equal((await hook({ event: 'charge.success', data: { reference: 'ref-forged' } }, { sig: 'not-paystack' })).status, 401);
  paystack.set('ref-failed', { status: 'failed', reference: 'ref-failed', amount: 50000, currency: 'NGN', customer: { email: 'hook@test.com' }, metadata: { bundleKey: 'starter50' } });
  await hook({ event: 'charge.success', data: { reference: 'ref-failed' } });
  paystack.set('ref-short', { status: 'success', reference: 'ref-short', amount: 12345, currency: 'NGN', customer: { email: 'hook@test.com' }, metadata: { bundleKey: 'growth200' } });
  await hook({ event: 'charge.success', data: { reference: 'ref-short' } });
  paystack.set('ref-card', { status: 'success', reference: 'ref-card', amount: 10000, currency: 'NGN', customer: { email: 'hook@test.com' }, metadata: { purpose: 'cpl-card-verify' } });
  await hook({ event: 'charge.success', data: { reference: 'ref-card' } });
  paystack.set('ref-stranger', { status: 'success', reference: 'ref-stranger', amount: 50000, currency: 'NGN', customer: { email: 'nobody@else.com' }, metadata: { bundleKey: 'starter50' } });
  await hook({ event: 'charge.success', data: { reference: 'ref-stranger' } });
  assert.equal(await balance(), before);
});

test('a plan payment through the webhook switches the plan on', async () => {
  paystack.set('ref-plan', { status: 'success', reference: 'ref-plan', amount: 1148900, currency: 'NGN', customer: { email: 'hook@test.com' }, metadata: { product: 'sieve', plan: 'starter' } });
  await hook({ event: 'charge.success', data: { reference: 'ref-plan' } });
  const w = (await client.get('/api/billing/wallet')).data;
  assert.equal(w.plan, 'starter'); assert.ok(w.planExpiresAt);
});
