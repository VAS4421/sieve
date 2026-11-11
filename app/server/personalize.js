// Turns a raw score into a result that speaks to the specific person who
// answered — matching ScoreApp's own model: every scorecard comes complete
// with real, working copy the moment it's created, and every piece of that
// copy stays fully owner-editable afterward. A scorecard owner never has to
// write a word to get a working result page — but if they want to override
// the tier headline, a category's message, an answer's insight, or the
// outcome recommendation, whatever they write takes precedence. Nothing an
// owner leaves blank ever shows up blank on a respondent's result — this
// file writes it instead.
//
// Variety in the generated fallback comes from a deterministic hash of the
// lead's own id mixed with a field-specific salt, so two different leads —
// even ones who land on the exact same score — very rarely read the same
// generated sentence, while the same lead's own snapshot stays stable if
// it's ever re-read (e.g. regenerating their PDF from the stored
// personalization record). None of that applies to owner-written text, of
// course — that's exactly what the owner typed, verbatim, every time.

const { isAbout, readAbout } = require('./questions');

function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function pick(seed, arr) {
  return arr[hashSeed(seed) % arr.length];
}

const BANDS = [
  { key: 'exceptional', min: 90 },
  { key: 'strong', min: 75 },
  { key: 'solid', min: 60 },
  { key: 'developing', min: 40 },
  { key: 'weak', min: 20 },
  { key: 'struggling', min: 0 },
];

function bandFor(score) {
  return (BANDS.find(b => score >= b.min) || BANDS[BANDS.length - 1]).key;
}

// --- Category commentary -----------------------------------------------

// Full, coaching-style paragraphs rather than one-liners — the point is that a
// respondent reads this and feels like a real person looked at their answers,
// not that a form ran a formula on them. Each still ends on a forward-looking
// note (what this means, or what to do about it), matching what makes a
// result feel like genuine help rather than a verdict.
const CATEGORY_BASE = {
  exceptional: [
    l => `You have ${l.toLowerCase()} fully in place. It is done the same way every time, so it holds up on busy weeks as well as quiet ones.`,
    l => `${l} is a settled strength for you. The habits are clear, they are repeated, and they no longer depend on someone remembering.`,
    l => `You have this area working consistently. What happens here is planned, done and checked, and it supports everything else in your result.`,
  ],
  strong: [
    l => `You have most of what ${l.toLowerCase()} needs, but a few habits still depend on effort rather than routine. It works well most of the time, and the gap now is consistency, not know-how.`,
    l => `${l} is in good shape, but not yet automatic. The basics are there; one or two things still slip when you get busy.`,
    l => `You have a strong base in ${l.toLowerCase()}, with a little room left. A small, steady push would make it something you rarely have to think about.`,
  ],
  solid: [
    l => `You have some of the right habits in ${l.toLowerCase()}, but they are not used every time. Parts of it run well; others still rely on memory and who happens to be involved.`,
    l => `${l} works, but it is uneven. Good weeks look very different from busy ones, so results rise and fall.`,
    l => `You have the foundations for ${l.toLowerCase()}, but not yet the routine. The intention is clear; it just is not repeated often enough to rely on.`,
  ],
  developing: [
    l => `You have a few good habits in ${l.toLowerCase()}, but most things here happen when there is time, not by design. It works when you give it attention and slips when other things take over.`,
    l => `${l} is partly in place. You know what good looks like, but the day-to-day habits that would make it happen are not set yet.`,
    l => `You have made a start on ${l.toLowerCase()}, but it is inconsistent. Some things get done well, others get improvised on the day.`,
  ],
  weak: [
    l => `You have very little of ${l.toLowerCase()} in place yet. Things here tend to be handled as problems come up, rather than planned for.`,
    l => `${l} is at an early stage for you. Few of the supporting habits are there, so results depend on effort and a bit of luck.`,
    l => `You have not built ${l.toLowerCase()} up yet, and it is likely affecting other parts of your result more than it seems.`,
  ],
  struggling: [
    l => `You do not have ${l.toLowerCase()} in place yet. It is the area with the most room to improve, and the one where small changes will show first.`,
    l => `${l} is the clearest gap in your result. Most of the habits that support it have not started yet.`,
    l => `You are at the starting line with ${l.toLowerCase()}. That makes it the simplest place to begin: one steady habit here will move your score.`,
  ],
};

