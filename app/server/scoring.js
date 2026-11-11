// Turns a scorecard definition + a lead's chosen answers into category
// percentages, an overall score, and a tier label. Runs server-side only,
// so a lead can never tamper with their own score from the browser.
//
// "About you" questions (kind: 'about') never count. Points can be negative
// (a red-flag behaviour costs points), so each question's range runs from its
// lowest to its highest option per category, and a category's percentage is
// how far along that combined range the person landed.

const { isAbout } = require('./questions');

function computeScore(scorecard, answerIndexes) {
  const categories = JSON.parse(scorecard.categories); // [{key,label}]
  const questions = JSON.parse(scorecard.questions);   // [{text, kind?, options:[{label, score:{key:val}}]}]
  const tiers = JSON.parse(scorecard.tiers);            // [{min,label}]

  const totals = {};
  const minTotals = {};
  const maxTotals = {};
  categories.forEach(c => { totals[c.key] = 0; minTotals[c.key] = 0; maxTotals[c.key] = 0; });

  questions.forEach((q, i) => {
    if (isAbout(q) || !Array.isArray(q.options) || !q.options.length) return;
    const chosenOption = Number.isInteger(answerIndexes[i]) ? q.options[answerIndexes[i]] : null;

    categories.forEach(c => {
      const vals = q.options.map(opt => Number((opt.score || {})[c.key] || 0));
      const hi = Math.max(0, ...vals);
      const lo = Math.min(0, ...vals);
      if (hi === 0 && lo === 0) return;
      maxTotals[c.key] += hi;
      minTotals[c.key] += lo;
      if (chosenOption) totals[c.key] += Number((chosenOption.score || {})[c.key] || 0);
    });
  });

  const categoryScores = {};
  categories.forEach(c => {
    const range = maxTotals[c.key] - minTotals[c.key];
    const pct = range > 0 ? ((totals[c.key] - minTotals[c.key]) / range) * 100 : 0;
    categoryScores[c.key] = Math.max(0, Math.min(100, Math.round(pct)));
  });

  const vals = Object.values(categoryScores);
  const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;

  const sortedTiers = [...tiers].sort((a, b) => b.min - a.min);
  const tier = (sortedTiers.find(t => overall >= t.min) || sortedTiers[sortedTiers.length - 1] || { label: 'Result' }).label;

  return { categoryScores, overall, tier };
}

module.exports = { computeScore };
