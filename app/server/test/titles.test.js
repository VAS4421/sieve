const test = require('node:test');
const assert = require('node:assert');
const { TEMPLATES } = require('../template-library');
const TITLES = require('../template-library/titles');

const SHAPES = ['ready', 'strength', 'pain', 'decision', 'type', 'know'];
const INTERNAL_WORDS = /\b(qualifier|pre-?screening|pre-?qualification|needs audit|interest form|registration|assessment|scorecard|starter|triage)\b/i;

test('every template has a customer-facing question title that follows the rule', () => {
  for (const t of TEMPLATES) {
    const entry = TITLES[t.slug];
    assert.ok(entry, `no title for ${t.slug}`);
    assert.ok(SHAPES.includes(entry[0]), `${t.slug}: unknown shape ${entry[0]}`);
    assert.strictEqual(t.title, entry[1]);
    assert.ok(t.title.endsWith('?'), `${t.slug}: title should be a question`);
    assert.ok(t.title.split(/\s+/).length <= 11, `${t.slug}: title too long`);
    assert.ok(/\b(you|your)\b/i.test(t.title), `${t.slug}: title should speak to the customer`);
    assert.ok(!INTERNAL_WORDS.test(t.title), `${t.slug}: title uses an internal word`);
  }
});

test('each title is unique, and every intro is the promise line built from the quiz', () => {
  const seen = new Set();
  for (const t of TEMPLATES) {
    assert.ok(!seen.has(t.title), `duplicate title: ${t.title}`); seen.add(t.title);
    const n = t.questions.filter(q => q.kind !== 'about').length;
    assert.ok(t.intro.startsWith(`Answer ${n} quick questions to see how you score on `), t.slug);
  }
});
