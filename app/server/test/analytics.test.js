const test = require('node:test');
const assert = require('node:assert');
const { buildAnswerInsights } = require('../analytics');

test('report insights count struggles, help requests and about-you answers', () => {
  const q = [
    { text: 'Do you plan?', kind: 'score', options: [{ label: 'Y', score: { a: 3 } }, { label: 'N', score: { a: 0 } }, { label: 'H', score: { a: 0 }, help: true }] },
    { text: 'Goal?', kind: 'about', options: [{ label: 'Grow' }, { label: 'Rest' }] },
  ];
  const L = (a, pz) => ({ answers: JSON.stringify(a), personalization: JSON.stringify(pz) });
  const r = buildAnswerInsights(q, [
    L([0, 0], { aboutYou: [{ key: 'goal', answer: 'Grow' }] }),
    L([2, 1], { helpWanted: [{ question: 'Do you plan?' }], aboutYou: [{ key: 'goal', answer: 'Rest' }] }),
    L([1, 0], { aboutYou: [{ key: 'goal', answer: 'Grow' }] }),
    L([0], {}), // answers from an older version of the questions are skipped
  ]);
  assert.deepStrictEqual(r.struggles[0], { label: 'Do you plan?', count: 2, pct: 67, answered: 3 });
  assert.strictEqual(r.leadsWantingHelp, 1);
  assert.strictEqual(r.helpRate, 25);
  assert.deepStrictEqual(r.about.goal[0], { label: 'Grow', count: 2, pct: 67 });
});
