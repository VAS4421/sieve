const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPersonalizedResult, bandFor } = require('../personalize');

function fakeScorecard(overrides = {}) {
  return {
    title: 'The Test Score',
    categories: JSON.stringify([
      { key: 'fit', label: 'Fit' },
      { key: 'timing', label: 'Timing' },
    ]),
    questions: JSON.stringify([
      { text: 'Ready now?', options: [
        { label: 'Yes', score: { fit: 10 } },
        { label: 'No', score: { fit: 0 } },
      ] },
      { text: 'Budget set?', options: [
        { label: 'Yes', score: { timing: 10 } },
        { label: 'No', score: { timing: 0 } },
      ] },
    ]),
    tiers: JSON.stringify([
      { min: 75, label: 'Sales-ready' },
      { min: 0, label: 'Building the basics' },
    ]),
    ...overrides,
  };
}

test('bandFor thresholds', () => {
  assert.equal(bandFor(95), 'exceptional');
  assert.equal(bandFor(90), 'exceptional');
  assert.equal(bandFor(89), 'strong');
  assert.equal(bandFor(75), 'strong');
  assert.equal(bandFor(60), 'solid');
  assert.equal(bandFor(40), 'developing');
  assert.equal(bandFor(20), 'weak');
  assert.equal(bandFor(19), 'struggling');
  assert.equal(bandFor(0), 'struggling');
});

test('uses the greeting name, and falls back gracefully when missing', () => {
  const scorecard = fakeScorecard();
  const withName = buildPersonalizedResult({
    scorecard, lead: { firstName: 'Ada' }, answers: [0, 0],
    categoryScores: { fit: 100, timing: 100 }, overall: 100, tierLabel: 'Sales-ready', leadId: 'lead-1',
  });
  assert.equal(withName.greetingName, 'Ada');

  const withoutName = buildPersonalizedResult({
    scorecard, lead: {}, answers: [0, 0],
    categoryScores: { fit: 100, timing: 100 }, overall: 100, tierLabel: 'Sales-ready', leadId: 'lead-2',
  });
  assert.equal(withoutName.greetingName, 'there');
});

test('every category gets a real, non-empty message when the owner wrote nothing', () => {
  const result = buildPersonalizedResult({
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [1, 1],
    categoryScores: { fit: 10, timing: 90 }, overall: 50, tierLabel: 'Building the basics', leadId: 'lead-3',
  });
  result.categoryNarratives.forEach(c => {
    assert.ok(c.message && c.message.length > 10, `expected a real generated message for ${c.key}`);
  });
});

test('category order stays fixed to the scorecard\'s own declared order, regardless of score', () => {
  const result = buildPersonalizedResult({
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [0, 1],
    categoryScores: { fit: 100, timing: 0 }, overall: 50, tierLabel: 'Building the basics', leadId: 'lead-4',
  });
  // fakeScorecard() declares categories as [fit, timing] — categoryNarratives
  // preserves that fixed order (for a stable donut/legend/tabs UI), it does
  // not resort by score. `ranked` (score order) only decides which category
  // gets the weakest/strongest "role" framing inside its own message.
  assert.equal(result.categoryNarratives[0].key, 'fit');
  assert.equal(result.categoryNarratives[1].key, 'timing');

  const weakest = result.categoryNarratives.find(c => c.key === 'timing'); // score 0
  const strongest = result.categoryNarratives.find(c => c.key === 'fit'); // score 100
  assert.ok(weakest.message.length > 20 && strongest.message.length > 20);
});

test('generated commentary genuinely varies across different respondents with the same score', () => {
  const base = {
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [1, 1],
    categoryScores: { fit: 30, timing: 30 }, overall: 30, tierLabel: 'Building the basics',
  };
  const a = buildPersonalizedResult({ ...base, leadId: 'lead-aaaa' });
  const b = buildPersonalizedResult({ ...base, leadId: 'lead-bbbb' });
  const aBlock = `${a.tierHeadline}|${a.tierMessage}|${a.categoryNarratives.map(c => c.message).join('|')}`;
  const bBlock = `${b.tierHeadline}|${b.tierMessage}|${b.categoryNarratives.map(c => c.message).join('|')}`;
  assert.notEqual(aBlock, bBlock);
});