// --- Category headline — a bold, evergreen thesis statement shown above the
// score-driven paragraph, matching the reference's per-category deep-dive
// (e.g. "Lead by empowering others; true success comes when everyone thrives
// in their unique roles."). The reference can write these because its
// categories are fixed and known in advance; Sieve's are whatever a business
// types into the builder, so there's no way to hand-write a bespoke thesis
// for an arbitrary label the way a human editor would. The owner can still
// write their own per category (`c.headline` — evergreen, shown regardless of
// score, exactly like the reference); short of that, this generates one that
// at least reflects the category's current band, referencing the label. -----

const CATEGORY_HEADLINE_BASE = {
  strong: [
    l => `Consistent and dependable.`,
    l => `In place and working.`,
    l => `A strength to protect.`,
  ],
  developing: [
    l => `Present, but uneven.`,
    l => `Good intentions, not yet a habit.`,
    l => `Working in parts.`,
  ],
  weak: [
    l => `Not yet in place.`,
    l => `The clearest gap.`,
    l => `The place to start.`,
  ],
};

// What is typical at each stage, shown under each area as "What we usually see".
const CATEGORY_SEEN = {
  strong: [
    () => 'At this level, the risk is drift: what works today gets taken for granted, then slips quietly when things get busy or people change.',
    () => 'People who score well here usually have one or two simple routines they never skip. Protecting those routines is what keeps the score high.',
  ],
  developing: [
    () => 'At this stage, the right ideas usually exist but are not written down or repeated. Results depend on who is involved and how busy the week is.',
    () => 'This is the most common place to be. Good things happen, but not by design, so it takes more effort than it should.',
  ],
  weak: [
    () => 'At this stage, most of the work here is done in a rush or when something goes wrong. It is rarely planned, so the same problems tend to come back.',
    () => 'When an area scores this low, it is usually because nobody owns it yet. One clear owner and one simple routine change things quickly.',
  ],
};

function categorySeen(label, band3, seed) {
  return pick(`${seed}:seen`, CATEGORY_SEEN[band3])(label);
}

// Typical signs when the owner has not written any for this tier.
function generatedSigns(overall, strongest, weakest) {
  const b = bandFor(overall);
  if (b === 'exceptional' || b === 'strong') return [`${strongest} runs without much chasing`, 'Most weeks go to plan', `${weakest} is good, but less consistent than the rest`];
  if (b === 'solid') return ['Good work is happening, but it depends on the week', `${strongest} is a clear strength`, `${weakest} rises and falls`, 'More effort goes in than should be needed'];
  if (b === 'developing') return ['Things go well when there is time, and slip when there is not', `${weakest} is mostly improvised`, 'Some habits exist, but they are not written down'];
  return ['Most things are handled as they come up', `${weakest} gets little planned attention`, 'Progress depends on effort more than routine'];
}

const band3For = (score) => {
  const b = bandFor(score);
  return b === 'exceptional' || b === 'strong' ? 'strong' : b === 'weak' || b === 'struggling' ? 'weak' : 'developing';
};

function categoryHeadline(label, band3, seed) {
  return pick(`${seed}:headline`, CATEGORY_HEADLINE_BASE[band3])(label);
}

// --- Category action checklist — generic, band-driven improvement steps
// shown as a short checklist under each category's paragraph (matching the
// reference's "Delegation / Performance Feedback / Time Management" format).
// These are deliberately about *how to improve at anything* (goal clarity,
// feedback loops, focused practice) rather than domain-specific advice, since
// Sieve can't know what an arbitrary category like "Fit" or "Investor
// Readiness" actually means the way a fixed, known category can. Two
// alternate full sets per band (picked as a whole, not mixed item-by-item) so
// the trio always reads as one coherent piece of advice. --------------------

