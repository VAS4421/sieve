// The question engine: the rules every question follows, shared by scoring,
// both submit routes, the template library and the builder's save route.
//
// Two kinds of question:
//   kind 'score' (the default — every question saved before this file existed
//     is one) — an everyday-behaviour check whose chosen option adds points to
//     one or more categories.
//   kind 'about' — an unscored "about you" question (situation, 90-day goal,
//     main obstacle, preferred kind of help, an open note). Never touches the
//     score; it's recorded on the lead and read back on the result page.
//
// Formats (all stored as explicit options, so scoring stays option-based and
// every old scorecard keeps working unchanged):
//   'choice' — any list of options (the original format).
//   'yesno'  — warm labels ("That's me" / "Not yet"), optionally a third
//              "I'd like help with this" option that scores like "no" but
//              flags the topic (option.help = true).
//   'scale'  — a 1–5 agreement scale for an "I…/We…" statement.
//   'text'   — an open box; only allowed on 'about' questions. Answer is a string.
//
// Weighted points: a scored yes/no or scale question carries `points`
// (−5…+5, never 0). `reverse: true` means agreeing/"yes" is the weaker answer.
// Negative points mean "yes" costs points (a red-flag behaviour).

const DEFAULT_YES = "Yes, that's me";
const DEFAULT_NO = 'Not yet';
const DEFAULT_HELP = "I'd like help with this";
const SCALE_LABELS = ['Strongly disagree', 'Disagree', 'Not sure', 'Agree', 'Strongly agree'];
const ABOUT_KEYS = ['situation', 'goal', 'obstacle', 'help', 'note', 'other'];
const MAX_TEXT = 1000;

function isAbout(q) { return q && q.kind === 'about'; }
function isText(q) { return q && q.format === 'text'; }

function clampPoints(p) {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n) || n === 0) return 3;
  return Math.max(-5, Math.min(5, n));
}

// Builds the options for a yes/no or scale question from its settings.
// `cats` is the list of category keys the question feeds.
function buildOptions(q) {
  const cats = Array.isArray(q.cats) && q.cats.length ? q.cats : (q.category ? [q.category] : []);
  const pts = clampPoints(q.points);
  const mag = Math.abs(pts);
  // "good" = the answer that earns the points. A reverse question, or one with
  // negative points, makes "no"/disagree the good answer.
  const goodIsYes = !q.reverse && pts > 0;
  const scoreOf = (fraction) => {
    const s = {};
    cats.forEach(k => { s[k] = Math.round(fraction * mag * 100) / 100; });
    return s;
  };
  if (q.format === 'scale') {
    const labels = Array.isArray(q.scaleLabels) && q.scaleLabels.length === 5 ? q.scaleLabels : SCALE_LABELS;
    return labels.map((label, i) => {
      const agree = i / 4; // 0 … 1
      return { label, score: scoreOf(goodIsYes ? agree : 1 - agree) };
    });
  }
  const yes = (q.labels && q.labels.yes) || DEFAULT_YES;
  const no = (q.labels && q.labels.no) || DEFAULT_NO;
  const out = [
    { label: yes, score: scoreOf(goodIsYes ? 1 : 0) },
    { label: no, score: scoreOf(goodIsYes ? 0 : 1) },
  ];
  if (q.helpOption) out.push({ label: (q.labels && q.labels.help) || DEFAULT_HELP, score: scoreOf(0), help: true });
  return out;
}

// Normalises a question as it comes from the builder or a template: fills in
// kind/format, regenerates options for yesno/scale so their points always
// match their settings, and strips scores from about-you questions.
function normalizeQuestion(raw) {
  const q = { ...raw };
  q.kind = q.kind === 'about' ? 'about' : 'score';
  q.format = ['choice', 'yesno', 'scale', 'text'].includes(q.format) ? q.format : 'choice';
  if (q.kind === 'score' && q.format === 'text') q.format = 'choice';
  if (q.kind === 'score' && (q.format === 'yesno' || q.format === 'scale') && (q.category || (q.cats && q.cats.length))) {
    q.points = clampPoints(q.points);
    q.options = buildOptions(q);
  }
  if (q.kind === 'about') {
    if (!ABOUT_KEYS.includes(q.aboutKey)) q.aboutKey = 'other';
    if (q.format === 'text') q.options = [];
    else q.options = (q.options || []).map(o => ({ label: o.label, ...(o.help ? { help: true } : {}), ...(o.cta ? { cta: o.cta } : {}), score: {} }));
  }
  return q;
}

// Save-time check for the builder (PUT /api/scorecards/:id). Returns an error
// string, or null when every question is valid.
function questionError(q, i) {
  if (!q || !String(q.text || '').trim()) return `Question ${i + 1} needs text.`;
  if (isAbout(q) && isText(q)) return null;
  if (!Array.isArray(q.options) || q.options.length < 2) return `Question ${i + 1} needs at least two answers.`;
  if (q.options.some(o => !String(o.label || '').trim())) return `Every answer on question ${i + 1} needs a label.`;
  return null;
}

// Submit-time check. Choice-style answers are option indexes; open "about you"
// boxes take a string (may be empty — they're optional). Returns
// { error } or { answers } with text trimmed and capped.
function validateAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return { error: 'Answers do not match this scorecard.' };
  }
  const clean = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const a = answers[i];
    if (isAbout(q) && isText(q)) {
      if (a !== null && a !== undefined && typeof a !== 'string') return { error: `Invalid answer for question ${i + 1}.` };
      clean.push(String(a || '').trim().slice(0, MAX_TEXT));
      continue;
    }
    if (!Number.isInteger(a) || a < 0 || a >= (q.options || []).length) {
      return { error: `Invalid answer for question ${i + 1}.` };
    }
    clean.push(a);
  }
  return { answers: clean };
}

// What the person told us outside the score: their about-you answers, and
// every scored question where they chose "I'd like help with this".
function readAbout(questions, answers) {
  const about = [];
  const helpWanted = [];
  questions.forEach((q, i) => {
    const a = answers[i];
    if (isAbout(q)) {
      const answer = isText(q) ? String(a || '').trim() : (q.options[a] && q.options[a].label) || '';
      if (!answer) return;
      const opt = isText(q) ? null : q.options[a];
      about.push({ key: q.aboutKey || 'other', question: q.text, answer, ...(opt && opt.cta ? { cta: opt.cta } : {}) });
      return;
    }
    const opt = q.options && q.options[a];
    if (opt && opt.help) helpWanted.push({ question: q.text, topic: q.topic || q.text });
  });
  return { about, helpWanted };
}

// What the quiz page is allowed to see: never the scores, so nobody can read
// the "right" answer out of the page source.
function publicQuestion(q) {
  const kind = q.kind === 'about' ? 'about' : 'score';
  const format = q.format || 'choice';
  return {
    text: q.text,
    kind,
    format,
    ...(q.hint ? { hint: q.hint } : {}),
    options: (q.options || []).map(o => ({ label: o.label, ...(o.help ? { help: true } : {}) })),
  };
}

module.exports = {
  publicQuestion,
  DEFAULT_YES, DEFAULT_NO, DEFAULT_HELP, SCALE_LABELS, ABOUT_KEYS,
  isAbout, isText, buildOptions, normalizeQuestion, questionError, validateAnswers, readAbout, clampPoints,
};