test('the same lead id always regenerates the exact same result — stable, not random', () => {
  const base = {
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [1, 1],
    categoryScores: { fit: 30, timing: 30 }, overall: 30, tierLabel: 'Building the basics', leadId: 'lead-stable',
  };
  const first = buildPersonalizedResult(base);
  const second = buildPersonalizedResult(base);
  assert.deepEqual(first, second);
});

test('every question gets an insight when the owner wrote nothing for that option', () => {
  const result = buildPersonalizedResult({
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [0, 1],
    categoryScores: { fit: 100, timing: 0 }, overall: 50, tierLabel: 'Building the basics', leadId: 'lead-5',
  });
  assert.equal(result.answerInsights.length, 2);
  assert.equal(result.answerInsights[0].answer, 'Yes');
  assert.equal(result.answerInsights[1].answer, 'No');
  result.answerInsights.forEach(a => assert.ok(a.insight && a.insight.length > 5));
});

test('tier headline and message are generated from the overall score when the owner hasn\'t written one', () => {
  const high = buildPersonalizedResult({
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [0, 0],
    categoryScores: { fit: 100, timing: 100 }, overall: 95, tierLabel: 'Sales-ready', leadId: 'lead-6',
  });
  const low = buildPersonalizedResult({
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [1, 1],
    categoryScores: { fit: 5, timing: 5 }, overall: 5, tierLabel: 'Building the basics', leadId: 'lead-7',
  });
  assert.ok(high.tierHeadline && high.tierHeadline.length > 5);
  assert.ok(low.tierHeadline && low.tierHeadline.length > 5);
  assert.notEqual(high.tierHeadline, low.tierHeadline);
  assert.notEqual(high.tierMessage, low.tierMessage);
});

test('with no recommendation written for this tier, there is no recommendation block', () => {
  const result = buildPersonalizedResult({
    scorecard: fakeScorecard(), lead: { firstName: 'Ada' }, answers: [0, 0],
    categoryScores: { fit: 100, timing: 100 }, overall: 100, tierLabel: 'Sales-ready', leadId: 'lead-8',
  });
  assert.equal(result.recommendation, '');
  assert.equal(result.recommendationUrl, '');
});

// --- Owner overrides — matching ScoreApp's model exactly: every scorecard
// works fully out of the box, but any piece of it can be overridden. ------

test('an owner-written tier headline, message, and recommendation take precedence over the generated version', () => {
  const scorecard = fakeScorecard({
    tiers: JSON.stringify([
      { min: 75, label: 'Sales-ready', headline: 'You are ready to buy', message: 'Great position overall.', recommendation: 'Book a call.', recommendationUrl: 'https://example.com/book' },
      { min: 0, label: 'Building the basics' },
    ]),
  });
  const result = buildPersonalizedResult({
    scorecard, lead: { firstName: 'Ada' }, answers: [0, 0],
    categoryScores: { fit: 100, timing: 100 }, overall: 100, tierLabel: 'Sales-ready', leadId: 'lead-9',
  });
  assert.equal(result.tierHeadline, 'You are ready to buy');
  assert.equal(result.tierMessage, 'Great position overall.');
  assert.equal(result.recommendation, 'Book a call.');
  assert.equal(result.recommendationUrl, 'https://example.com/book');
});

test('a tier with no owner copy still gets a real generated headline and message, with no recommendation block', () => {
  const scorecard = fakeScorecard({
    tiers: JSON.stringify([
      { min: 75, label: 'Sales-ready', headline: 'You are ready to buy', recommendation: 'Book a call.', recommendationUrl: 'https://example.com/book' },
      { min: 0, label: 'Building the basics' }, // no owner copy at all
    ]),
  });
  const result = buildPersonalizedResult({
    scorecard, lead: { firstName: 'Ada' }, answers: [1, 1],
    categoryScores: { fit: 0, timing: 0 }, overall: 0, tierLabel: 'Building the basics', leadId: 'lead-10',
  });
  assert.notEqual(result.tierHeadline, '');
  assert.ok(result.tierHeadline.length > 5);
  assert.equal(result.recommendation, '');
});