const CATEGORY_CHECKLIST_BASE = {
  strong: [
    [
      { label: 'Write down what works', text: 'so it survives busy weeks and new staff' },
      { label: 'Raise the bar slightly', text: 'a small new target, not just maintenance' },
      { label: 'Use it as the model', text: 'apply the same routine to weaker areas' },
    ],
    [
      { label: 'Keep a simple check-in', text: 'monthly, five minutes, same questions' },
      { label: 'Test it under pressure', text: 'does it still hold on your busiest days?' },
      { label: 'Share the routine', text: 'so it does not depend on one person' },
    ],
  ],
  developing: [
    [
      { label: 'Define what good looks like', text: 'one sentence, written down' },
      { label: 'Pick one habit to fix first', text: 'not everything at once' },
      { label: 'Set a review date', text: 'four weeks from today' },
    ],
    [
      { label: 'Find the pattern', text: 'when does this work, and when does it slip?' },
      { label: 'Borrow from your strongest area', text: 'the same routine often transfers' },
      { label: 'Track it weekly', text: 'a simple tick list is enough' },
    ],
  ],
  weak: [
    [
      { label: 'Name the real cause', text: 'time, money, knowledge or habit' },
      { label: 'Start smaller than feels necessary', text: 'one action you can repeat every week' },
      { label: 'Get an outside view', text: 'this is where support pays off fastest' },
    ],
    [
      { label: 'Make this the priority', text: 'ahead of lower-stakes work' },
      { label: 'Set one action for this week', text: 'specific, small and dated' },
      { label: 'Check progress often', text: 'gaps close faster when they are watched' },
    ],
  ],
};

function categoryChecklist(band3, seed) {
  return pick(`${seed}:checklist`, CATEGORY_CHECKLIST_BASE[band3]);
}

// Every prefix ends as a connector (a colon or a dash) rather than a full
// stop, so joining it with a lowercased continuation always reads as one
// grammatical sentence, never "...it's this. conversion is...".
const WEAKEST_PREFIX = [
  'Start here. ',
  'Your priority area. ',
  'The biggest opportunity. ',
];

const STRONGEST_PREFIX = [
  'Your strongest area. ',
  'What is working best. ',
  'A clear strength. ',
];

function categoryMessage(label, score, role, seed) {
  const band = bandFor(score);
  const base = pick(`${seed}:base`, CATEGORY_BASE[band])(label);
  if (role === 'weakest') return pick(`${seed}:prefix`, WEAKEST_PREFIX) + base; // prefixes are full sentences now
  if (role === 'strongest') return pick(`${seed}:prefix`, STRONGEST_PREFIX) + base;
  return base;
}

// --- Tier headline & message, driven by the overall score --------------

const TIER_HEADLINE = {
  exceptional: ['You have built something strong, and it runs consistently.', 'You are well set up across the board.', 'Your foundations are strong and well established.'],
  strong: ['You are in a strong position, but one area still holds you back.', 'You have built a strong base, with a little left to tighten.', 'Most things are working well, but not quite everywhere.'],
  solid: ['You have built something solid, but it is not yet consistent.', 'You have good foundations, but they are not yet habits.', 'Things are working, but they take more effort than they should.'],
  developing: ['You have made a real start, but much still depends on effort.', 'The intention is there, but the habits are not yet in place.', 'You are gaining ground, but progress is uneven.'],
  weak: ['You have some pieces in place, but most of the foundations are still missing.', 'Right now you are reacting more than planning.', 'You are at an early stage, with clear room to grow.'],
  struggling: ['You are at the starting point, and that is a clear place to begin.', 'Most of the foundations are not in place yet.', 'This is day one, with plenty of room to improve.'],
};

