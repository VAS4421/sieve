// Sieve's template library, shipped in code.
//
// Every template here follows the scorecard method (see
// reports/"Sieve - question engine study"): a desire-led title, 3 categories
// that answer "how would you know they'd got there?", 4 small everyday-
// behaviour questions per category (mostly yes/no, some 1–5 agreement, some
// reverse-scored), and an unscored "about you" step (situation, 90-day goal,
// main obstacle, preferred help, an open note).
//
// routes/templates.js serves these merged with the `templates` DB table: a
// library entry wins over a DB row with the same slug, so the 60 original
// templates are upgraded by a code deploy without anyone editing the
// database, and new ones appear the same way.
//
// Authoring shorthand for a question string:  "<flags>@<text>"  or just "<text>".
//   flags:  s  = 1–5 agreement scale (write the text as an "I…/We…" statement)
//           !  = reverse scored ("yes"/agreeing is the weaker answer)
//           -  = negative points (a red-flag behaviour that costs points)
//           1–5 = points (default 3)
//           h  = add "I'd like help with this" (the last question of every
//                category gets it automatically)
//           n  = never add the help option

const { buildOptions } = require('../questions');
const { SECTOR_ABOUT, DEFAULT_ABOUT, HELP_OPTIONS } = require('./sectors');
const TITLES = require('./titles');

function parseQ(str) {
  const at = str.indexOf('@');
  let flags = '', text = str;
  if (at > -1 && at <= 6 && /^[s!\-1-5hn]*$/.test(str.slice(0, at))) { flags = str.slice(0, at); text = str.slice(at + 1); }
  const pts = (flags.match(/[1-5]/) || ['3'])[0];
  return {
    text: text.trim(),
    format: flags.includes('s') ? 'scale' : 'yesno',
    reverse: flags.includes('!'),
    points: (flags.includes('-') ? -1 : 1) * Number(pts),
    help: flags.includes('h') ? true : flags.includes('n') ? false : null,
  };
}

function aboutQuestions(t) {
  const base = { ...DEFAULT_ABOUT, ...(SECTOR_ABOUT[t.cat] || {}), ...(t.about || {}) };
  const choice = (aboutKey, text, opts) => ({ text, kind: 'about', format: 'choice', aboutKey, options: opts.map(label => ({ label, score: {} })) });
  return [
    choice('situation', base.situationQ, base.situation),
    choice('goal', base.goalQ, base.goal),
    choice('obstacle', base.obstacleQ, base.obstacle),
    choice('help', base.helpQ, base.help || HELP_OPTIONS),
    { text: base.noteQ, kind: 'about', format: 'text', aboutKey: 'note', options: [] },
  ];
}

function build(t, i) {
  const categories = [];
  const questions = [];
  Object.entries(t.c).forEach(([key, [label, qs]]) => {
    categories.push({ key, label });
    qs.forEach((raw, qi) => {
      const p = parseQ(raw);
      const helpOption = p.format === 'yesno' && (p.help === true || (p.help === null && qi === qs.length - 1));
      const q = { text: p.text, kind: 'score', format: p.format, cats: [key], points: p.points, reverse: p.reverse, helpOption, topic: label.toLowerCase() };
      q.options = buildOptions(q);
      questions.push(q);
    });
  });
  // interleave categories so the quiz moves between topics instead of
  // marching through one block at a time
  const byCat = categories.map(c => questions.filter(q => q.cats[0] === c.key));
  const mixed = [];
  for (let r = 0; byCat.some(b => b[r]); r += 1) byCat.forEach(b => { if (b[r]) mixed.push(b[r]); });

  // Title = the customer-facing question (titles.js); intro = the promise line,
  // built from the quiz itself so the numbers and areas are always right.
  const named = TITLES[t.slug];
  const scoredCount = questions.length;
  const labels = categories.map(c => c.label.toLowerCase());
  const areaList = labels.length < 2 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const promise = `Answer ${scoredCount} quick questions to see how you score on ${areaList}, and get your first steps to improve.`;

  const mins = [70, 40, 0];
  const tiers = t.tiers.map(([label, signs], ti) => ({ min: mins[ti] ?? 0, label, signs }));
  return {
    slug: t.slug,
    title: named ? named[1] : t.title,
    titleShape: named ? named[0] : '',
    description: t.desc,
    filterCategory: t.cat,
    coverImage: `/covers/${t.slug}.svg`,
    intro: named ? promise : t.intro,
    categories,
    questions: [...mixed, ...aboutQuestions(t)],
    tiers,
    ctaLabel: t.cta,
    sortOrder: t.sort ?? (1000 + i),
  };
}

const FILES = ['core', 'core2', 'business', 'people', 'money', 'services'];
const RAW = FILES.flatMap(f => require(`./${f}`));

const seen = new Set();
const TEMPLATES = RAW.map((t, i) => {
  if (seen.has(t.slug)) throw new Error(`Duplicate template slug: ${t.slug}`);
  seen.add(t.slug);
  return build(t, i);
});
const BY_SLUG = new Map(TEMPLATES.map(t => [t.slug, t]));

module.exports = { TEMPLATES, BY_SLUG, parseQ, build };
