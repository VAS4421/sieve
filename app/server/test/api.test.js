const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, cleanupDb, makeClient } = require('./helpers');

let server, client, ownerClient;

before(async () => {
  server = await startServer();
  client = makeClient(server.baseUrl);
});

after(async () => {
  await server.close();
  await cleanupDb();
});

test('signup creates an account and starts a session', async () => {
  const res = await client.post('/api/auth/signup', {
    businessName: 'Test Realty',
    email: 'owner@test.com',
    password: 'password123',
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.business_name, 'Test Realty');
  assert.equal(res.data.user.plan, 'free');
  ownerClient = client;
});

test('signing up with a duplicate email is rejected', async () => {
  const res = await client.post('/api/auth/signup', {
    businessName: 'Another Business',
    email: 'owner@test.com',
    password: 'password123',
  });
  assert.equal(res.status, 409);
});

test('login fails with the wrong password', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post('/api/auth/login', { email: 'owner@test.com', password: 'wrongpassword' });
  assert.equal(res.status, 401);
});

test('login succeeds with the right password', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post('/api/auth/login', { email: 'owner@test.com', password: 'password123' });
  assert.equal(res.status, 200);
});

test('/api/auth/me requires a session', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.get('/api/auth/me');
  assert.equal(res.status, 401);
});

let scorecardId, slug;

test('an authenticated user can create a scorecard', async () => {
  const res = await ownerClient.post('/api/scorecards', { title: 'Buyer Readiness' });
  assert.equal(res.status, 201);
  assert.equal(res.data.scorecard.title, 'Buyer Readiness');
  assert.equal(res.data.scorecard.published, false);
  scorecardId = res.data.scorecard.id;
  slug = res.data.scorecard.slug;
});

test('saving a scorecard with fewer than 2 options on a question is rejected', async () => {
  const res = await ownerClient.put(`/api/scorecards/${scorecardId}`, {
    title: 'Buyer Readiness',
    categories: [{ key: 'fit', label: 'Fit' }],
    questions: [{ text: 'Q1', options: [{ label: 'Only one', score: { fit: 5 } }] }],
  });
  assert.equal(res.status, 400);
});