const TIER_MESSAGE = {
  exceptional: [
    (s, w) => `The right habits are in place and they are repeated. ${s} leads the way, and even ${w.toLowerCase()} is in good shape.`,
    (s, w) => `Your answers point the same way: things are planned, done and checked. ${s} is the strongest part, and ${w.toLowerCase()} is close behind.`,
  ],
  strong: [
    (s, w) => `Most of the right habits are already in place, led by ${s.toLowerCase()}. ${w} is the one area that still varies.`,
    (s, w) => `You are ahead in most areas, especially ${s.toLowerCase()}. The remaining gap sits mainly in ${w.toLowerCase()}.`,
  ],
  solid: [
    (s, w) => `There are good habits and real strengths, especially in ${s.toLowerCase()}. But they are not yet consistent, and ${w.toLowerCase()} is where that shows most.`,
    (s, w) => `Things work, but not every week and not in every area. ${s} is steady; ${w.toLowerCase()} is where results rise and fall.`,
  ],
  developing: [
    (s, w) => `Some good habits exist, mostly in ${s.toLowerCase()}, but much still depends on time and effort. ${w} is where the gap is widest.`,
    (s, w) => `The intention is clear, but it has not yet become routine. ${s} is furthest along; ${w.toLowerCase()} needs the most attention.`,
  ],
  weak: [
    (s, w) => `At the moment, most things are handled as they come up rather than planned for. ${w} is the clearest gap; ${s.toLowerCase()} is the best place to build from.`,
    (s, w) => `A few pieces are in place, mainly in ${s.toLowerCase()}. Most of the supporting habits, especially in ${w.toLowerCase()}, have not started yet.`,
  ],
  struggling: [
    (s, w) => `Most of the habits measured here are not yet in place. That is common at this stage, and it means the first changes will show quickly, starting with ${w.toLowerCase()}.`,
    (s, w) => `This is an early-stage result. ${w} is the clearest gap, and ${s.toLowerCase()} is the one area already pointing the right way.`,
  ],
};

function tierHeadline(overall, seed) {
  const band = bandFor(overall);
  return pick(`${seed}:headline`, TIER_HEADLINE[band]);
}

const TIER_MESSAGE_SINGLE = {
  exceptional: [l => `${l} is fully in place and consistent.`, l => `The habits behind ${l.toLowerCase()} are set and repeated.`],
  strong: [l => `${l} is in good shape, with a little room left.`, l => `Most of what supports ${l.toLowerCase()} is already in place.`],
  solid: [l => `${l} works, but not yet consistently.`, l => `${l} is functional, but uneven from week to week.`],
  developing: [l => `${l} is partly in place, and still depends on effort.`, l => `The intention behind ${l.toLowerCase()} is clear, but the habits are not yet set.`],
  weak: [l => `${l} is at an early stage.`, l => `Few of the habits behind ${l.toLowerCase()} are in place yet.`],
  struggling: [l => `${l} is not yet in place.`, l => `${l} is at the starting line.`],
};

// A short, concrete suggestion sentence appended to every tier message —
// always naming the category worth focusing on next — so the summary under
// the donut always reads as "here's what's going on AND here's what to do
// about it," on every result, not just the ones with a glaring weak point.
// Keyed by the same overall band as TIER_MESSAGE/TIER_MESSAGE_SINGLE above,
// so the tone always matches — "protect this" for an already-strong band,
// "here's the fix" for a weak one — rather than one generic phrasing forced
// onto every score range.
// Deliberately worded to avoid echoing TIER_MESSAGE/TIER_MESSAGE_SINGLE's own
// phrasing for the same band (e.g. never re-using "sharpen", "next real gain
// sits", "clearest next move") — the two are always shown back to back in
// the same paragraph, so any shared phrase reads as an awkward, literal
// repetition rather than two distinct sentences.
const TIER_SUGGESTION = {
  exceptional: [w => `The goal here: keep it consistent, including ${w.toLowerCase()}.`, w => `The goal here: protect what works as things grow.`],
  strong: [w => `The goal here: bring ${w.toLowerCase()} up to the level of everything else.`, w => `The goal here: turn ${w.toLowerCase()} from effort into routine.`],
  solid: [w => `The goal here: move from good intentions to steady habits, starting with ${w.toLowerCase()}.`, w => `The goal here: make ${w.toLowerCase()} as reliable as your best area.`],
  developing: [w => `The goal here: turn a few good habits into a routine, starting with ${w.toLowerCase()}.`, w => `The goal here: put ${w.toLowerCase()} on a simple weekly rhythm.`],
  weak: [w => `The goal here: put the basics in place, one area at a time, starting with ${w.toLowerCase()}.`, w => `The goal here: move from reacting to planning, beginning with ${w.toLowerCase()}.`],
  struggling: [w => `The goal here: start small, with one habit in ${w.toLowerCase()} that sticks.`, w => `The goal here: build the first foundation in ${w.toLowerCase()}, then the next.`],
};

