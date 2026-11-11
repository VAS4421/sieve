const test = require('node:test');
const assert = require('node:assert');
const { buildOptions, normalizeQuestion, validateAnswers, readAbout } = require('../questions');
const { computeScore } = require('../scoring');
const { buildPersonalizedResult } = require('../personalize');
const { TEMPLATES } = require('../template-library');

const yes = (text, extra = {}) => normalizeQuestion({ text, kind: 'score', format: 'yesno', cats: ['a'], points: 3, ...extra });
const card = (questions) => ({
  title: 'T', categories: JSON.stringify([{ key: 'a', label: 'Habits' }]), questions: JSON.stringify(questions),
  tiers: JSON.stringify([{ min: 70, label: 'Strong', signs: ['You plan ahead'] }, { min: 0, label: 'Early' }]),
});

test('yes/no builds warm labels and an optional help answer that scores like no', () => {
  const q = yes('Do you plan your week?', { helpOption: true });
  assert.deepStrictEqual(q.options.map(o => o.label), ["Yes, that's me", 'Not yet', "I'd like help with this"]);
  assert.strictEqual(q.options[0].score.a, 3);
  assert.strictEqual(q.options[2].score.a, 0);
  assert.strictEqual(q.options[2].help, true);
});

test('reverse and negative points make "yes" the weaker answer', () => {
  assert.strictEqual(yes('Do you skip meals?', { reverse: true }).options[0].score.a, 0);
  assert.strictEqual(yes('Do you skip meals?', { points: -4 }).options[1].score.a, 4);
});

test('a 1-5 scale spreads the points evenly', () => {
  const q = normalizeQuestion({ text: 'I plan ahead.', kind: 'score', format: 'scale', cats: ['a'], points: 4 });
  assert.deepStrictEqual(q.options.map(o => o.score.a), [0, 1, 2, 3, 4]);
});

test('about-you questions never change the score and are read back', () => {
  const qs = [yes('Do you plan?', { helpOption: true }),
    normalizeQuestion({ text: 'Goal?', kind: 'about', format: 'choice', aboutKey: 'goal', options: [{ label: 'Grow' }, { label: 'Rest' }] }),
    normalizeQuestion({ text: 'Anything else?', kind: 'about', format: 'text', aboutKey: 'note' })];
  const sc = card(qs);
  const a = computeScore(sc, [0, 1, 'hello']);
  const b = computeScore(sc, [0, 0, '']);
  assert.strictEqual(a.overall, 100);
  assert.strictEqual(b.overall, 100);
  const v = validateAnswers(qs, [2, 0, '  my note  ']);
  assert.deepStrictEqual(v.answers, [2, 0, 'my note']);
  const r = readAbout(qs, v.answers);
  assert.strictEqual(r.helpWanted.length, 1);
  assert.deepStrictEqual(r.about.map(x => x.answer), ['Grow', 'my note']);
  const p = buildPersonalizedResult({ scorecard: sc, lead: { firstName: 'Ada' }, answers: v.answers, categoryScores: { a: 0 }, overall: 0, tierLabel: 'Early', leadId: 'x' });
  assert.strictEqual(p.helpWanted.length, 1);
  assert.strictEqual(p.aboutYou.length, 2);
  assert.ok(p.answerInsights.every(i => i.question === 'Do you plan?'));
});

test('text answers are rejected on scored questions', () => {
  assert.ok(validateAnswers([yes('Q?')], ['nope']).error);
});

test('every library template is valid and its best answers score 100%', () => {
  assert.ok(TEMPLATES.length >= 120);
  for (const t of TEMPLATES) {
    const qs = t.questions;
    const best = qs.map(q => q.kind === 'about' ? (q.format === 'text' ? '' : 0)
      : q.options.reduce((bi, o, i, arr) => (Object.values(o.score).reduce((x, y) => x + y, 0) > Object.values(arr[bi].score).reduce((x, y) => x + y, 0) ? i : bi), 0));
    const r = computeScore({ categories: JSON.stringify(t.categories), questions: JSON.stringify(qs), tiers: JSON.stringify(t.tiers) }, best);
    assert.strictEqual(r.overall, 100, t.slug);
  }
});
