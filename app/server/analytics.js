// Aggregate answer insight for the owner's report: which everyday habits
// most people don't have yet, what they asked for help with, and what they
// said about themselves. No names or individual answers leave this function.
// Per-question figures only count leads whose answers line up with the
// current questions (an owner may have edited them since).
function buildAnswerInsights(questions, leads) {
  const completed = leads.length;
  // Answer-level insight, still aggregate only (no names): which everyday
  // habits most people don't have yet, what they asked for help with, and
  // what they said about themselves. Only leads whose answers line up with
  // the current questions are counted for the per-question figures.
  const qStats = questions.map(() => ({ answered: 0, weak: 0 }));
  const helpCounts = {};
  const aboutCounts = { situation: {}, goal: {}, obstacle: {}, help: {} };
  let leadsWantingHelp = 0;
  leads.forEach(l => {
    let answers = []; let pz = {};
    try { answers = JSON.parse(l.answers); } catch { answers = []; }
    try { pz = l.personalization ? JSON.parse(l.personalization) : {}; } catch { pz = {}; }
    if (Array.isArray(answers) && answers.length === questions.length) {
      questions.forEach((q, i) => {
        if (q.kind === 'about' || !Array.isArray(q.options) || !Number.isInteger(answers[i])) return;
        const totals = q.options.map(o => Object.values(o.score || {}).reduce((x, y) => x + Number(y || 0), 0));
        const best = Math.max(...totals);
        qStats[i].answered += 1;
        if ((totals[answers[i]] ?? best) < best) qStats[i].weak += 1;
      });
    }
    const hw = Array.isArray(pz.helpWanted) ? pz.helpWanted : [];
    if (hw.length) leadsWantingHelp += 1;
    hw.forEach(h => { helpCounts[h.question] = (helpCounts[h.question] || 0) + 1; });
    (Array.isArray(pz.aboutYou) ? pz.aboutYou : []).forEach(x => {
      if (aboutCounts[x.key]) aboutCounts[x.key][x.answer] = (aboutCounts[x.key][x.answer] || 0) + 1;
    });
  });
  const toItems = (counts, base) => Object.entries(counts)
    .map(([label, count]) => ({ label, count, pct: base ? Math.round((count / base) * 100) : 0 }))
    .sort((x, y) => y.count - x.count).slice(0, 6);
  const struggles = questions
    .map((q, i) => ({ label: q.text, count: qStats[i].weak, pct: qStats[i].answered ? Math.round((qStats[i].weak / qStats[i].answered) * 100) : 0, answered: qStats[i].answered }))
    .filter(x => x.answered >= 1)
    .sort((x, y) => y.pct - x.pct || y.count - x.count).slice(0, 6);
  return {
    struggles,
    helpRate: completed ? Math.round((leadsWantingHelp / completed) * 100) : 0,
    leadsWantingHelp,
    helpTopics: toItems(helpCounts, completed),
    about: Object.fromEntries(Object.entries(aboutCounts).map(([k, v]) => {
      const n = Object.values(v).reduce((x, y) => x + y, 0);
      return [k, toItems(v, n)];
    })),
  };
}

module.exports = { buildAnswerInsights };
