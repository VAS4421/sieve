// Public scorecard-taking engine — fetches a published scorecard by slug,
// walks the visitor through it, and submits answers to the server, which
// computes and returns the real score (scoring weights never reach the browser).

(async function initTake() {
  const root = document.getElementById('demo-root');
  const params = new URLSearchParams(location.search);
  const slug = params.get('slug');

  if (!slug) {
    root.innerHTML = `<div class="demo-body"><p class="text-center">No scorecard specified.</p></div>`;
    return;
  }

  if (params.get('embed') === '1') document.body.classList.add('is-embed');

  // Preview mode — opened from the builder's Preview button so an owner can
  // click through their own scorecard before publishing it. Hits the
  // authenticated /api/scorecards/preview/* routes (owner-only, works
  // regardless of published state) instead of the public ones, and never
  // records a lead on submit.
  const isPreview = params.get('preview') === '1';
  if (isPreview) {
    document.body.classList.add('is-preview');
    const banner = document.createElement('div');
    banner.className = 'preview-banner';
    banner.textContent = 'Preview — this is a draft. Nothing submitted here is saved as a lead.';
    document.body.prepend(banner);
  }

  let scorecard;
  try {
    const res = await fetch(isPreview
      ? `/api/scorecards/preview/${encodeURIComponent(slug)}`
      : `/api/public/scorecards/${encodeURIComponent(slug)}`,
      isPreview ? { credentials: 'include' } : undefined);
    if (!res.ok) throw new Error((await res.json()).error || 'Not found');
    scorecard = await res.json();
  } catch (err) {
    root.innerHTML = `<div class="demo-body"><p class="text-center">This scorecard isn't available. ${err.message ? '(' + err.message + ')' : ''}</p></div>`;
    return;
  }

  const brandName = scorecard.brandName || 'Sieve';
  document.title = `${scorecard.title} — ${brandName}`;
  const brandEl = document.getElementById('brand-name');
  if (brandEl) brandEl.textContent = brandName;

  let step = -1;
  const answers = [];
  let lead = {};
  let profile = {};
  let nudgeStartId = null;
  let startTime = null;
  const pc = scorecard.profileCapture || { enabled: false };

  // Lead form placement and landing sections (owner settings, see builder).
  const lc = scorecard.leadCapture || { position: 'start', phone: 'required' };
  const landing = scorecard.landing || {};
  const formAtEnd = lc.position === 'end';
  let leadCaptured = false;

  function render() {
    if (step === -1) return renderGate();
    if (step >= scorecard.questions.length) return (formAtEnd && !leadCaptured) ? renderLeadForm() : renderResult();
    renderQuestion();
  }

  function leadFieldsHtml() {
    return `
          <div class="demo-gate-row">
            <input type="text" id="g-first" placeholder="First name" autocomplete="given-name" />
            <input type="text" id="g-last" placeholder="Last name" autocomplete="family-name" />
          </div>
          ${lc.phone === 'off' ? '' : `<input type="tel" id="g-phone" placeholder="Phone number${lc.phone === 'optional' ? ' (optional)' : ''}" autocomplete="tel" />`}
          <input type="email" id="g-email" placeholder="Email" autocomplete="email" />
          ${profileFieldsHtml()}`;
  }

  // Reads and checks the lead fields; returns true when they are complete.
  function readLeadFields(errorEl) {
    errorEl.style.display = 'none';
    const val = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
    const required = ['g-first', 'g-last', 'g-email'].concat(lc.phone === 'required' ? ['g-phone'] : []);
    if (required.some(id => !val(id))) {
      errorEl.textContent = lc.phone === 'required' ? 'Please fill in your name, phone number, and email.' : 'Please fill in your name and email.';
      errorEl.style.display = 'block';
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('g-email'))) {
      errorEl.textContent = 'Please check your email address.';
      errorEl.style.display = 'block';
      return false;
    }
    if (pc.enabled) {
      const requiredIds = [
        pc.captureAge && 'p-age', pc.captureGender && 'p-gender',
        pc.captureLocation && 'p-location', pc.captureSocialClass && 'p-social',
        (pc.interestOptions && pc.interestOptions.length) && 'p-interest',
      ].filter(Boolean);
      if (requiredIds.some(id => !document.getElementById(id).value)) {
        errorEl.textContent = 'Please answer every field above.';
        errorEl.style.display = 'block';
        return false;
      }
      profile = {
        ...(pc.captureAge ? { ageRange: document.getElementById('p-age').value } : {}),
        ...(pc.captureGender ? { gender: document.getElementById('p-gender').value } : {}),
        ...(pc.captureLocation ? { location: document.getElementById('p-location').value } : {}),
        ...(pc.captureSocialClass ? { socialClass: document.getElementById('p-social').value } : {}),
        ...((pc.interestOptions && pc.interestOptions.length) ? { interest: document.getElementById('p-interest').value } : {}),
      };
    }
    lead = { firstName: val('g-first'), lastName: val('g-last'), phone: val('g-phone'), email: val('g-email') };
    leadCaptured = true;
    return true;
  }

  function landingExtrasHtml(onCover) {
    const n = scorecard.questions.length;
    const mins = Math.max(1, Math.round(n * 0.2));
    const bullets = (landing.bullets || []).filter(Boolean);
    return `
        ${bullets.length ? `<div class="tk-land-list ${onCover ? 'on-cover' : ''}"><b>What you'll find out</b><ul>${bullets.map(b => `<li><i aria-hidden="true">✓</i><span>${escapeHtml(b)}</span></li>`).join('')}</ul></div>` : ''}
        ${landing.audience ? `<p class="tk-land-aud ${onCover ? 'on-cover' : ''}">${escapeHtml(landing.audience)}</p>` : ''}
        <div class="tk-land-meta ${onCover ? 'on-cover' : ''}"><span>⏱ About ${mins} min</span><span>${n} questions</span><span>Free and private</span></div>`;
  }

  function profileFieldsHtml() {
    if (!pc.enabled) return '';
    const rows = [];
    if (pc.captureAge) rows.push(selectField('p-age', 'Age range', pc.ageRanges));
    if (pc.captureGender) rows.push(selectField('p-gender', 'Gender', pc.genders));
    if (pc.captureLocation) rows.push(selectField('p-location', 'Location', pc.locations));
    if (pc.captureSocialClass) rows.push(selectField('p-social', 'Income bracket', pc.socialClasses));
    if (pc.interestOptions && pc.interestOptions.length) {
      rows.push(selectField('p-interest', pc.interestQuestion || 'Which best describes your interest?', pc.interestOptions));
    }
    if (!rows.length) return '';
    return `<div class="demo-profile-fields">${rows.join('')}</div>`;
  }

  function selectField(id, label, options) {
    return `
      <select id="${id}" class="demo-select" required>
        <option value="" disabled selected>${escapeHtml(label)}</option>
        ${options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}
      </select>
    `;
  }

  function renderGate() {
    const cover = scorecard.coverImage && scorecard.coverImage.trim();
    const startLabel = escapeHtml(landing.button || (formAtEnd ? 'Start the scorecard →' : 'Start →'));
    const gateInner = `
        <div class="demo-q" style="margin-bottom:10px;">${escapeHtml(scorecard.title)}</div>
        <p class="tk-land-intro">${escapeHtml(scorecard.intro || '')}</p>
        ${landingExtrasHtml(!!cover)}
        <div class="demo-gate">
          ${formAtEnd ? '' : leadFieldsHtml()}
          <button class="btn btn-accent btn-block" id="g-start">${startLabel}</button>
          <p id="g-error" class="demo-gate-error" style="display:none;"></p>
          ${landing.trust ? `<p class="tk-land-trust">${escapeHtml(landing.trust)}</p>` : ''}
        </div>
    `;
    root.innerHTML = cover
      ? `<div class="demo-cover" style="background-image:url('${escapeHtml(cover)}');">
           <div class="demo-cover-overlay"><div class="demo-body demo-cover-body">${gateInner}</div></div>
         </div>`
      : `<div class="demo-body">${gateInner}</div>`;
    document.getElementById('g-start').addEventListener('click', () => {
      const errorEl = document.getElementById('g-error');
      if (!formAtEnd && !readLeadFields(errorEl)) return;
      startTime = Date.now();
      // Fire-and-forget — powers the completion-rate figure in the owner's
      // aggregate report; never blocks the visitor moving to question 1.
      // Skipped in preview so clicking through your own draft doesn't
      // pollute that figure with test runs.
      if (!isPreview) {
        fetch(`/api/public/scorecards/${encodeURIComponent(slug)}/start`, { method: 'POST' }).catch(() => {});
      }
      if (!isPreview && lead.email) {
        fetch('/api/public/scorecard-nudge-starts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, firstName: lead.firstName, lastName: lead.lastName, email: lead.email, phone: lead.phone }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data && data.nudgeStartId) nudgeStartId = data.nudgeStartId; })
          .catch(() => {});
      }
      step = 0;
      render();
    });
  }

  function renderProgress() {
    let bar = document.querySelector('.demo-progress-wrap');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'demo-progress-wrap';
      bar.innerHTML = `<div class="demo-progress-bar"><div class="demo-progress-fill"></div></div><div class="demo-progress-label"></div>`;
      root.parentElement.insertBefore(bar, root.nextSibling);
    }
    const pct = step < 0 ? 0 : Math.round((step / scorecard.questions.length) * 100);
    bar.querySelector('.demo-progress-fill').style.width = pct + '%';
    bar.querySelector('.demo-progress-label').textContent = pct + '% complete';
    bar.style.display = step >= scorecard.questions.length ? 'none' : 'flex';
  }

  // Question formats (see app/server/questions.js): 'choice' (a list),
  // 'yesno' (warm labels, maybe an "I'd like help with this"), 'scale'
  // (1–5 agreement) and 'text' (an open "about you" box). "About you"
  // questions get a gentle note that they don't affect the score.
  const firstAboutIdx = scorecard.questions.findIndex(q => q.kind === 'about');

  function answerControlsHtml(q) {
    const prev = answers[step];
    if (q.format === 'text') {
      return `
        <textarea id="d-text" class="tk-text" rows="4" maxlength="1000" placeholder="Type as much or as little as you like">${escapeHtml(typeof prev === 'string' ? prev : '')}</textarea>
        <div class="tk-text-actions">
          <button class="tk-skip" id="d-skip" type="button">Skip</button>
          <button class="btn btn-accent" id="d-next" type="button">Continue →</button>
        </div>`;
    }
    if (q.format === 'scale') {
      const opts = q.options;
      return `
        <div class="tk-scale" role="radiogroup" aria-label="${escapeHtml(q.text)}">
          ${opts.map((opt, i) => `<button class="demo-opt tk-scale-btn${prev === i ? ' is-on' : ''}" data-i="${i}" role="radio" aria-checked="${prev === i}" title="${escapeHtml(opt.label)}"><b>${i + 1}</b><span>${escapeHtml(opt.label)}</span></button>`).join('')}
        </div>
        <div class="tk-scale-ends"><span>${escapeHtml(opts[0].label)}</span><span>${escapeHtml(opts[opts.length - 1].label)}</span></div>`;
    }
    const cls = q.format === 'yesno' ? 'demo-answers tk-yesno' : 'demo-answers';
    return `<div class="${cls}">
      ${q.options.map((opt, i) => `<button class="demo-opt${opt.help ? ' tk-help' : ''}${prev === i ? ' is-on' : ''}" data-i="${i}">${opt.help ? '<span class="tk-help-ic" aria-hidden="true">✋</span>' : ''}${escapeHtml(opt.label)}</button>`).join('')}
    </div>`;
  }

  function renderQuestion() {
    const q = scorecard.questions[step];
    renderProgress();
    const isAbout = q.kind === 'about';
    const aboutIntro = isAbout && step === firstAboutIdx
      ? `<div class="tk-about-note"><b>Nearly done. A few quick questions about you.</b><span>These don't affect your score. They help us make your next step useful.</span></div>`
      : (isAbout ? `<div class="tk-about-chip">About you · not scored</div>` : '');
    root.innerHTML = `
      <div class="demo-body tk-q-${escapeHtml(q.format || 'choice')}">
        ${step > 0 ? `<div class="demo-back" id="d-back">← Back</div>` : ''}
        ${aboutIntro}
        <div class="demo-q">${escapeHtml(q.text)}</div>
        ${q.hint ? `<p class="tk-hint">${escapeHtml(q.hint)}</p>` : ''}
        ${answerControlsHtml(q)}
      </div>
    `;
    const advance = (value) => {
      answers[step] = value;
      answers.length = step + 1;
      step += 1;
      render();
    };
    if (step > 0) {
      document.getElementById('d-back').addEventListener('click', () => { step -= 1; render(); });
    }
    root.querySelectorAll('.demo-opt').forEach(btn => {
      btn.addEventListener('click', () => advance(parseInt(btn.dataset.i, 10)));
    });
    if (q.format === 'text') {
      const box = document.getElementById('d-text');
      box.focus();
      document.getElementById('d-next').addEventListener('click', () => advance(box.value.trim()));
      document.getElementById('d-skip').addEventListener('click', () => advance(''));
    }
  }

  // Lead form after the last question (when the owner places it at the end):
  // the result is ready, we just ask where to send it.
  function renderLeadForm() {
    renderProgress();
    const name = scorecard.brandName ? escapeHtml(scorecard.brandName) : '';
    root.innerHTML = `
      <div class="demo-body tk-leadform">
        <div class="demo-back" id="d-back">← Back</div>
        <div class="tk-ready"><span class="tk-ready-dot" aria-hidden="true"></span>Your result is ready</div>
        <div class="demo-q" style="margin-bottom:8px;">${escapeHtml(lc.headline || 'Where should we send your result?')}</div>
        <p class="tk-hint" style="margin:0 0 22px;">${escapeHtml(lc.note || `Your score and personal report will show on the next screen${name ? `, and ${name} will send you a copy` : ''}.`)}</p>
        <div class="demo-gate">
          ${leadFieldsHtml()}
          <button class="btn btn-accent btn-block" id="g-see">See my result →</button>
          <p id="g-error" class="demo-gate-error" style="display:none;"></p>
        </div>
      </div>`;
    document.getElementById('d-back').addEventListener('click', () => { step = scorecard.questions.length - 1; render(); });
    document.getElementById('g-see').addEventListener('click', () => {
      if (!readLeadFields(document.getElementById('g-error'))) return;
      render();
    });
    const first = document.getElementById('g-first'); if (first) first.focus();
  }

  const BAND_COLOR = { strong: '#16825D', developing: '#B3720C', weak: '#B3261E' };
  const BAND_LEGEND_LABEL = { strong: 'Strong', developing: 'Developing', weak: 'Needs focus' };

  const CATEGORY_ICONS = {
    team: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21c0-3.3 3.6-6 8-6s8 2.7 8 6"/>',
    people: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21c0-3.3 3.6-6 8-6s8 2.7 8 6"/>',
    leadership: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21c0-3.3 3.6-6 8-6s8 2.7 8 6"/>',
    decision: '<path d="M12 3v6M12 9 6 20M12 9l6 11"/>',
    strategy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    strategic: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    planning: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    problem: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>',
    budget: '<path d="M3 6h18v12H3z"/><circle cx="12" cy="12" r="2.5"/>',
    finance: '<path d="M3 6h18v12H3z"/><circle cx="12" cy="12" r="2.5"/>',
    price: '<path d="M3 6h18v12H3z"/><circle cx="12" cy="12" r="2.5"/>',
    communication: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    marketing: '<path d="m3 11 18-8-8 18-2-8-8-2Z"/>',
    sales: '<path d="m3 11 18-8-8 18-2-8-8-2Z"/>',
    growth: '<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/>',
    quality: '<path d="M12 2 3 7v6c0 5 4 8 9 9 5-1 9-4 9-9V7Z"/>',
    safety: '<path d="M12 2 3 7v6c0 5 4 8 9 9 5-1 9-4 9-9V7Z"/>',
    risk: '<path d="M12 2 3 7v6c0 5 4 8 9 9 5-1 9-4 9-9V7Z"/>',
    tech: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>',
    digital: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/>',
  };
  const DEFAULT_ICON = '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5"/>';

  function categoryIconSvg(label) {
    const lower = label.toLowerCase();
    const key = Object.keys(CATEGORY_ICONS).find(k => lower.includes(k));
    const inner = CATEGORY_ICONS[key] || DEFAULT_ICON;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  }

  function buildResultDonut(categories, overall) {
    const size = 260;
    const cx = size / 2;
    const cy = size / 2;
    const r = 80;
    const circumference = 2 * Math.PI * r;

    if (categories.length <= 1) {
      const color = categories.length ? (BAND_COLOR[categories[0].band] || 'var(--accent)') : 'var(--accent)';
      return `
        <div class="score-ring" style="--pct:${overall};--ring-color:${color};">
          <div class="score-ring-inner">
            <div class="score-ring-num">${overall}%</div>
            <div class="score-ring-label">OVERALL SCORE</div>
          </div>
        </div>`;
    }

    const gapDeg = 6; // visual gap between slices, in degrees
    const sliceDeg = 360 / categories.length;
    const arcDeg = sliceDeg - gapDeg;
    const arcLen = (arcDeg / 360) * circumference;

    let cumulativeDeg = -90; // start at 12 o'clock
    const arcs = [];
    const labels = [];
    categories.forEach((c) => {
      const startDeg = cumulativeDeg + gapDeg / 2;
      const midDeg = startDeg + arcDeg / 2;
      const dashOffset = -((startDeg + 90) / 360) * circumference;
      arcs.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${BAND_COLOR[c.band] || 'var(--accent)'}"
        stroke-width="20" stroke-linecap="round"
        stroke-dasharray="${arcLen} ${circumference - arcLen}"
        stroke-dashoffset="${dashOffset}" />`);

      const rad = (midDeg * Math.PI) / 180;
      const labelR = r + 34;
      const lineR1 = r + 12;
      const lineR2 = r + 26;
      const x1 = cx + lineR1 * Math.cos(rad);
      const y1 = cy + lineR1 * Math.sin(rad);
      const x2 = cx + lineR2 * Math.cos(rad);
      const y2 = cy + lineR2 * Math.sin(rad);
      const lx = cx + labelR * Math.cos(rad);
      const ly = cy + labelR * Math.sin(rad);
      const anchor = Math.cos(rad) > 0.15 ? 'start' : Math.cos(rad) < -0.15 ? 'end' : 'middle';
      labels.push(`
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--line)" stroke-width="1.5" />
        <text x="${lx}" y="${ly - 4}" text-anchor="${anchor}" class="donut-label-pct" fill="${BAND_COLOR[c.band] || 'var(--ink)'}">${c.score}%</text>
        <text x="${lx}" y="${ly + 11}" text-anchor="${anchor}" class="donut-label-name">${escapeHtml(c.label)}</text>
      `);
      cumulativeDeg += sliceDeg;
    });

    return `
      <div class="result-donut-wrap">
        <svg viewBox="0 0 ${size} ${size}" class="result-donut">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="20" />
          ${arcs.join('')}
          ${labels.join('')}
        </svg>
        <div class="result-donut-center">
          <div class="score-ring-num">${overall}%</div>
          <div class="score-ring-label">OVERALL SCORE</div>
        </div>
      </div>`;
  }

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  function buildShareText(template, ctx) {
    const fallback = `I scored ${ctx.score}% on "${ctx.title}"! Check yours: ${ctx.link}`;
    if (!template) return fallback;
    return template
      .replace(/\{score\}/g, ctx.score)
      .replace(/\{title\}/g, ctx.title)
      .replace(/\{brand\}/g, ctx.brand)
      .replace(/\{tier\}/g, ctx.tier)
      .replace(/\{link\}/g, ctx.link);
  }

  // ---------- the result page ----------
  // Built as a journey: the reveal (score + tier), what they didn't know about themselves (strength vs blind
  // spot), the gap to their best result, the category deep-dive, their own answers read back with insight,
  // then the next step. Everything shown comes from the server's personalised result for this lead.
  const BAND = {
    strong: { color: '#0E9F6E', soft: '#E2F7EF', label: 'Strong' },
    developing: { color: '#D98A06', soft: '#FFF4DE', label: 'Developing' },
    weak: { color: '#E5484D', soft: '#FDECEC', label: 'Needs focus' },
  };
  const overallBand = (n) => (n >= 70 ? 'strong' : n >= 40 ? 'developing' : 'weak');

  // "Your score map": a radar chart for 3+ areas (their shape against full marks), twin rings for 2 areas.
  // Pure SVG, no library, so it renders the same in the page and in screenshots.
  function scoreMapSvg(cats) {
    const n = cats.length;
    if (n === 2) {
      const ring = (c, r, i) => {
        const len = 2 * Math.PI * r, col = (BAND[c.band] || BAND.developing).color;
        return `<circle cx="130" cy="130" r="${r}" class="rx-map-track"/>
          <circle cx="130" cy="130" r="${r}" class="rx-map-arc" style="--c:${col};--len:${len.toFixed(1)};--to:${(len * (1 - c.score / 100)).toFixed(1)};--d:${i * 0.25}s" transform="rotate(-90 130 130)"/>`;
      };
      return `<svg viewBox="0 0 260 260" class="rx-map-svg" role="img" aria-label="${cats.map(c => `${escapeHtml(c.label)} ${c.score}%`).join(', ')}">
        ${ring(cats[0], 104, 0)}${ring(cats[1], 76, 1)}
        <text x="130" y="124" class="rx-map-mid">${Math.round((cats[0].score + cats[1].score) / 2)}%</text>
        <text x="130" y="146" class="rx-map-sub">average</text></svg>`;
    }
    const cx = 160, cy = 150, R = 104;
    const pt = (i, f) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f]; };
    const poly = (f) => cats.map((_, i) => pt(i, typeof f === 'function' ? f(i) : f).map(v => v.toFixed(1)).join(',')).join(' ');
    const grid = [0.25, 0.5, 0.75, 1].map(f => `<polygon points="${poly(f)}" class="rx-map-grid${f === 1 ? ' outer' : ''}"/>`).join('');
    const axes = cats.map((_, i) => { const [x, y] = pt(i, 1); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="rx-map-axis"/>`; }).join('');
    const strongRing = `<polygon points="${poly(0.7)}" class="rx-map-strong"/>`;
    const shape = `<g class="rx-map-shape" style="transform-origin:${cx}px ${cy}px"><polygon points="${poly(i => Math.max(0.04, cats[i].score / 100))}" class="rx-map-poly"/>
      ${cats.map((c, i) => { const [x, y] = pt(i, Math.max(0.04, c.score / 100)); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" class="rx-map-dot" style="--c:${(BAND[c.band] || BAND.developing).color}"/>`; }).join('')}</g>`;
    const labels = cats.map((c, i) => {
      const [x, y] = pt(i, 1.2), anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
      const words = String(c.label).split(' '), lines = [];
      words.forEach(w => { const last = lines[lines.length - 1]; if (last && (last + ' ' + w).length <= 14) lines[lines.length - 1] = last + ' ' + w; else lines.push(w); });
      const dy = y < cy - 10 ? -(lines.length - 1) * 13 : 0;
      return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" class="rx-map-label">${lines.map((l, k) => `<tspan x="${x.toFixed(1)}" dy="${k ? 13 : 0}">${escapeHtml(l)}</tspan>`).join('')}<tspan x="${x.toFixed(1)}" dy="15" class="rx-map-val">${c.score}%</tspan></text>`;
    }).join('');
    return `<svg viewBox="-20 -14 360 330" class="rx-map-svg" role="img" aria-label="${cats.map(c => `${escapeHtml(c.label)} ${c.score}%`).join(', ')}">
      <defs><linearGradient id="rxmapg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C93FF"/><stop offset="1" stop-color="#22D3EE"/></linearGradient>
        <radialGradient id="rxmapfill"><stop offset="0" stop-color="#22D3EE" stop-opacity=".55"/><stop offset="1" stop-color="#5B6CFF" stop-opacity=".28"/></radialGradient></defs>
      ${grid}${axes}${strongRing}${shape}${labels}</svg>`;
  }

  async function renderResult() {
    renderProgress();
    root.innerHTML = `<div class="rx-loading"><div class="rx-spinner"></div><p>Reading your answers…</p></div>`;

    const timeToCompleteSeconds = startTime ? Math.round((Date.now() - startTime) / 1000) : null;
    let result;
    try {
      const res = await fetch(isPreview
        ? `/api/scorecards/preview/${encodeURIComponent(slug)}/submit`
        : `/api/public/scorecards/${encodeURIComponent(slug)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: isPreview ? 'include' : 'same-origin',
        body: JSON.stringify({ ...lead, answers, profile, timeToCompleteSeconds, nudgeStartId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not submit.');
      result = await res.json();
    } catch (err) {
      root.innerHTML = `<div class="demo-body"><p class="text-center">Something went wrong submitting your answers. ${escapeHtml(err.message)}</p></div>`;
      return;
    }

    const p = result.personalization;
    const cats = p.categoryNarratives || [];
    const name = escapeHtml(p.greetingName && p.greetingName !== 'there' ? p.greetingName : '');
    const ob = overallBand(p.overall);
    const sorted = [...cats].sort((a, b) => a.score - b.score);
    const weakest = sorted[0], strongest = sorted[sorted.length - 1];
    const showPair = cats.length > 1 && strongest.score - weakest.score >= 10;
    const gap = Math.max(0, 100 - p.overall);
    const hasCta = !!(p.recommendation && p.recommendationUrl);
    const ctaLabel = escapeHtml(p.recommendationLabel || 'Book Now');

    const shareLink = `${location.origin}/take/index.html?slug=${slug}`;
    const shareText = buildShareText(result.shareTemplate, { score: p.overall, title: scorecard.title, brand: brandName, tier: p.tierLabel, link: shareLink });
    const whatsappHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    const waIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.77.46 3.45 1.32 4.94L2 22l5.2-1.29A9.96 9.96 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2Zm0 18a7.96 7.96 0 0 1-4.06-1.11l-.29-.17-3.09.77.83-2.99-.19-.31A7.96 7.96 0 1 1 12 20Zm4.38-5.96c-.24-.12-1.41-.7-1.63-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1-.37-1.9-1.17-.7-.62-1.18-1.39-1.31-1.63-.14-.24-.01-.37.11-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.31-.02-.43-.06-.12-.54-1.31-.74-1.79-.2-.47-.4-.4-.54-.41h-.47c-.16 0-.42.06-.64.31-.22.24-.85.83-.85 2.04 0 1.21.87 2.37 1 2.53.12.16 1.71 2.62 4.15 3.67.58.25 1.03.4 1.38.51.58.19 1.1.16 1.52.1.46-.07 1.41-.58 1.61-1.13.2-.56.2-1.03.14-1.13-.06-.1-.22-.16-.46-.28Z"/></svg>`;
    const arrow = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

    // 1. the reveal
    const hero = `
      <section class="rx-hero rx-${ob}">
        <p class="rx-eyebrow">${name ? `${name}, here's` : `Here's`} what your answers reveal</p>
        <div class="rx-ring" style="--p:0" data-target="${p.overall}">
          <svg viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="rxg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2, #12C2E9)"/></linearGradient></defs>
            <circle cx="60" cy="60" r="52" class="rx-ring-bg"/><circle cx="60" cy="60" r="52" class="rx-ring-fg" pathLength="100"/></svg>
          <div class="rx-ring-c"><b><span data-count="${p.overall}">0</span><i>%</i></b><small>your score</small></div>
        </div>
        <span class="rx-tier" style="--c:${BAND[ob].color};--s:${BAND[ob].soft}">${escapeHtml(p.tierLabel)}</span>
        <h1 class="rx-h1">${escapeHtml(p.tierHeadline)}</h1>
        ${p.tierMessage ? `<p class="rx-lead">${escapeHtml(p.tierMessage)}</p>` : ''}
        ${result.engagementMode && result.timeToCompleteSeconds != null ? `<span class="rx-time">⏱ Completed in ${formatDuration(result.timeToCompleteSeconds)}</span>` : ''}
        ${hasCta ? `<a class="rx-btn rx-hero-btn" href="${escapeHtml(p.recommendationUrl)}" target="_blank" rel="noopener">${ctaLabel}${arrow}</a>` : ''}
      </section>`;

    // 2. what they didn't know about themselves
    const pair = showPair ? `
      <section class="rx-section">
        <p class="rx-kicker">What stands out</p>
        <h2 class="rx-h2">${name ? `${name}, this` : 'This'} is what your answers say about you.</h2>
        <div class="rx-pair">
          <div class="rx-pcard good">
            <span class="rx-pc-tag">Your strength</span>
            <div class="rx-pc-top"><b>${escapeHtml(strongest.label)}</b><span>${strongest.score}%</span></div>
            <div class="rx-bar"><i data-w="${strongest.score}" style="--c:${BAND[strongest.band].color}"></i></div>
            <p>${escapeHtml(strongest.headline)}</p>
          </div>
          <div class="rx-pcard gap">
            <span class="rx-pc-tag">Your blind spot</span>
            <div class="rx-pc-top"><b>${escapeHtml(weakest.label)}</b><span>${weakest.score}%</span></div>
            <div class="rx-bar"><i data-w="${weakest.score}" style="--c:${BAND[weakest.band].color}"></i></div>
            <p>${escapeHtml(weakest.headline)}</p>
          </div>
        </div>
      </section>` : '';

    // 3. the gap to their best result
    const gapBlock = gap > 0 ? `
      <section class="rx-gapcard">
        <div class="rx-gap-copy">
          <p class="rx-kicker light">Your potential</p>
          <h2>You're at <b>${p.overall}%</b>. ${gap} point${gap === 1 ? '' : 's'} stand between you and your best result.</h2>
          <p>${cats.length > 1 ? `Most of that gap sits in <b>${escapeHtml(weakest.label)}</b>. Small changes there move your whole score.` : 'The steps below show exactly where to start.'}</p>
        </div>
        <div class="rx-track" aria-hidden="true">
          <div class="rx-track-fill" data-w="${p.overall}"></div>
          <span class="rx-you" style="left:${p.overall}%"><i></i><em>You · ${p.overall}%</em></span>
          <span class="rx-goal"><em>Your best · 100%</em></span>
        </div>
      </section>` : '';

    // 3b. the score map: chart + bars, on a premium dark panel
    const byScore = [...cats].sort((a, b) => b.score - a.score);
    const mapBlock = cats.length > 1 ? `
      <section class="rx-map" id="rx-map">
        <div class="rx-map-head">
          <div><p class="rx-kicker light">Your score map</p><h2>The shape of ${name ? `${name}'s` : 'your'} result.</h2></div>
          <div class="rx-map-key"><span><i class="you"></i>${name || 'You'}</span><span><i class="strong"></i>Strong (70%)</span><span><i class="full"></i>Full marks</span></div>
        </div>
        <div class="rx-map-body">
          <div class="rx-map-chart">${scoreMapSvg(cats)}</div>
          <div class="rx-map-bars">${byScore.map(c => { const b = BAND[c.band] || BAND.developing; return `
            <div class="rx-mbar" style="--c:${b.color}">
              <div class="rx-mbar-top"><span class="rx-mbar-ic">${categoryIconSvg(c.label)}</span><b>${escapeHtml(c.label)}</b><em>${b.label}</em><strong>${c.score}<small>%</small></strong></div>
              <div class="rx-mbar-track"><i data-w="${c.score}"></i><span class="rx-mbar-mark" title="Strong: 70%"></span></div>
            </div>`; }).join('')}
            <p class="rx-map-note">${byScore[0].score - byScore[byScore.length - 1].score >= 10 ? `Your shape leans towards <b>${escapeHtml(byScore[0].label)}</b>. Lifting <b>${escapeHtml(byScore[byScore.length - 1].label)}</b> rounds it out fastest.` : 'Your areas are evenly matched, so steady gains across the board will lift your whole score.'}</p>
          </div>
        </div>
      </section>` : '';

    // 4. the category deep-dive (biggest opportunity first)
    const ordered = cats.length > 1 ? [weakest, ...cats.filter(c => c.key !== weakest.key && c.key !== strongest.key), strongest] : cats;
    const catBlock = cats.length ? `
      <section class="rx-section">
        <p class="rx-kicker">${cats.length > 1 ? 'Area by area' : 'Your breakdown'}</p>
        <h2 class="rx-h2">${cats.length > 1 ? 'What each area means for you.' : 'Where you stand, area by area.'}</h2>
        <div class="rx-cats">${ordered.map((c, i) => {
          const b = BAND[c.band] || BAND.developing;
          const badge = cats.length > 1 && c.key === weakest.key && showPair ? '<span class="rx-badge op">Biggest opportunity</span>' : cats.length > 1 && c.key === strongest.key && showPair ? '<span class="rx-badge st">Your strength</span>' : '';
          return `<article class="rx-cat ${i === 0 ? 'open' : ''}" style="--c:${b.color};--s:${b.soft}">
            <button class="rx-cat-head" type="button" aria-expanded="${i === 0}">
              <span class="rx-cat-ic">${categoryIconSvg(c.label)}</span>
              <span class="rx-cat-t"><b>${escapeHtml(c.label)}</b>${badge}<small>${b.label}</small></span>
              <span class="rx-cat-score">${c.score}%</span>
              <span class="rx-chev" aria-hidden="true"></span>
            </button>
            <div class="rx-bar thin"><i data-w="${c.score}" style="--c:${b.color}"></i></div>
            <div class="rx-cat-body">
              <h3>${escapeHtml(c.headline)}</h3>
              <p>${escapeHtml(c.message)}</p>
              ${(c.checklist || []).length ? `<div class="rx-todo"><span>What to do next</span><ul>${c.checklist.map(it => `<li><i>✓</i><span><b>${escapeHtml(it.label)}:</b> ${escapeHtml(it.text)}</span></li>`).join('')}</ul></div>` : ''}
            </div>
          </article>`; }).join('')}</div>
      </section>` : '';

    // 5. their own answers, read back with insight
    const ins = p.answerInsights || [];
    const insBlock = ins.length ? `
      <section class="rx-section">
        <p class="rx-kicker">In your own words</p>
        <h2 class="rx-h2">What your answers tell us.</h2>
        <div class="rx-quotes">${ins.map((a, i) => `
          <div class="rx-quote ${a.help ? 'help' : ''} ${i >= 3 ? 'more' : ''}">
            <p class="rx-q-q">${escapeHtml(a.question)}</p>
            <p class="rx-q-a">“${escapeHtml(a.answer)}”</p>
            <p class="rx-q-i">${escapeHtml(a.insight)}</p>
          </div>`).join('')}</div>
        ${ins.length > 3 ? `<button class="rx-more" type="button" id="rx-more">See all ${ins.length} insights</button>` : ''}
      </section>` : '';

    // 5b. typical signs for their tier, and everything they told us outside the score
    const signs = p.typicalSigns || [];
    const signsBlock = signs.length ? `
      <section class="rx-section rx-signs">
        <p class="rx-kicker">Sound familiar?</p>
        <h2 class="rx-h2">People who land at ${escapeHtml(p.tierLabel)} usually notice this.</h2>
        <ul class="rx-signs-list">${signs.map(t => `<li><i aria-hidden="true"></i><span>${escapeHtml(t)}</span></li>`).join('')}</ul>
      </section>` : '';
    const about = p.aboutYou || [];
    const helpWanted = p.helpWanted || [];
    const ABOUT_TAG = { situation: 'Where you are', goal: 'Where you want to be', obstacle: "What's in the way", help: 'How you like to be helped', note: 'In your words', other: 'You told us' };
    const toldBlock = (about.length || helpWanted.length) ? `
      <section class="rx-section rx-told">
        <p class="rx-kicker">We listened</p>
        <h2 class="rx-h2">${name ? `${name}, here's` : "Here's"} what you told us.</h2>
        ${about.length ? `<div class="rx-told-grid">${about.map(a => `
          <div class="rx-told-card k-${escapeHtml(a.key)}"><span>${escapeHtml(ABOUT_TAG[a.key] || ABOUT_TAG.other)}</span><p>“${escapeHtml(a.answer)}”</p></div>`).join('')}</div>` : ''}
        ${helpWanted.length ? `<div class="rx-told-help"><b>✋ You asked for help with</b><ul>${helpWanted.map(h => `<li>${escapeHtml(h.question)}</li>`).join('')}</ul><p>That's noted. It's where we'd start.</p></div>` : ''}
      </section>` : '';

    // 6. the next step
    // the plan ticket: their own score, a realistic target, and the areas to focus on, so the offer feels made for them
    const goalPct = Math.min(100, Math.max(p.overall + 15, p.overall >= 70 ? 95 : 80));
    const focus = [...cats].sort((a, b) => a.score - b.score).slice(0, 3);
    const ctaBlock = hasCta ? `
      <section class="rx-offer" id="rx-cta">
        <div class="rx-offer-ring" aria-hidden="true"></div>
        <div class="rx-offer-in">
          <div class="rx-offer-mesh" aria-hidden="true"></div>
          <div class="rx-offer-copy">
            <span class="rx-offer-live"><i></i>Your next step</span>
            <h2>${escapeHtml(p.ctaHeadline || `${p.greetingName}, let's turn this into results`)}</h2>
            <p class="rx-offer-text">${escapeHtml(p.recommendation)}</p>
            <ul class="rx-offer-why">
              <li>Built around <b>your</b> answers, not a generic pitch</li>
              ${helpWanted.length ? `<li>Starts with what you asked for help with</li>` : ''}
              ${p.preferredHelp ? `<li>The way you said you like to be helped: <b>${escapeHtml(p.preferredHelp)}</b></li>` : ''}
              ${cats.length > 1 ? `<li>Starts with <b>${escapeHtml(weakest.label)}</b>, your quickest win</li>` : '<li>Know exactly where to start</li>'}
              <li>Best done while your result is fresh</li>
            </ul>
            <a class="rx-offer-btn" href="${escapeHtml(p.recommendationUrl)}" target="_blank" rel="noopener"><span>${ctaLabel}</span>${arrow}</a>
            <p class="rx-offer-fine">${brandName ? `With ${escapeHtml(brandName)} · ` : ''}takes a minute to get started</p>
          </div>
          <aside class="rx-ticket" aria-label="Your plan">
            <div class="rx-ticket-top"><span>Your plan</span><em>${name ? `Prepared for ${name}` : 'Prepared for you'}</em></div>
            <div class="rx-ticket-jump">
              <div><small>Today</small><b>${p.overall}%</b></div>
              <svg viewBox="0 0 60 20" aria-hidden="true"><path d="M2 14 C 20 14, 30 4, 56 4" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 4"/><path d="M50 0 L57 4 L50 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              <div class="goal"><small>Your target</small><b>${goalPct}%+</b></div>
            </div>
            ${focus.length ? `<div class="rx-ticket-focus"><small>Focus areas</small>${focus.map((c, i) => `<div class="rx-ticket-row"><span>${i + 1}</span><b>${escapeHtml(c.label)}</b><em style="--c:${(BAND[c.band] || BAND.developing).color}">${c.score}%</em></div>`).join('')}</div>` : ''}
            <div class="rx-ticket-tear" aria-hidden="true"></div>
            <div class="rx-ticket-foot"><span>${escapeHtml(scorecard.title || 'Your scorecard')}</span><span class="rx-stamp">${escapeHtml(p.tierLabel)}</span></div>
          </aside>
        </div>
      </section>` : (p.recommendation ? `
      <section class="rx-cta soft"><p class="rx-kicker">Your next step</p><h2>${escapeHtml(p.ctaHeadline || 'Want to go deeper on your results?')}</h2><p class="rx-cta-text">${escapeHtml(p.recommendation)}</p></section>` : '');

    // 7. keep it, share it
    const keep = `
      <section class="rx-keep">
        ${result.preview
          ? `<p>This was a preview. No lead was recorded, and no email or PDF was sent.</p>`
          : `<p>${lead.email ? `Your full report is on its way to <b>${escapeHtml(lead.email)}</b>.` : 'Your result has been saved.'}</p>`}
        <div class="rx-keep-btns">
          ${result.preview ? '' : `<a class="rx-ghost" href="${result.reportUrl}" target="_blank" rel="noopener">Download your PDF report ↓</a>`}
          <a class="rx-ghost wa" href="${whatsappHref}" target="_blank" rel="noopener">${waIcon}${result.engagementMode ? 'Share your result' : 'Send to WhatsApp'}</a>
        </div>
      </section>`;

    root.innerHTML = `<div class="rx">${hero}${signsBlock}${pair}${mapBlock}${gapBlock}${catBlock}${insBlock}${toldBlock}${ctaBlock}${keep}</div>
      ${hasCta ? `<div class="rx-sticky" id="rx-sticky" aria-hidden="true"><span><b>${p.overall}%</b> ${cats.length > 1 ? `· your quickest win is ${escapeHtml(weakest.label)}` : `· ${escapeHtml(p.tierLabel)}`}</span><a class="rx-btn" href="${escapeHtml(p.recommendationUrl)}" target="_blank" rel="noopener" tabindex="-1">${ctaLabel}${arrow}</a></div>` : ''}`;
    document.body.classList.add('is-result');
    const bar = document.querySelector('.demo-progress-wrap');
    if (bar) bar.style.display = 'none';
    window.scrollTo(0, 0);

    // motion: count the score up, sweep the ring, grow bars as they come into view
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ring = root.querySelector('.rx-ring'), num = root.querySelector('[data-count]');
    const target = p.overall;
    if (reduce) { ring.style.setProperty('--p', target); num.textContent = target; }
    else {
      const t0 = performance.now(), dur = 1400;
      const tick = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); const v = Math.round(target * e); num.textContent = v; ring.style.setProperty('--p', v); if (k < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
    const grow = (el) => { el.style.width = el.dataset.w + '%'; };
    const bars = root.querySelectorAll('[data-w]');
    if (reduce || !('IntersectionObserver' in window)) bars.forEach(grow);
    else {
      const io = new IntersectionObserver((entries) => entries.forEach(en => { if (en.isIntersecting) { grow(en.target); io.unobserve(en.target); } }), { threshold: 0.3 });
      bars.forEach(b => io.observe(b));
    }

    // the score map draws itself when it scrolls into view
    const map = document.getElementById('rx-map');
    if (map) {
      if (reduce || !('IntersectionObserver' in window)) map.classList.add('in');
      else { const mo = new IntersectionObserver(([e]) => { if (e.isIntersecting) { map.classList.add('in'); mo.disconnect(); } }, { threshold: 0.25 }); mo.observe(map); }
    }

    // categories open and close
    root.querySelectorAll('.rx-cat-head').forEach(h => h.addEventListener('click', () => {
      const card = h.closest('.rx-cat'), open = !card.classList.contains('open');
      card.classList.toggle('open', open); h.setAttribute('aria-expanded', String(open));
    }));
    const more = document.getElementById('rx-more');
    if (more) more.addEventListener('click', () => { root.querySelectorAll('.rx-quote.more').forEach(q => q.classList.remove('more')); more.remove(); });

    // the slim next-step bar: shows once the hero button has scrolled away, hides at the main call to action
    const sticky = document.getElementById('rx-sticky');
    if (sticky && 'IntersectionObserver' in window) {
      const heroBtn = root.querySelector('.rx-hero-btn'), cta = document.getElementById('rx-cta');
      let pastHero = false, atCta = false;
      const update = () => { const show = pastHero && !atCta; sticky.classList.toggle('show', show); sticky.setAttribute('aria-hidden', String(!show)); sticky.querySelector('a').tabIndex = show ? 0 : -1; };
      new IntersectionObserver(([e]) => { pastHero = !e.isIntersecting && e.boundingClientRect.top < 0; update(); }).observe(heroBtn);
      new IntersectionObserver(([e]) => { atCta = e.isIntersecting; update(); }, { threshold: 0.2 }).observe(cta);
    }
  }

  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  render();
})();