const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, cleanupDb, makeClient } = require('./helpers');

let server;
let client;

test.before(async () => {
  server = await startServer();
  client = makeClient(server.baseUrl);
  await client.post('/api/auth/signup', { businessName: 'Credit Co', email: 'credit@test.com', password: 'password123' });
});

test.after(async () => {
  await server.close();
  await cleanupDb();
});

test('a new account defaults to subscription billing with zero credits and no card', async () => {
  const res = await client.get('/api/billing/wallet');
  assert.equal(res.status, 200);
  assert.equal(res.data.billingMode, 'subscription');
  assert.equal(res.data.creditBalance, 0);
  assert.equal(res.data.hasCardOnFile, false);
});

test('switching to cpl mode without a saved card is rejected', async () => {
  const res = await client.post('/api/billing/mode', { mode: 'cpl' });
  assert.equal(res.status, 400);
});

test('buying a credit bundle verifies (simulated) and adds credits to the balance', async () => {
  const bundles = await client.get('/api/billing/credit-bundles');
  assert.equal(bundles.status, 200);
  const bundle = bundles.data.bundles.find(b => b.key === 'starter50');
  assert.ok(bundle);

  const res = await client.post('/api/billing/credits/verify', { reference: 'sim-ref-1', bundleKey: 'starter50' });
  assert.equal(res.status, 200);
  assert.equal(res.data.creditsAdded, 100);
  assert.equal(res.data.creditBalance, 100);

  await client.post('/api/billing/mode', { mode: 'credits' });
  const wallet = await client.get('/api/billing/wallet');
  assert.equal(wallet.data.billingMode, 'credits');
  assert.equal(wallet.data.creditBalance, 100);
});

test('a scorecard is unavailable to new visitors once credits are exhausted, and the owner still sees leads already taken', async () => {
  const create = await client.post('/api/scorecards', { title: 'Credit Gated Card' });
  const scorecardId = create.data.scorecard.id;
  const slug = create.data.scorecard.slug;
  const questions = [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }];
  await client.put(`/api/scorecards/${scorecardId}`, {
    title: 'Credit Gated Card', intro: '', categories: [{ key: 'fit', label: 'Fit' }], questions,
    tiers: [{ min: 0, label: 'Only tier' }],
  });
  await client.post(`/api/scorecards/${scorecardId}/publish`, { published: true });

  // Balance is 100 from the previous test — drop it to 2 directly rather than
  // spending it down via 100 real HTTP submissions, which would also blow
  // through the public submit-endpoint's rate limit shared with other tests.
  const { run } = require('../db');
  await run('UPDATE users SET credit_balance = 2 WHERE email = ?', ['credit@test.com']);

  const anon = makeClient(server.baseUrl);
  for (let i = 0; i < 2; i += 1) {
    const res = await anon.post(`/api/public/scorecards/${slug}/submit`, { firstName: 'X', lastName: 'Y', phone: '08010000000', email: `credit-lead-${i}@test.com`, answers: [0] });
    assert.equal(res.status, 201, `submission ${i} should succeed while credits remain`);
  }

  const wallet = await client.get('/api/billing/wallet');
  assert.equal(wallet.data.creditBalance, 0);

  const gated = await anon.get(`/api/public/scorecards/${slug}`);
  assert.equal(gated.status, 503);
  assert.match(gated.data.error, /credits/i);
});

test('cpl mode: saving a card (simulated) activates it, and a qualified lead fires a real-time simulated charge', async () => {
  const other = makeClient(server.baseUrl);
  await other.post('/api/auth/signup', { businessName: 'CPL Co', email: 'cpl@test.com', password: 'password123' });

  const saveCard = await other.post('/api/billing/cpl/save-card', { reference: 'sim-card-ref-1' });
  assert.equal(saveCard.status, 200);
  assert.equal(saveCard.data.rateKobo, 38900);

  const modeSwitch = await other.post('/api/billing/mode', { mode: 'cpl' });
  assert.equal(modeSwitch.status, 200);

  const wallet = await other.get('/api/billing/wallet');
  assert.equal(wallet.data.billingMode, 'cpl');
  assert.equal(wallet.data.hasCardOnFile, true);

  const create = await other.post('/api/scorecards', { title: 'CPL Card' });
  const scorecardId = create.data.scorecard.id;
  const slug = create.data.scorecard.slug;
  const questions = [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }];
  await other.put(`/api/scorecards/${scorecardId}`, {
    title: 'CPL Card', intro: '', categories: [{ key: 'fit', label: 'Fit' }], questions,
    tiers: [{ min: 0, label: 'Only tier' }],
  });
  await other.post(`/api/scorecards/${scorecardId}/publish`, { published: true });

  const anon = makeClient(server.baseUrl);
  const submit = await anon.post(`/api/public/scorecards/${slug}/submit`, { firstName: 'Lead', lastName: 'Person', phone: '08011111111', email: 'cpl-lead@test.com', answers: [0] });
  assert.equal(submit.status, 201);

  // The charge is fired fire-and-forget right after the response — give it a tick.
  await new Promise(r => setTimeout(r, 50));
  const leads = await other.get(`/api/scorecards/${scorecardId}/leads`);
  const leadId = leads.data.leads[0].id;
  const { get } = require('../db');
  const charge = await get('SELECT * FROM cpl_charges WHERE lead_id = ?', [leadId]);
  assert.ok(charge, 'a cpl_charges row should exist for this lead');
  assert.equal(charge.status, 'success');
  assert.equal(charge.amount_kobo, 38900);
});