test('an owner-written category message overrides the generated one for the matching band only', () => {
  const scorecard = fakeScorecard({
    categories: JSON.stringify([
      { key: 'fit', label: 'Fit', lowMessage: 'Custom low fit message.', highMessage: 'Custom high fit message.' },
      { key: 'timing', label: 'Timing' }, // no owner message — always generated
    ]),
  });
  const weakResult = buildPersonalizedResult({
    scorecard, lead: { firstName: 'Ada' }, answers: [1, 1],
    categoryScores: { fit: 0, timing: 0 }, overall: 0, tierLabel: 'Building the basics', leadId: 'lead-11',
  });
  const fit = weakResult.categoryNarratives.find(c => c.key === 'fit');
  const timing = weakResult.categoryNarratives.find(c => c.key === 'timing');
  assert.equal(fit.message, 'Custom low fit message.');
  assert.notEqual(timing.message, 'Custom low fit message.');
  assert.ok(timing.message.length > 10);

  const strongResult = buildPersonalizedResult({
    scorecard, lead: { firstName: 'Ada' }, answers: [0, 0],
    categoryScores: { fit: 100, timing: 100 }, overall: 100, tierLabel: 'Sales-ready', leadId: 'lead-12',
  });
  const fitHigh = strongResult.categoryNarratives.find(c => c.key === 'fit');
  assert.equal(fitHigh.message, 'Custom high fit message.');
});

test('an owner-written answer insight overrides the generated one for that specific option', () => {
  const scorecard = fakeScorecard({
    questions: JSON.stringify([
      { text: 'Ready now?', options: [
        { label: 'Yes', score: { fit: 10 }, insight: 'Great — that shortens your timeline a lot.' },
        { label: 'No', score: { fit: 0 } },
      ] },
      { text: 'Budget set?', options: [
        { label: 'Yes', score: { timing: 10 } },
        { label: 'No', score: { timing: 0 } },
      ] },
    ]),
  });
  const result = buildPersonalizedResult({
    scorecard, lead: { firstName: 'Ada' }, answers: [0, 1],
    categoryScores: { fit: 100, timing: 0 }, overall: 50, tierLabel: 'Building the basics', leadId: 'lead-13',
  });
  assert.equal(result.answerInsights[0].insight, 'Great — that shortens your timeline a lot.');
  assert.notEqual(result.answerInsights[1].insight, '');
  assert.ok(result.answerInsights[1].insight.length > 5);
});

test('a tier without its own button uses the scorecard-wide next-step button', () => {
  const sc = {
    title: 'T',
    categories: JSON.stringify([{ key: 'a', label: 'Fit' }]),
    questions: JSON.stringify([]),
    tiers: JSON.stringify([{ min: 70, label: 'High', recommendationUrl: 'https://own.example/book', recommendationLabel: 'Own' }, { min: 0, label: 'Low' }]),
    profile_capture: JSON.stringify({ results: { ctaUrl: 'https://wa.me/2348000000000', ctaLabel: 'Chat on WhatsApp' } }),
  };
  const low = buildPersonalizedResult({ scorecard: sc, lead: { firstName: 'Ada' }, answers: [], categoryScores: { a: 20 }, overall: 20, tierLabel: 'Low', leadId: 'x' });
  assert.equal(low.recommendationUrl, 'https://wa.me/2348000000000');
  assert.equal(low.recommendationLabel, 'Chat on WhatsApp');
  assert.ok(low.recommendation.length > 10);
  const high = buildPersonalizedResult({ scorecard: sc, lead: { firstName: 'Ada' }, answers: [], categoryScores: { a: 90 }, overall: 90, tierLabel: 'High', leadId: 'x' });
  assert.equal(high.recommendationUrl, 'https://own.example/book');
  assert.equal(high.recommendationLabel, 'Own');
});