function tierSuggestion(label, band, seed) {
  return pick(`${seed}:suggestion`, TIER_SUGGESTION[band])(label);
}

function tierMessage(overall, strongestLabel, weakestLabel, seed) {
  const band = bandFor(overall);
  if (strongestLabel === weakestLabel) {
    const fn = pick(`${seed}:message`, TIER_MESSAGE_SINGLE[band]);
    const base = fn(strongestLabel);
    return base;
  }
  const fn = pick(`${seed}:message`, TIER_MESSAGE[band]);
  const base = fn(strongestLabel, weakestLabel);
  return base;
}

// --- Per-answer insight, driven by how the chosen option ranks among the
// question's own options (not owner-written commentary) -----------------

// The result page already quotes the respondent's own answer right above
// this line, so these never repeat it back. Instead each one says what the
// answer means for the area it's scored in (`area`, e.g. "your urgency"),
// and — whenever there was a stronger position — names it (`best`), so the
// respondent sees exactly what "better" looks like for them. Framed as
// opportunity, never as a failing grade, and no invented statistics.
const ANSWER_INSIGHT = {
  best: [
    (area) => `A strength. This supports ${area}; keep doing it.`,
    (area) => `In place. This is the strongest answer here, and it supports ${area}.`,
    (area) => `Nothing to change. This habit is part of what holds ${area} up.`,
  ],
  strong: [
    (area, best) => `Close. One step towards "${best}" would round out ${area}.`,
    (area, best) => `Nearly there. Moving to "${best}" is a quick win for ${area}.`,
  ],
  mid: [
    (area, best) => `Partly in place. The strongest answer is "${best}"; closing that gap lifts ${area}.`,
    (area, best) => `Uneven. "${best}" is the target, and the gap here is where ${area} can improve.`,
  ],
  weak: [
    (area, best) => `Not yet in place. The strongest answer is "${best}", which makes this worth a closer look for ${area}.`,
    (area, best) => `A gap. This is holding ${area} back; "${best}" is what good looks like.`,
  ],
  worst: [
    (area, best) => `The biggest gap on this question. "${best}" is the target, and change here shows in ${area} quickly.`,
    (area, best) => `A priority. Moving towards "${best}" would make the biggest difference to ${area}.`,
  ],
};

// --- The recommendation block's own headline — addressed to the respondent
// by name, matching the reference behaviour: a plain "Recommended next step"
// label reads like a form footer, a question with their own name in it reads
// like an invitation. Still only ever shown once the owner has engaged with
// this feature at all — written their own text, given it a link, or both
// (see buildPersonalizedResult) — nothing here invents a CTA out of thin air
// for a tier the owner never touched. -----------------------------------

// The recommendation paragraph itself, generated only as a fallback for a
// tier where the owner gave a destination link but left the invitation text
// blank — matching every other field in this file ("owner text always
// wins," generated otherwise), rather than the one place that used to
// require the owner to write something before a CTA could show at all.
// Distinct phrasing from TIER_SUGGESTION on purpose — the tier summary
// above already names the weakest category once; this shouldn't just
// repeat that sentence inside the CTA card underneath it.
const TIER_RECOMMENDATION = {
  exceptional: [
    w => `If you want a second opinion on keeping this level, ${w.toLowerCase()} included, this is the next step.`,
    w => `To keep it consistent as you grow, including ${w.toLowerCase()}, here is where to start.`,
  ],
  strong: [
    w => `To close the remaining gap in ${w.toLowerCase()}, this is the next step.`,
    w => `A short session on ${w.toLowerCase()} would move this from strong to consistent.`,
  ],
  solid: [
    w => `To turn ${w.toLowerCase()} into a steady habit, this is the next step.`,
    w => `Get a clear plan for ${w.toLowerCase()} and move from functional to strong.`,
  ],
  developing: [
    w => `To build a simple routine for ${w.toLowerCase()}, this is the next step.`,
    w => `Get help setting up ${w.toLowerCase()}, so it no longer depends on effort.`,
  ],
  weak: [
    w => `To put the basics of ${w.toLowerCase()} in place, this is the next step.`,
    w => `Get a step-by-step plan for ${w.toLowerCase()}, starting this week.`,
  ],
  struggling: [
    w => `To start with ${w.toLowerCase()} and build from there, this is the next step.`,
    w => `Talk it through with someone who has helped others start from here.`,
  ],
};