test('a valid save persists questions, scoring weights, owner-written personalization copy, and a brand override', async () => {
  const res = await ownerClient.put(`/api/scorecards/${scorecardId}`, {
    title: 'Buyer Readiness',
    brandName: 'Client Realty Co',
    categories: [{ key: 'fit', label: 'Fit', highMessage: 'You are financially ready to move fast.' }],
    questions: [{ text: 'Ready to buy?', options: [
      { label: 'Yes', score: { fit: 10 }, insight: 'Great — that means we can move on this immediately.' },
      { label: 'No', score: { fit: 0 } },
    ] }],
    tiers: [
      { min: 75, label: 'Sales-ready', headline: 'You are ready to buy', recommendation: 'Book a viewing this week.', recommendationUrl: 'https://example.com/book' },
      { min: 0, label: 'Building the basics' },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.scorecard.questions.length, 1);
  assert.equal(res.data.scorecard.questions[0].options[0].insight, 'Great — that means we can move on this immediately.');
  assert.equal(res.data.scorecard.tiers[0].recommendation, 'Book a viewing this week.');
  assert.equal(res.data.scorecard.brandName, 'Client Realty Co');
});

test('an unpublished scorecard is not reachable by the public endpoint', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.get(`/api/public/scorecards/${slug}`);
  assert.equal(res.status, 404);
});

test('publishing makes the scorecard reachable, and it hides scoring weights', async () => {
  const pub = await ownerClient.post(`/api/scorecards/${scorecardId}/publish`, { published: true });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.scorecard.published, true);

  const anon = makeClient(server.baseUrl);
  const res = await anon.get(`/api/public/scorecards/${slug}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.questions[0].options[0].label, 'Yes');
  assert.equal(res.data.questions[0].options[0].score, undefined); // weights never reach the browser
  assert.equal(res.data.brandName, 'Client Realty Co'); // the scorecard's own brand override, not the account's
});

test('a scorecard with no brand override falls back to the account\'s own business name', async () => {
  // This account is on the free plan (1 scorecard cap, asserted in the signup
  // test above) and already owns one scorecard from an earlier test in this
  // file — bump it to a paid plan here, the same direct-DB pattern used in
  // billing.test.js, purely so this test can create a second one.
  const { run } = require('../db');
  await run("UPDATE users SET plan = 'business', has_ever_paid = true WHERE email = ?", ['owner@test.com']);
  const created = await ownerClient.post('/api/scorecards', { title: 'No Override Card' });
  await ownerClient.put(`/api/scorecards/${created.data.scorecard.id}`, {
    title: 'No Override Card',
    categories: [{ key: 'fit', label: 'Fit' }],
    questions: [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }],
  });
  await ownerClient.post(`/api/scorecards/${created.data.scorecard.id}/publish`, { published: true });

  const anon = makeClient(server.baseUrl);
  const res = await anon.get(`/api/public/scorecards/${created.data.scorecard.slug}`);
  assert.equal(res.data.brandName, 'Test Realty'); // the account's own business_name, from signup
});

let submittedLeadId;

test('submitting the right number of answers computes a real score with personalized copy', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, {
    firstName: 'Chidi', lastName: 'Okoro', phone: '08012345678', email: 'chidi@example.com', answers: [0],
  });
  assert.equal(res.status, 201);
  assert.ok(res.data.leadId);
  submittedLeadId = res.data.leadId;   // set first, so the PDF test below doesn't fail just because a copy check here did
  assert.ok(res.data.reportUrl.includes(res.data.leadId));
  assert.equal(res.data.brandName, 'Client Realty Co'); // the scorecard's own override, used for the PDF/email

  const p = res.data.personalization;
  assert.equal(p.overall, 100);
  assert.equal(p.greetingName, 'Chidi');
  assert.equal(p.tierHeadline, 'You are ready to buy'); // owner-written, takes precedence over generated
  assert.equal(p.recommendation, 'Book a viewing this week.');
  assert.equal(p.recommendationUrl, 'https://example.com/book');
  assert.equal(p.categoryNarratives[0].message, 'You are financially ready to move fast.'); // owner-written
  assert.equal(p.answerInsights[0].insight, 'Great — that means we can move on this immediately.'); // owner-written

  submittedLeadId = res.data.leadId;
});

test('the lead can download their own PDF report using just their lead id', async () => {
  const res = await fetch(`${server.baseUrl}/api/public/leads/${submittedLeadId}/report.pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});

test('a made-up lead id does not return a report', async () => {
  const res = await fetch(`${server.baseUrl}/api/public/leads/00000000-0000-0000-0000-000000000000/report.pdf`);
  assert.equal(res.status, 404);
});

test('submitting a mismatched number of answers is rejected', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, { answers: [0, 0] });
  assert.equal(res.status, 400);
});

test('the lead from the earlier submission shows up in the owner leads list', async () => {
  const res = await ownerClient.get(`/api/scorecards/${scorecardId}/leads`);
  assert.equal(res.status, 200);
  assert.equal(res.data.leads.length, 1);
  assert.equal(res.data.leads[0].firstName, 'Chidi');
  assert.equal(res.data.leads[0].overallScore, 100);
});

