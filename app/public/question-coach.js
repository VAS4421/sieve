// Question engine helpers for the builder (mirrors app/server/questions.js —
// the server re-runs the same rules on save, so this is only for the live UI),
// plus the Question coach: plain-English notes on how a question reads to the
// person answering it, based on the scorecard method (small, concrete,
// everyday-behaviour questions; never salesy, leading, jargon-heavy or
// "go and check").
(function () {
  const DEFAULT_YES = "Yes, that's me";
  const DEFAULT_NO = 'Not yet';
  const DEFAULT_HELP = "I'd like help with this";
  const SCALE_LABELS = ['Strongly disagree', 'Disagree', 'Not sure', 'Agree', 'Strongly agree'];

  function clampPoints(p) {
    const n = Math.round(Number(p));
    if (!Number.isFinite(n) || n === 0) return 3;
    return Math.max(-5, Math.min(5, n));
  }

  function buildOptions(q) {
    const cats = Array.isArray(q.cats) ? q.cats : [];
    const pts = clampPoints(q.points), mag = Math.abs(pts);
    const goodIsYes = !q.reverse && pts > 0;
    const scoreOf = (f) => { const s = {}; cats.forEach(k => { s[k] = Math.round(f * mag * 100) / 100; }); return s; };
    const keepInsight = (i) => (q.options && q.options[i] && q.options[i].insight ? { insight: q.options[i].insight } : {});
    if (q.format === 'scale') {
      const labels = Array.isArray(q.scaleLabels) && q.scaleLabels.length === 5 ? q.scaleLabels : SCALE_LABELS;
      return labels.map((label, i) => ({ label, score: scoreOf(goodIsYes ? i / 4 : 1 - i / 4), ...keepInsight(i) }));
    }
    const L = q.labels || {};
    const out = [
      { label: L.yes || DEFAULT_YES, score: scoreOf(goodIsYes ? 1 : 0), ...keepInsight(0) },
      { label: L.no || DEFAULT_NO, score: scoreOf(goodIsYes ? 0 : 1), ...keepInsight(1) },
    ];
    if (q.helpOption) out.push({ label: L.help || DEFAULT_HELP, score: scoreOf(0), help: true, ...keepInsight(2) });
    return out;
  }

  // ---- the coach -------------------------------------------------------
  const RULES = [
    { id: 'sales', scoredOnly: true, re: /\b(buy|purchase|sign up|subscribe|ready to (buy|start|invest|pay|commit)|budget|afford|pay for|price|pricing|cost|package|our (service|product|team|company)|hire us|work with us|book (a|an|us))\b/i,
      tip: 'Sounds like a sales question. Move it to "About you" (unscored), or ask about something they do day to day.' },
    { id: 'leading', re: /\b(frustrat\w*|struggl\w*|tired of|sick of|worried|worry|fear\w*|afraid|scared|keeping you up|losing sleep|if you'?re honest|honestly|don'?t you|wouldn'?t you|isn'?t it|surely|admit)\b/i,
      tip: 'Leading or loaded. People recoil from big feelings asked head-on. Ask what they do, and let the answers add up.' },
    { id: 'confront', re: /\b(are you (happy|satisfied|good|confident|pleased) with|how (good|bad|well) (is|are|do)|rate your(self)?|how would you rate)\b/i,
      tip: 'A big, direct question makes people guess. Swap it for a small habit, e.g. "Do you review your numbers every week?"' },
    { id: 'check', re: /\b(exact(ly)?|precise(ly)?|what percent(age)?|how many .{0,30}(last|past|per) (year|month|quarter)|look (it )?up|check your|to the nearest)\b/i,
      tip: 'They would need to go and check. Ask something they can answer from memory in a second.' },
    { id: 'jargon', re: /\b(ROI|KPIs?|CAC|LTV|EBITDA|synerg\w*|leverag\w*|optimi[sz]\w*|scalab\w*|bandwidth|stakeholders?|omni-?channel|funnel|churn|SOPs?|deliverables|paradigm|holistic|best practices?)\b/,
      tip: 'Jargon. Use words someone at a bus stop would understand.' },
  ];

  function coach(q, ctx) {
    const notes = [];
    const text = String(q.text || '').trim();
    if (!text) return notes;
    const scored = q.kind !== 'about';
    RULES.forEach(r => { if ((!r.scoredOnly || scored) && r.re.test(text)) notes.push({ level: 'warn', text: r.tip }); });
    if (text.length > 120) notes.push({ level: 'warn', text: 'Long. Aim for one short line people can read at a glance.' });
    if (/\?.*\?/.test(text) || (/\b(and|or)\b/i.test(text) && text.length > 70)) notes.push({ level: 'info', text: 'Might be asking two things at once. Split it if a person could answer "yes" to one half and "no" to the other.' });
    if (scored && q.format === 'choice' && Array.isArray(q.options) && q.options.length > 2 && ctx && ctx.cats && ctx.cats.length) {
      const tot = q.options.map(o => ctx.cats.reduce((a, c) => a + Number((o.score || {})[c] || 0), 0));
      const desc = tot.every((v, i) => i === 0 || v <= tot[i - 1]);
      if (desc && tot[0] > tot[tot.length - 1]) notes.push({ level: 'info', text: 'The best answer is always first. Mix the order, or switch to Yes/No, so the "right" answer isn\'t obvious.' });
    }
    if (scored && q.format === 'yesno' && !q.helpOption) notes.push({ level: 'info', text: 'Consider adding "I\'d like help with this". It lets people put their hand up, and you see it on the lead.' });
    if (scored && /^(do|does|did|have|has|is there|are there|can|i |we |my |our )/i.test(text) && !notes.some(n => n.level === 'warn')) {
      notes.push({ level: 'good', text: 'Good: a concrete, everyday question people can answer from memory.' });
    }
    return notes;
  }

  window.SieveQ = { DEFAULT_YES, DEFAULT_NO, DEFAULT_HELP, SCALE_LABELS, clampPoints, buildOptions, coach };
})();