function tierRecommendation(overall, weakestLabel, seed) {
  const band = bandFor(overall);
  return pick(`${seed}:recommendation`, TIER_RECOMMENDATION[band])(weakestLabel);
}

// Always ties the "Book Now" invitation to the weakest category by name, so
// the recommendation paragraph and the CTA button beneath it read as one
// connected thought on every scorecard (e.g. weakest category "Design" ->
// "Want to talk to a design expert?") rather than two unrelated blocks.
const CTA_HEADLINE_CATEGORY = [
  (n, w) => `${n}, do you want to talk through your results?`,
  (n, w) => `Want help with ${w.toLowerCase()}, ${n}?`,
  (n, w) => `${n}, shall we start with ${w.toLowerCase()}?`,
];

function ctaHeadline(firstName, weakestLabel, seed) {
  const fn = pick(`${seed}:ctaHeadline`, CTA_HEADLINE_CATEGORY);
  return fn(firstName, weakestLabel);
}

// Shown when someone chose "I'd like help with this" — they raised their
// hand, so this reads as an acknowledgement, never a grade.
const HELP_INSIGHT = [
  'You asked for help here. Noted, and it is a sensible place to start.',
  'Flagged for help. This is usually where the quickest progress comes from.',
  'You raised your hand on this one. We will start the conversation here.',
];

const CTA_HEADLINE_HELP = [
  (n, t) => `${n}, you asked for help with ${t}. Start there.`,
  (n, t) => `You flagged ${t}, ${n}. Here is the next step.`,
  (n, t) => `${n}, let's begin with ${t}.`,
];

// Turns "Do you track every sale in one place?" into a short topic phrase for
// a headline when the question has no owner-written `topic`.
function shortTopic(t) {
  const s = String(t || '').trim().replace(/[?.!]+$/, '');
  if (s.length <= 60 && !/^(do|does|did|have|has|is|are|can|will|would|i|we)/i.test(s)) return s.charAt(0).toLowerCase() + s.slice(1);
  return 'this';
}

// `areaLabels` are the categories this question is scored in; `bestLabel` is
// the strongest option's text. Both come from the scorecard itself.
function answerInsight(questionText, chosenLabel, rankFraction, seed, areaLabels = [], bestLabel = '') {
  let position;
  if (rankFraction <= 0.15) position = 'best';
  else if (rankFraction <= 0.4) position = 'strong';
  else if (rankFraction <= 0.6) position = 'mid';
  else if (rankFraction <= 0.85) position = 'weak';
  else position = 'worst';
  // with no stronger option to point at, fall back to the strength framing rather than an empty quote
  if (position !== 'best' && (!bestLabel || bestLabel === chosenLabel)) position = 'best';
  const names = areaLabels.filter(Boolean).map(l => l.toLowerCase());
  const area = names.length === 0 ? 'your result'
    : names.length === 1 ? `your ${names[0]} score`
    : `your ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} scores`;
  const fn = pick(`${seed}:insight`, ANSWER_INSIGHT[position]);
  return fn(area, bestLabel);
}