test('start events are tracked and feed the completion rate in the aggregate report', async () => {
  const anon = makeClient(server.baseUrl);
  // This scorecard already has 1 completed lead from the earlier submit test,
  // with zero recorded starts so far. Record 2 starts now — completion rate
  // should come out to 1 completed / 2 started = 50%.
  const s1 = await anon.post(`/api/public/scorecards/${slug}/start`);
  const s2 = await anon.post(`/api/public/scorecards/${slug}/start`);
  assert.equal(s1.status, 201);
  assert.equal(s2.status, 201);

  const report = await ownerClient.get(`/api/scorecards/${scorecardId}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.data.started, 2);
  assert.equal(report.data.completed, 1);
  assert.equal(report.data.completionRate, 50);
  assert.equal(report.data.averageOverall, 100);
  assert.equal(report.data.categoryAverages[0].avgScore, 100);

  const tier = report.data.tierBreakdown.find(t => t.label === 'Sales-ready');
  assert.equal(tier.count, 1);
  assert.equal(tier.pct, 100);
  assert.equal(report.data.trend.length, 14);
});

test('completion rate is clamped at 100% even if completed exceeds started', async () => {
  // Simulates a real edge case: a submission that lands without a matching
  // /start event (a blocked beacon, a retried submit, a second tab).
  const created = await ownerClient.post('/api/scorecards', { title: 'Edge Case Card' });
  const scId = created.data.scorecard.id;
  await ownerClient.put(`/api/scorecards/${scId}`, {
    title: 'Edge Case Card',
    categories: [{ key: 'fit', label: 'Fit' }],
    questions: [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }],
  });
  const pub = await ownerClient.post(`/api/scorecards/${scId}/publish`, { published: true });
  const edgeSlug = pub.data.scorecard.slug;

  const anon = makeClient(server.baseUrl);
  await anon.post(`/api/public/scorecards/${edgeSlug}/start`);
  await anon.post(`/api/public/scorecards/${edgeSlug}/submit`, { firstName: 'A', lastName: 'B', phone: '08040000000', email: 'edge1@test.com', answers: [0] });
  await anon.post(`/api/public/scorecards/${edgeSlug}/submit`, { firstName: 'C', lastName: 'D', phone: '08040000001', email: 'edge2@test.com', answers: [0] }); // no matching second /start

  const report = await ownerClient.get(`/api/scorecards/${scId}/report`);
  assert.equal(report.data.started, 1);
  assert.equal(report.data.completed, 2);
  assert.equal(report.data.completionRate, 100); // clamped, not 200
});

test('a scorecard nobody has taken yet reports a null completion rate, not a divide-by-zero', async () => {
  const created = await ownerClient.post('/api/scorecards', { title: 'Untouched Card' });
  const report = await ownerClient.get(`/api/scorecards/${created.data.scorecard.id}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.data.started, 0);
  assert.equal(report.data.completed, 0);
  assert.equal(report.data.completionRate, null);
});

test('another logged-in user cannot see or edit someone else\'s scorecard', async () => {
  const other = makeClient(server.baseUrl);
  await other.post('/api/auth/signup', { businessName: 'Rival Co', email: 'rival@test.com', password: 'password123' });
  const res = await other.get(`/api/scorecards/${scorecardId}`);
  assert.equal(res.status, 404);
});

test('the owner can fetch a real, valid QR code PNG for their own scorecard', async () => {
  const res = await client.rawGet(`/api/scorecards/${scorecardId}/qr.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await res.arrayBuffer());
  // PNG magic bytes — confirms this is a real image, not an empty or error body.
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('a QR code for a scorecard belonging to someone else 404s, same as viewing/editing it does', async () => {
  const other = makeClient(server.baseUrl);
  await other.post('/api/auth/signup', { businessName: 'Rival QR Co', email: 'rivalqr@test.com', password: 'password123' });
  const res = await other.rawGet(`/api/scorecards/${scorecardId}/qr.png`);
  assert.equal(res.status, 404);
});

test('server source code and env files are never reachable through the static file server', async () => {
  // The marketing site's static serving is broad by necessity (loose files at
  // the repo root) — this is the one thing that must never regress, since a
  // real .env file living on the same filesystem would leak live credentials.
  for (const path of ['/app/server/db.js', '/app/server/.env', '/app/server/routes/billing.js']) {
    const res = await client.rawGet(path);
    assert.equal(res.status, 404, `expected 404 for ${path}, got ${res.status}`);
  }
});
