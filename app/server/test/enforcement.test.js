const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, cleanupDb, makeClient } = require('./helpers');
const { run } = require('../db');

let server, owner;

before(async () => {
  server = await startServer();
  owner = makeClient(server.baseUrl);
  await owner.post('/api/auth/signup', { businessName: 'Enforcement Test Co', email: 'enforce@test.com', password: 'password123' });
});

after(async () => {
  await server.close();
  await cleanupDb();
});

// Helper: create a minimal published scorecard
async function makePublishedScorecard(client, title) {
  const created = await client.post('/api/scorecards', { title });
  const id = created.data.scorecard.id;
  await client.put(`/api/scorecards/${id}`, {
    title,
    categories: [{ key: 'fit', label: 'Fit' }],
    questions: [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }],
    tiers: [{ min: 0, label: 'Getting there' }],
  });
  const pub = await client.post(`/api/scorecards/${id}/publish`, { published: true });
  return { id, slug: pub.data.scorecard.slug };
}

// B1 — Scorecard limit: starter plan allows 3, blocks 4th
test('starter plan allows 3 scorecards and blocks the 4th with 402', async () => {
  await run("UPDATE users SET plan = 'starter', has_ever_paid = true, billing_mode = 'subscription', plan_expires_at = now() + interval '30 days' WHERE email = ?", ['enforce@test.com']);
  const c1 = await owner.post('/api/scorecards', { title: 'SC1' });
  assert.equal(c1.status, 201);
  const c2 = await owner.post('/api/scorecards', { title: 'SC2' });
  assert.equal(c2.status, 201);
  const c3 = await owner.post('/api/scorecards', { title: 'SC3' });
  assert.equal(c3.status, 201);
  const c4 = await owner.post('/api/scorecards', { title: 'SC4' });
  assert.equal(c4.status, 402);
  assert.ok(c4.data.error.includes('starter'));
});

// B4 — CSV export gate: free plan gets 402, paid plan gets 200
test('free plan cannot export CSV (402)', async () => {
  // Create a separate free-plan user for this test
  const freeClient = makeClient(server.baseUrl);
  await freeClient.post('/api/auth/signup', { businessName: 'Free Co', email: 'free@test.com', password: 'password123' });
  const { id } = await makePublishedScorecard(freeClient, 'Free CSV Test');
  const res = await freeClient.get(`/api/scorecards/${id}/leads.csv`);
  assert.equal(res.status, 402);
});

test('paid plan can export CSV (200)', async () => {
  // Upgrade owner to business so the scorecard limit allows creating a new one
  await run("UPDATE users SET plan = 'business', has_ever_paid = true, billing_mode = 'subscription', plan_expires_at = now() + interval '30 days' WHERE email = ?", ['enforce@test.com']);
  const { id } = await makePublishedScorecard(owner, 'Paid CSV Test');
  const res = await owner.get(`/api/scorecards/${id}/leads.csv`);
  assert.equal(res.status, 200);
});

// B5 — Advanced insights gate: free plan gets 402, business gets 200
test('free plan cannot access advanced insights report (402)', async () => {
  const freeClient2 = makeClient(server.baseUrl);
  await freeClient2.post('/api/auth/signup', { businessName: 'Free Insights Co', email: 'freeinsights@test.com', password: 'password123' });
  const { id } = await makePublishedScorecard(freeClient2, 'Free Insights Test');
  const res = await freeClient2.get(`/api/scorecards/${id}/report`);
  assert.equal(res.status, 402);
});

test('business plan can access advanced insights report (200)', async () => {
  // Ensure owner is on business plan (may have been changed by earlier tests)
  await run("UPDATE users SET plan = 'business', has_ever_paid = true, billing_mode = 'subscription', plan_expires_at = now() + interval '30 days' WHERE email = ?", ['enforce@test.com']);
  const { id } = await makePublishedScorecard(owner, 'Business Insights Test');
  const res = await owner.get(`/api/scorecards/${id}/report`);
  assert.equal(res.status, 200);
});

// B2 — Monthly response quota: starter at limit blocks scorecard load with 503
test('subscription starter at monthly limit blocks scorecard load (503)', async () => {
  // Create the scorecard on business plan first (owner has too many scorecards for starter limit)
  await run(
    "UPDATE users SET plan = 'business', has_ever_paid = true, billing_mode = 'subscription', plan_expires_at = now() + interval '30 days' WHERE email = ?",
    ['enforce@test.com']
  );
  const { slug } = await makePublishedScorecard(owner, 'Quota Test');
  // Now downgrade to starter at the monthly limit
  await run(
    "UPDATE users SET plan = 'starter', monthly_responses_used = 100, monthly_reset_at = now() WHERE email = ?",
    ['enforce@test.com']
  );
  const anon = makeClient(server.baseUrl);
  const res = await anon.get(`/api/public/scorecards/${slug}`);
  assert.equal(res.status, 503);
});

// B2 — Counter increments on submit (start at 0, submit once, counter is 1)
test('monthly response counter increments on submit', async () => {
  // Create scorecard on business plan first (owner has too many scorecards for starter limit)
  await run(
    "UPDATE users SET plan = 'business', has_ever_paid = true, billing_mode = 'subscription', plan_expires_at = now() + interval '30 days', monthly_responses_used = 0, monthly_reset_at = now() WHERE email = ?",
    ['enforce@test.com']
  );
  // Need a fresh scorecard (quota was at 100 before, now it's 0 so gate passes)
  const { slug } = await makePublishedScorecard(owner, 'Counter Test');
  // Downgrade to starter so response goes through the subscription path with limit check
  await run(
    "UPDATE users SET plan = 'starter', monthly_responses_used = 0, monthly_reset_at = now() WHERE email = ?",
    ['enforce@test.com']
  );
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, {
    firstName: 'Test', lastName: 'User', phone: '08011111111', email: 'testuser@example.com', answers: [0],
  });
  assert.equal(res.status, 201);
  const row = await run("SELECT monthly_responses_used FROM users WHERE email = ?", ['enforce@test.com']);
  // run() returns { changes, rows } — rows[0].monthly_responses_used should be 1
  assert.equal(Number(row.rows[0].monthly_responses_used), 1);
});