function buildPersonalizedResult({ scorecard, lead, answers, categoryScores, overall, tierLabel, leadId }) {
  const categories = JSON.parse(scorecard.categories);
  const questions = JSON.parse(scorecard.questions);
  const tiers = JSON.parse(scorecard.tiers);
  const tierConfig = tiers.find(t => t.label === tierLabel) || {};

  const firstName = (lead.firstName || '').trim() || 'there';
  const seedBase = leadId || `${firstName}:${overall}:${tierLabel}`;

  const ranked = categories
    .map(c => ({ key: c.key, label: c.label, score: categoryScores[c.key] || 0, lowMessage: c.lowMessage, highMessage: c.highMessage }))
    .sort((a, b) => a.score - b.score);
  const weakest = ranked[0];
  const strongest = ranked[ranked.length - 1];
  // The "biggest opportunity" / "standout" framing only makes sense when the
  // extreme is actually notable in absolute terms — being merely the best of
  // a uniformly weak set isn't a standout, and being merely the worst of a
  // uniformly strong set isn't an urgent problem. Only applies to the
  // *generated* fallback — an owner's own message always wins regardless.
  const weakestIsNotable = ['developing', 'weak', 'struggling'].includes(bandFor(weakest.score));
  const strongestIsNotable = ['exceptional', 'strong', 'solid'].includes(bandFor(strongest.score));

  // Built from `categories` (the scorecard's own defined order), not `ranked`
  // (sorted by score) — the donut/legend/tabs on the result page need a fixed
  // order that stays the same for every lead, the way the ScoreApp reference
  // does. `ranked` is still used to decide which category gets the
  // weakest/strongest "role" framing.
  const categoryNarratives = categories.map(cat => {
    const c = ranked.find(r => r.key === cat.key);
    const role = ranked.length > 1 && c.key === weakest.key && weakestIsNotable ? 'weakest'
      : ranked.length > 1 && c.key === strongest.key && strongestIsNotable ? 'strongest'
      : 'middle';
    const band3 = bandFor(c.score) === 'exceptional' || bandFor(c.score) === 'strong' ? 'strong'
      : bandFor(c.score) === 'weak' || bandFor(c.score) === 'struggling' ? 'weak'
      : 'developing'; // collapsed to the three bands the UI already colours (green/orange/red)
    // The owner can write a low-score message and a high-score message per
    // category (matching ScoreApp's model exactly) — used when it applies,
    // otherwise this category's commentary is generated.
    const ownerMessage = band3 === 'weak' ? c.lowMessage : band3 === 'strong' ? c.highMessage : null;
    const message = (ownerMessage && ownerMessage.trim()) || categoryMessage(c.label, c.score, role, `${seedBase}:${c.key}`);
    const ownerHeadline = c.headline && c.headline.trim();
    const headline = ownerHeadline || categoryHeadline(c.label, band3, `${seedBase}:${c.key}`);
    const checklist = categoryChecklist(band3, `${seedBase}:${c.key}`);
    const seen = categorySeen(c.label, band3, `${seedBase}:${c.key}`);
    return { key: c.key, label: c.label, score: c.score, band: band3, headline, message, seen, checklist };
  });

  const answerInsights = questions.map((q, i) => {
    if (isAbout(q)) return null; // "about you" answers are read back in their own block, never graded
    const chosenIdx = answers[i];
    const chosen = (q.options || [])[chosenIdx];
    if (!chosen) return null;
    if (chosen.help) {
      return {
        question: q.text,
        answer: chosen.label,
        help: true,
        insight: chosen.insight && chosen.insight.trim()
          ? chosen.insight.trim()
          : pick(`${seedBase}:q${i}:help`, HELP_INSIGHT),
      };
    }
    const totals = q.options.map(o => Object.values(o.score || {}).reduce((a, b) => a + b, 0));
    const chosenTotal = totals[chosenIdx];
    const sorted = [...totals].sort((a, b) => b - a); // highest first
    const rank = sorted.indexOf(chosenTotal);
    const rankFraction = q.options.length > 1 ? rank / (q.options.length - 1) : 0;
    const ownerInsight = chosen.insight && chosen.insight.trim();
    // the areas this question actually feeds, and what its strongest answer looks like
    const areaLabels = categories.filter(c => q.options.some(o => Number((o.score || {})[c.key] || 0) > 0)).map(c => c.label).slice(0, 3);
    const bestLabel = q.options[totals.indexOf(Math.max(...totals))]?.label || '';
    return {
      question: q.text,
      answer: chosen.label,
      insight: ownerInsight || answerInsight(q.text, chosen.label, rankFraction, `${seedBase}:q${i}`, areaLabels, bestLabel),
    };
  }).filter(Boolean);

  // What they told us outside the score, and what they asked for help with.
  const { about, helpWanted } = readAbout(questions, answers);
  const preferred = about.find(a => a.key === 'help');
  const typicalSigns = Array.isArray(tierConfig.signs)
    ? tierConfig.signs.map(x => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  const ownerHeadline = tierConfig.headline && tierConfig.headline.trim();
  const ownerMessage = tierConfig.message && tierConfig.message.trim();
  const recommendationUrl = (tierConfig.recommendationUrl && tierConfig.recommendationUrl.trim()) || '';
  const recommendationLabel = (tierConfig.recommendationLabel && tierConfig.recommendationLabel.trim()) || 'Book Now';
  const ownerRecommendation = tierConfig.recommendation && tierConfig.recommendation.trim();
  // A CTA block only ever shows once the owner has engaged with this
  // feature at all — written their own invitation text, given it a
  // destination link, or both; nothing here invents one for a tier the
  // owner never touched. Once there's a link but no text (a real gap this
  // was hitting: leaving the text blank was meant as "auto-write this,"
  // the same as every other field in this file, but this one field alone
  // had no generated fallback and silently produced no CTA at all), the
  // text gets generated instead of the block just disappearing.
  let recommendation = ownerRecommendation
    || (recommendationUrl ? tierRecommendation(overall, weakest.label, `${seedBase}:recommendation`) : '');
  // A preferred-help answer can carry its own next step (option.cta), which
  // beats the tier's — the person told us how they'd like to be helped.
  const prefCta = preferred && preferred.cta && preferred.cta.url ? preferred.cta : null;
  const finalUrl = (prefCta && prefCta.url) || recommendationUrl;
  const finalLabel = (prefCta && prefCta.label) || recommendationLabel;
  if (!recommendation && prefCta) recommendation = tierRecommendation(overall, weakest.label, `${seedBase}:recommendation`);
  let ctaLine = '';
  if (recommendation && helpWanted.length) {
    ctaLine = pick(`${seedBase}:ctaHelp`, CTA_HEADLINE_HELP)(firstName, shortTopic(helpWanted[0].topic));
  }

  return {
    greetingName: firstName,
    scorecardTitle: scorecard.title,
    overall,
    tierLabel,
    tierHeadline: ownerHeadline || tierHeadline(overall, `${seedBase}:tier`),
    tierMessage: ownerMessage || tierMessage(overall, strongest.label, weakest.label, `${seedBase}:tier`),
    recommendation,
    recommendationUrl: finalUrl,
    recommendationLabel: finalLabel,
    // Only meaningful once there's an actual recommendation to sit next to —
    // take.js only renders the CTA block at all when `recommendation` is set.
    // Always tied to the weakest category's own label, so the recommendation
    // and the "Book Now" CTA beneath it read as one connected thought on
    // every scorecard, not just the ones with an obvious weak point.
    ctaHeadline: recommendation ? (ctaLine || ctaHeadline(firstName, weakest.label, `${seedBase}:cta`)) : '',
    categoryNarratives,
    answerInsights,
    aboutYou: about,
    helpWanted,
    preferredHelp: preferred ? preferred.answer : '',
    typicalSigns: typicalSigns.length ? typicalSigns : generatedSigns(overall, strongest.label, weakest.label),
    // "The goal here:" line and the top-level priority list for the weakest area
    goal: tierSuggestion(weakest.label, bandFor(overall), `${seedBase}:goal`),
    priorities: { focus: weakest.label, items: categoryChecklist(band3For(weakest.score), `${seedBase}:${weakest.key}`) },
    areasMeasured: categories.map(c => c.label),
  };
}

module.exports = { buildPersonalizedResult, bandFor, BANDS };