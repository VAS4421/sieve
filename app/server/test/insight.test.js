const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, cleanupDb, makeClient } = require('./helpers');

let server, owner;

before(async () => {
  server = await startServer();
  owner = makeClient(server.baseUrl);
  await owner.post('/api/auth/signup', { businessName: 'Insight Test Co', email: 'insight@test.com', password: 'password123' });
  const { run } = require('../db');
  await run("UPDATE users SET plan = 'business', has_ever_paid = true WHERE email = ?", ['insight@test.com']);
});

after(async () => {
  await server.close();
  await cleanupDb();
});

let scorecardId, slug;

test('a scorecard can turn on profile capture and engagement mode', async () => {
  const created = await owner.post('/api/scorecards', { title: 'Skincare Interest Quiz' });
  scorecardId = created.data.scorecard.id;

  const res = await owner.put(`/api/scorecards/${scorecardId}`, {
    title: 'Skincare Interest Quiz',
    categories: [{ key: 'fit', label: 'Fit' }],
    questions: [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }],
    profileCapture: {
      enabled: true, captureAge: true, captureGender: true, captureLocation: true, captureSocialClass: true,
      interestQuestion: 'Which best describes your interest in GlowCo?',
      interestOptions: ['Skincare', 'Haircare', 'Makeup'],
    },
    engagementMode: true,
    shareTemplate: 'I scored {score}% on {title}! Check yours: {link}',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.scorecard.profileCapture.enabled, true);
  assert.equal(res.data.scorecard.profileCapture.interestOptions.length, 3);
  assert.equal(res.data.scorecard.engagementMode, true);

  const pub = await owner.post(`/api/scorecards/${scorecardId}/publish`, { published: true });
  slug = pub.data.scorecard.slug;
});

test('the public scorecard endpoint exposes the fixed option lists for enabled fields only', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.get(`/api/public/scorecards/${slug}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.engagementMode, true);
  assert.ok(res.data.profileCapture.ageRanges.includes('25-34'));
  assert.ok(res.data.profileCapture.locations.includes('Lagos'));
  assert.deepEqual(res.data.profileCapture.interestOptions, ['Skincare', 'Haircare', 'Makeup']);
});

test('submitting without the required profile fields is rejected', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, {
    firstName: 'Ada', answers: [0], profile: {}, timeToCompleteSeconds: 20,
  });
  assert.equal(res.status, 400);
});

test('submitting a profile value outside the fixed option list is rejected', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, {
    firstName: 'Ada', answers: [0], timeToCompleteSeconds: 20,
    profile: { ageRange: '25-34', gender: 'Female', location: 'Narnia', socialClass: 'Middle income', interest: 'Skincare' },
  });
  assert.equal(res.status, 400);
});

test('a valid submission with profile data and timing is accepted and echoed back', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, {
    firstName: 'Ada', lastName: 'Bello', phone: '08022222222', email: 'ada@example.com', answers: [0], timeToCompleteSeconds: 42,
    profile: { ageRange: '25-34', gender: 'Female', location: 'Lagos', socialClass: 'Middle income', interest: 'Skincare' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.engagementMode, true);
  assert.equal(res.data.timeToCompleteSeconds, 42);
  assert.equal(res.data.shareTemplate, 'I scored {score}% on {title}! Check yours: {link}');
});

test('a second submission with different demographics feeds the aggregate breakdown correctly', async () => {
  const anon = makeClient(server.baseUrl);
  const res = await anon.post(`/api/public/scorecards/${slug}/submit`, {
    firstName: 'Tunde', lastName: 'Adeyemi', phone: '08033333333', email: 'tunde@example.com', answers: [1], timeToCompleteSeconds: 18,
    profile: { ageRange: '18-24', gender: 'Male', location: 'Rivers', socialClass: 'Lower income', interest: 'Haircare' },
  });
  assert.equal(res.status, 201);
});

test('the report aggregates demographics, psychographics, and engagement correctly', async () => {
  const r = await owner.get(`/api/scorecards/${scorecardId}/report`);
  assert.equal(r.status, 200);
  assert.equal(r.data.completed, 2);
  assert.equal(r.data.engagementMode, true);
  assert.equal(r.data.averageTimeToCompleteSeconds, 30); // (42 + 18) / 2

  assert.equal(r.data.audience.enabled, true);
  const female = r.data.audience.genderBreakdown.find(g => g.label === 'Female');
  const male = r.data.audience.genderBreakdown.find(g => g.label === 'Male');
  assert.equal(female.count, 1);
  assert.equal(male.count, 1);
  assert.equal(female.pct, 50);

  const lagos = r.data.audience.locationBreakdown.find(l => l.label === 'Lagos');
  assert.equal(lagos.count, 1);

  const skincare = r.data.audience.interestBreakdown.find(i => i.label === 'Skincare');
  assert.equal(skincare.count, 1);
  assert.equal(r.data.audience.interestQuestion, 'Which best describes your interest in GlowCo?');
});

test('a scorecard with profile capture off reports an empty, disabled audience block', async () => {
  // Same free-plan (1 scorecard) cap as api.test.js — this account already
  // owns one scorecard from an earlier test in this file.
  const created = await owner.post('/api/scorecards', { title: 'Plain Lead Form' });
  await owner.put(`/api/scorecards/${created.data.scorecard.id}`, {
    title: 'Plain Lead Form',
    categories: [{ key: 'fit', label: 'Fit' }],
    questions: [{ text: 'Q1', options: [{ label: 'A', score: { fit: 10 } }, { label: 'B', score: { fit: 0 } }] }],
  });
  const r = await owner.get(`/api/scorecards/${created.data.scorecard.id}/report`);
  assert.equal(r.data.audience.enabled, false);
  assert.equal(r.data.audience.ageBreakdown.length, 0);
  assert.equal(r.data.engagementMode, false);
});
