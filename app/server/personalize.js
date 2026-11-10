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
    l => `${l} is firing on all cylinders — genuinely one of the strongest parts of this whole result. It's clear you've already put real thought into this, and it shows in how consistently your answers pointed the same direction. Whatever you're doing here, it's working — the priority now is protecting it, not fixing it.`,
    l => `There's very little to fault in ${l.toLowerCase()} — this is close to as good as it gets at this stage. It's the kind of foundation that makes everything else easier to build on, so it's worth recognising rather than taking for granted. Keep doing what got you here.`,
    l => `${l} stands out as a real strength, well above where most people land on this. That's not an accident — it usually reflects real preparation and honest self-awareness going in. From here, the smartest move is simply not to let this slip while you focus energy elsewhere.`,
  ],
  strong: [
    l => `${l} is in good shape — solidly ahead of where most people sit at this point. You're clearly not starting from zero here, and that head start matters more than it might feel like right now. A little more focused attention would be enough to push this from good to genuinely excellent.`,
    l => `You're doing well on ${l.toLowerCase()}, with just a little more headroom above you. This is a real strength worth building on rather than a gap that needs urgent fixing. The next honest step is deciding whether to lean further into it or shift your energy toward whatever's holding the rest of the picture back.`,
    l => `${l} is a genuine strength — a small, deliberate push here would put it firmly in the top tier. There's nothing urgent to fix, which is exactly why this is a good place to keep investing a little more. It's already carrying real weight in your overall result.`,
  ],
  solid: [
    l => `${l} is respectable — not a weak point, but not yet a standout either. This is the kind of area that's easy to overlook precisely because nothing about it is alarming, but there's a realistic, achievable path from here to genuinely strong. A bit of deliberate focus would move this meaningfully.`,
    l => `You're right around the middle on ${l.toLowerCase()} — steady, with clear room to push further. Nothing here is holding you back in any dramatic way, but it's also not yet doing the heavy lifting it could be. Worth a closer look next, once anything more urgent is handled.`,
    l => `${l} sits in reasonably good territory, with a realistic path to genuinely strong from here. It's neither the reason you'd hesitate nor the reason you'd feel fully confident — which usually means it just hasn't had focused attention yet. That makes it one of the more straightforward things to improve.`,
  ],
  developing: [
    l => `${l} is still finding its footing — there's real, achievable room to grow here, and that's genuinely good news. Gaps at this stage are almost always about attention, not ability — this isn't a fundamental problem, it's an unfinished one. Naming it clearly, like this result just did, is usually the hardest part.`,
    l => `${l} is a fair way off where it could be, and it's worth some deliberate, honest attention rather than being left to sort itself out. The encouraging part is that this kind of gap tends to close faster than people expect once it's actually being worked on. Right now it's likely quietly weighing on the rest of your picture.`,
    l => `You're behind where you'd want to be on ${l.toLowerCase()}, but it's a fixable gap, not a fundamental one. Most people carry at least one area like this — the difference is what happens next. Closing even part of this gap would change how the whole result feels, not just this one number.`,
  ],
  weak: [
    l => `${l} is genuinely lagging, and this is worth real, focused attention rather than a passing glance. It's one of the clearer weak points in the picture right now, and it's likely shaping how the rest of this feels more than any single answer suggests on its own. The honest read: this deserves to move up your priority list.`,
    l => `There's a real gap in ${l.toLowerCase()} — closing even part of it would change the overall result noticeably. This isn't about anything being wrong with you; it usually just means this area hasn't had the attention the rest has. Naming it plainly is the first useful step toward actually closing it.`,
    l => `${l} is well below where it needs to be — not a small tweak, a real focus area. It's easy to let a gap like this sit quietly in the background, but it's very likely doing more to hold back the overall picture than it seems. Worth treating as a genuine priority, not an afterthought.`,
  ],
  struggling: [
    l => `${l} is the clearest problem area in this whole result — and honestly, the one most worth addressing first. That's not meant as discouraging; it's the opposite; it means you now know exactly where the biggest single improvement is sitting, waiting to be made. Everything else in this result would likely look different once this gets real attention.`,
    l => `There's a real shortfall in ${l.toLowerCase()} that's dragging on the overall picture more than any other single factor here. This is the part of the result that calls for a genuine reset rather than a minor adjustment. The upside of a clear result like this is that there's no guesswork about where to start.`,
    l => `${l} needs the most attention of everything measured here, and it's worth being honest about that rather than smoothing it over. A result like this is uncomfortable to read, but it's also the most useful kind — it points straight at what would move the needle most. This is exactly the kind of thing worth talking through with someone who's helped others close a gap like it.`,
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
    l => `${l} is carrying real weight here — the job now is protecting it, not fixing it.`,
    l => `${l} is a genuine strength. Everything else gets easier once one part of the picture is already solid.`,
    l => `Keep leaning on ${l.toLowerCase()} — it's doing more for the overall result than it might seem.`,
  ],
  developing: [
    l => `${l} is steady, not yet a strength — a realistic, achievable path forward, not a fundamental problem.`,
    l => `There's real room to grow in ${l.toLowerCase()}, and closing even part of that gap changes the whole picture.`,
    l => `${l} is worth deliberate attention next — not urgent, but not something to leave on autopilot either.`,
  ],
  weak: [
    l => `${l} is the clearest place to focus first — closing this gap would move the whole result.`,
    l => `A real shortfall in ${l.toLowerCase()} is worth treating as a genuine priority, not an afterthought.`,
    l => `${l} needs the most attention of anything measured here — and now there's no guesswork about where to start.`,
  ],
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
      { label: 'Protect what works', text: 'Write down what you\'re actually doing right here so it survives changes in routine, team, or attention.' },
      { label: 'Raise the bar', text: 'A strength that stops improving quietly becomes average — set a slightly higher target here, not just a maintenance one.' },
      { label: 'Use it as leverage', text: 'Let this be the model for the areas that need more work — whatever\'s making this strong is probably transferable.' },
    ],
    [
      { label: 'Document the "why"', text: 'Knowing exactly why this is working makes it repeatable, not just lucky.' },
      { label: 'Stress-test it', text: 'Check whether this holds up under more pressure or scale, not just in ordinary conditions.' },
      { label: 'Share it', text: 'If this involves other people, make sure whatever\'s working here isn\'t sitting only with one person.' },
    ],
  ],
  developing: [
    [
      { label: 'Get specific', text: 'Write down exactly what "better" would look like here — vague goals rarely close a real gap.' },
      { label: 'Pick one lever', text: 'Choose the single change most likely to move this, rather than trying to fix everything about it at once.' },
      { label: 'Set a check-in point', text: 'Decide now when you\'ll revisit this — progress that isn\'t checked tends to quietly stall.' },
    ],
    [
      { label: 'Find the pattern', text: 'Look for what\'s actually causing this to sit in the middle rather than treating it as one-off bad luck.' },
      { label: 'Borrow what works elsewhere', text: 'Whatever\'s helping your stronger areas is probably at least partly transferable here.' },
      { label: 'Track it, don\'t just note it', text: 'A gap that\'s measured over time is far more likely to actually close.' },
    ],
  ],
  weak: [
    [
      { label: 'Name the real cause', text: 'Be honest about why this is lagging — a vague sense of "needs work" won\'t fix it, a specific cause might.' },
      { label: 'Start smaller than feels necessary', text: 'A weak area rarely gets fixed by one big push — a small, consistent change is more likely to stick.' },
      { label: 'Get outside input', text: 'This is exactly the kind of gap where a second, more experienced perspective tends to help the most.' },
    ],
    [
      { label: 'Make it the priority', text: 'Put this above lower-stakes items on your list — it\'s likely doing more damage to the overall picture than it appears to.' },
      { label: 'Set one concrete next step', text: 'Not a goal — an actual action you can take this week, however small.' },
      { label: 'Revisit soon', text: 'Check back on this specifically and often; gaps like this tend to close faster once they\'re being actively watched.' },
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
  'The place to focus first: ',
  "The clearest opportunity in the whole result: ",
  'Start here: ',
  'Out of everything measured, this is what matters most right now: ',
  'Priority one: ',
];

const STRONGEST_PREFIX = [
  'Your standout: ',
  "What's carrying the result: ",
  'Lean into this — ',
  'The clearest strength in the whole picture: ',
  'Worth noting first: ',
];

function categoryMessage(label, score, role, seed) {
  const band = bandFor(score);
  const base = pick(`${seed}:base`, CATEGORY_BASE[band])(label);
  if (role === 'weakest') return pick(`${seed}:prefix`, WEAKEST_PREFIX) + base.charAt(0).toLowerCase() + base.slice(1);
  if (role === 'strongest') return pick(`${seed}:prefix`, STRONGEST_PREFIX) + base.charAt(0).toLowerCase() + base.slice(1);
  return base;
}

// --- Tier headline & message, driven by the overall score --------------

const TIER_HEADLINE = {
  exceptional: ['You’re exactly where you want to be', 'This is about as strong a result as they come', 'A genuinely excellent result'],
  strong: ['You’re in a strong position', 'This is a result to feel good about', 'You’re well ahead of the curve'],
  solid: ['You’re in solid, workable shape', 'A steady result, with real upside', 'You’re on the right track'],
  developing: ['You’re making progress, with real room to grow', 'There’s a clear path forward from here', 'You’re partway there, with work still to do'],
  weak: ['There’s real work to do here', 'This result points to some real gaps', 'You’re starting from behind, but it’s fixable'],
  struggling: ['This is the starting point, not the destination', 'There’s significant ground to make up', 'A tough result — and a clear place to begin'],
};

const TIER_MESSAGE = {
  exceptional: [
    (s, w) => `An overall score like this doesn't happen by accident. ${s} in particular is doing a lot of the work — the priority now is keeping it that way.`,
    (s, w) => `This is a genuinely strong showing across the board, led by ${s.toLowerCase()}. If there's anywhere left to sharpen, it's ${w.toLowerCase()}.`,
  ],
  strong: [
    (s, w) => `A solid, above-average result, carried mainly by ${s.toLowerCase()}. ${w} is the one area still holding the overall picture back a little.`,
    (s, w) => `You're ahead of where most people land here, with ${s.toLowerCase()} doing most of the heavy lifting. Tightening up ${w.toLowerCase()} is the clearest next move.`,
  ],
  solid: [
    (s, w) => `A workable, middle-of-the-road result. ${s} is the bright spot; ${w.toLowerCase()} is the one dragging the average down the most.`,
    (s, w) => `Nothing here is alarming, but nothing is fully dialled in either. ${s} is furthest along — ${w.toLowerCase()} is where the next real gain sits.`,
  ],
  developing: [
    (s, w) => `There's a real gap between ${s.toLowerCase()}, which is genuinely working, and ${w.toLowerCase()}, which is holding the rest of the picture back.`,
    (s, w) => `This result is uneven rather than uniformly weak — ${s} is in decent shape, while ${w.toLowerCase()} is the clearest thing to fix first.`,
  ],
  weak: [
    (s, w) => `${w} is the main thing pulling this result down — it's a bigger gap than the rest of the picture. ${s} is the one relative bright spot to build from.`,
    (s, w) => `There's real work ahead, concentrated mostly in ${w.toLowerCase()}. ${s} shows it's not uniformly weak — there's something to build on.`,
  ],
  struggling: [
    (s, w) => `${w} is the clearest, most urgent gap here — closing even part of it would move the whole result. ${s} is the one part of the picture already pointing in the right direction.`,
    (s, w) => `This is a result that calls for a real reset, starting with ${w.toLowerCase()}. ${s} is worth holding onto as everything else gets rebuilt.`,
  ],
};

function tierHeadline(overall, seed) {
  const band = bandFor(overall);
  return pick(`${seed}:headline`, TIER_HEADLINE[band]);
}

const TIER_MESSAGE_SINGLE = {
  exceptional: [l => `${l} is doing exactly what it should — this is a genuinely strong result.`, l => `A result like this comes from ${l.toLowerCase()} being firmly in place.`],
  strong: [l => `This is an above-average result, carried by solid performance in ${l.toLowerCase()}.`, l => `${l} is in good shape, and it's showing in the overall result.`],
  solid: [l => `A steady, workable result on ${l.toLowerCase()} — no red flags, with real room still to grow.`, l => `${l} is holding its own here, without yet being a full strength.`],
  developing: [l => `${l} is the whole picture here, and it's still finding its footing — there's real room to grow.`, l => `This result comes down to ${l.toLowerCase()}, which has a clear runway to improve.`],
  weak: [l => `${l} is genuinely lagging, and since it's the whole picture here, it's worth real, focused attention.`, l => `There's a real gap in ${l.toLowerCase()} driving this result — closing it would change everything.`],
  struggling: [l => `${l} is significantly behind — and since it's the whole picture here, it's the clear place to start.`, l => `This result comes down entirely to ${l.toLowerCase()}, which needs the most attention right now.`],
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
  exceptional: [
    w => `The only thing left to do about ${w.toLowerCase()} is keep it from sliding while everything else gets the spotlight.`,
    w => `Treat ${w.toLowerCase()} the same way as the rest of this result — a quick regular check-in is enough to keep it exactly where it is.`,
  ],
  strong: [
    w => `A focused hour or two on ${w.toLowerCase()} is realistically all it would take to round this out.`,
    w => `${w} is the one thing worth scheduling real time for next — everything else here is already working.`,
  ],
  solid: [
    w => `Put ${w.toLowerCase()} at the top of the list for what to work on next — it's the most realistic place to actually move this result.`,
    w => `A specific, deliberate change to ${w.toLowerCase()} — not a vague intention — is what would shift this from solid to strong.`,
  ],
  developing: [
    w => `The clearest next step: put focused, deliberate attention on ${w.toLowerCase()} before anything else.`,
    w => `If there's one place to start, it's ${w.toLowerCase()} — closing even part of that gap would lift the whole result.`,
  ],
  weak: [
    w => `The most useful next move here is a concrete plan for ${w.toLowerCase()} — everything else gets easier once that's addressed.`,
    w => `Worth treating as the real priority: a specific, honest plan for improving ${w.toLowerCase()} would move the needle most.`,
  ],
  struggling: [
    w => `The single most useful thing to do next is build a real, specific plan for ${w.toLowerCase()} — everything else follows from that.`,
    w => `Make ${w.toLowerCase()} the one non-negotiable focus for now — it's doing more to shape this result than anything else measured.`,
  ],
};

function tierSuggestion(label, band, seed) {
  return pick(`${seed}:suggestion`, TIER_SUGGESTION[band])(label);
}

function tierMessage(overall, strongestLabel, weakestLabel, seed) {
  const band = bandFor(overall);
  if (strongestLabel === weakestLabel) {
    const fn = pick(`${seed}:message`, TIER_MESSAGE_SINGLE[band]);
    const base = fn(strongestLabel);
    return `${base} ${tierSuggestion(strongestLabel, band, `${seed}:suggestion`)}`;
  }
  const fn = pick(`${seed}:message`, TIER_MESSAGE[band]);
  const base = fn(strongestLabel, weakestLabel);
  return `${base} ${tierSuggestion(weakestLabel, band, `${seed}:suggestion`)}`;
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
    (area) => `This is a real strength. You're already in the strongest position here, and it's one of the reasons behind ${area}. Build on it rather than rethink it.`,
    (area) => `Nothing to fix here. This is exactly the position that makes ${area} work in your favour, so protect it as things change.`,
    (area) => `You're already where this needs to be. It gives ${area} a solid foundation to build everything else on.`,
  ],
  strong: [
    (area, best) => `A good position, just short of the strongest one ("${best}"). One small step closer would round out ${area}.`,
    (area, best) => `You're nearly there on this. Moving towards "${best}" is one of the quickest wins available for ${area}.`,
  ],
  mid: [
    (area, best) => `This keeps ${area} in the middle. The strongest position here is "${best}", and the distance between the two is where your quickest gains are.`,
    (area, best) => `Steady, but not yet working for you. The strongest position on this one is "${best}". Closing even part of that gap would show up in ${area}.`,
  ],
  weak: [
    (area, best) => `This is one of the answers holding ${area} back. The strongest position here is "${best}", which makes this well worth a closer look.`,
    (area, best) => `Worth a second look: this answer is costing ${area} more than it needs to. Moving even partway towards "${best}" would change your result.`,
  ],
  worst: [
    (area, best) => `This is where you lose the most ground on ${area} right now. The strongest position here is "${best}", and the good news is that this is also where change shows up fastest.`,
    (area, best) => `Right now this is the biggest drag on ${area}. Moving from here towards "${best}" would make a bigger difference than almost anything else on this question.`,
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
    w => `Everything here is working — if you'd like a second opinion on keeping it that way, ${w.toLowerCase()} included, this is the next step.`,
    w => `A result like this is worth protecting. If you'd like professional help making sure ${w.toLowerCase()} stays this strong, here's where to start.`,
  ],
  strong: [
    w => `You're close to a genuinely excellent result. If you'd like hands-on help closing the gap on ${w.toLowerCase()}, this is the next step.`,
    w => `A little expert input on ${w.toLowerCase()} could be what pushes this from good to excellent — here's where to get it.`,
  ],
  solid: [
    w => `${w} is the most realistic place to improve from here. If you'd like help putting a real plan together for it, this is the next step.`,
    w => `A workable result with a clear next move — get expert input on ${w.toLowerCase()} and turn this into a genuinely strong one.`,
  ],
  developing: [
    w => `${w} is the clearest place to start. If you'd like help building a real plan for it, this is the next step.`,
    w => `Closing the gap on ${w.toLowerCase()} would change this result the most — get expert help putting a plan together for it.`,
  ],
  weak: [
    w => `${w} needs real, focused attention. If you'd like expert help building a plan to fix it, this is the next step.`,
    w => `A dedicated plan for ${w.toLowerCase()} would make the biggest difference here — here's where to get help putting one together.`,
  ],
  struggling: [
    w => `${w} is the clearest place to start rebuilding from. If you'd like expert help putting together a real plan, this is the next step.`,
    w => `This is the kind of result worth talking through with someone who's helped others close a gap like this before.`,
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
  (n, w) => `Want to talk to a ${w.toLowerCase()} expert, ${n}?`,
  (n, w) => `${n}, ready to get real help with ${w.toLowerCase()}?`,
  (n, w) => `Want a second pair of eyes on ${w.toLowerCase()}, ${n}?`,
  (n, w) => `Ready to turn ${w.toLowerCase()} into a real next step, ${n}?`,
];

function ctaHeadline(firstName, weakestLabel, seed) {
  const fn = pick(`${seed}:ctaHeadline`, CTA_HEADLINE_CATEGORY);
  return fn(firstName, weakestLabel);
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
    return { key: c.key, label: c.label, score: c.score, band: band3, headline, message, checklist };
  });

  const answerInsights = questions.map((q, i) => {
    const chosenIdx = answers[i];
    const chosen = q.options[chosenIdx];
    if (!chosen) return null;
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
  const recommendation = ownerRecommendation
    || (recommendationUrl ? tierRecommendation(overall, weakest.label, `${seedBase}:recommendation`) : '');

  return {
    greetingName: firstName,
    scorecardTitle: scorecard.title,
    overall,
    tierLabel,
    tierHeadline: ownerHeadline || tierHeadline(overall, `${seedBase}:tier`),
    tierMessage: ownerMessage || tierMessage(overall, strongest.label, weakest.label, `${seedBase}:tier`),
    recommendation,
    recommendationUrl,
    recommendationLabel,
    // Only meaningful once there's an actual recommendation to sit next to —
    // take.js only renders the CTA block at all when `recommendation` is set.
    // Always tied to the weakest category's own label, so the recommendation
    // and the "Book Now" CTA beneath it read as one connected thought on
    // every scorecard, not just the ones with an obvious weak point.
    ctaHeadline: recommendation ? ctaHeadline(firstName, weakest.label, `${seedBase}:cta`) : '',
    categoryNarratives,
    answerInsights,
  };
}

module.exports = { buildPersonalizedResult, bandFor, BANDS };