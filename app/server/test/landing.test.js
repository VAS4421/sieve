const test = require('node:test');
const assert = require('node:assert');
const { sanitizeProfileCapture } = require('../demographics');

test('lead form defaults to the original behaviour: before questions, phone required', () => {
  const pc = sanitizeProfileCapture({});
  assert.deepStrictEqual(pc.leadCapture, { position: 'start', phone: 'required', headline: '', note: '' });
  assert.deepStrictEqual(pc.landing, { bullets: [], audience: '', trust: '', button: '' });
});

test('lead form and landing settings are kept, trimmed and capped', () => {
  const pc = sanitizeProfileCapture({
    leadCapture: { position: 'end', phone: 'optional', headline: '  Where to? ', note: 'x'.repeat(500) },
    landing: { bullets: [' One ', '', 'Two', 'Three', 'Four', 'Five'], audience: 'For salons', trust: 'Private', button: 'Go' },
  });
  assert.strictEqual(pc.leadCapture.position, 'end');
  assert.strictEqual(pc.leadCapture.phone, 'optional');
  assert.strictEqual(pc.leadCapture.headline, 'Where to?');
  assert.strictEqual(pc.leadCapture.note.length, 200);
  assert.deepStrictEqual(pc.landing.bullets, ['One', 'Two', 'Three', 'Four']);
});

test('unknown values fall back safely', () => {
  const pc = sanitizeProfileCapture({ leadCapture: { position: 'middle', phone: 'maybe' } });
  assert.strictEqual(pc.leadCapture.position, 'start');
  assert.strictEqual(pc.leadCapture.phone, 'required');
});

const { sanitizeTheme, sanitizeResults } = require('../demographics');

test('theme accepts a hex colour and safe logo links only', () => {
  assert.strictEqual(sanitizeTheme({ accent: '#12ab34' }).accent, '#12AB34');
  assert.strictEqual(sanitizeTheme({ accent: 'red' }).accent, '');
  assert.strictEqual(sanitizeTheme({ logo: 'javascript:alert(1)' }).logo, '');
  assert.strictEqual(sanitizeTheme({ logo: 'https://x.test/a.png" onerror="x' }).logo, '');
  assert.strictEqual(sanitizeTheme({ logo: '/uploads/abc.png' }).logo, '/uploads/abc.png');
  assert.deepStrictEqual([sanitizeTheme({}).font, sanitizeTheme({}).corners], ['modern', 'rounded']);
});

test('results layout keeps every section exactly once, in the owner order', () => {
  const r = sanitizeResults({ order: ['cta', 'map', 'bogus', 'cta'], hidden: ['pair', 'nope'] });
  assert.deepStrictEqual(r.order.slice(0, 2), ['cta', 'map']);
  assert.strictEqual(r.order.length, 7);
  assert.deepStrictEqual(r.hidden, ['pair']);
});
