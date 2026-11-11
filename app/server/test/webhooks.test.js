const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { isPrivateIp, checkUrlShape, sign, deliver, leadPayload } = require('../webhooks');
const { sanitizeIntegrations } = require('../demographics');

test('private and local addresses are refused', () => {
  ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1'].forEach(ip => assert.ok(isPrivateIp(ip), ip));
  ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'].forEach(ip => assert.ok(!isPrivateIp(ip), ip));
});

test('only https addresses without credentials are accepted', () => {
  assert.ok(checkUrlShape('http://example.com').error);
  assert.ok(checkUrlShape('https://user:pw@example.com').error);
  assert.ok(checkUrlShape('https://localhost/hook').error);
  assert.ok(checkUrlShape('not a url').error);
  assert.ok(checkUrlShape('https://hooks.zapier.com/hooks/catch/1/abc').url);
});

test('delivery to a private address is refused before any request is made', async () => {
  await assert.rejects(deliver('https://127.0.0.1/hook', 's', { event: 'x' }), /not reachable/);
});

test('signature is an HMAC-SHA256 of the body', () => {
  assert.strictEqual(sign('secret', '{"a":1}'), crypto.createHmac('sha256', 'secret').update('{"a":1}').digest('hex'));
});

test('payload carries the lead, about-you answers and help topics', () => {
  const p = leadPayload({ scorecard: { id: 's1', slug: 'x', title: 'X' }, leadId: 'l1', lead: { firstName: 'Ada', email: 'a@b.c' }, overall: 70, tier: 'Strong', categoryScores: { a: 70 },
    personalization: { aboutYou: [{ key: 'goal', answer: 'Grow' }], helpWanted: [{ question: 'Q?' }] }, profile: null, reportUrl: 'r' });
  assert.strictEqual(p.event, 'lead.created');
  assert.deepStrictEqual(p.lead.helpWanted, ['Q?']);
  assert.strictEqual(p.lead.aboutYou[0].answer, 'Grow');
});

test('integration settings keep https URLs and well-formed secrets only', () => {
  assert.strictEqual(sanitizeIntegrations({ webhookUrl: 'http://x.com' }).webhookUrl, '');
  assert.strictEqual(sanitizeIntegrations({ webhookUrl: 'https://x.com/h', webhookSecret: 'zz' }).webhookSecret, '');
  assert.strictEqual(sanitizeIntegrations({ webhookUrl: 'https://x.com/h' }).webhookUrl, 'https://x.com/h');
});
