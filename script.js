// Sieve — shared site interactivity

document.addEventListener('DOMContentLoaded', () => {
  // Mobile nav toggle
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.toggle('force-show');
      navLinks.style.display = navLinks.classList.contains('force-show') ? 'flex' : '';
      if (navLinks.classList.contains('force-show')) {
        navLinks.style.position = 'absolute';
        navLinks.style.top = '64px';
        navLinks.style.left = '0';
        navLinks.style.right = '0';
        navLinks.style.background = '#FFFFFF';
        navLinks.style.flexDirection = 'column';
        navLinks.style.padding = '20px 28px';
        navLinks.style.borderBottom = '1px solid #E1E7F2';
        navLinks.style.gap = '18px';
      }
    });
  }

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      item.parentElement.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // Pricing monthly/yearly toggle
  const toggle = document.querySelector('.toggle-pill');
  if (toggle) {
    toggle.addEventListener('click', () => {
      toggle.classList.toggle('is-yearly');
      const yearly = toggle.classList.contains('is-yearly');
      document.querySelectorAll('[data-monthly]').forEach(el => {
        el.textContent = yearly ? el.dataset.yearly : el.dataset.monthly;
      });
      document.querySelectorAll('.period-label').forEach(el => {
        el.textContent = yearly ? 'billed yearly' : 'billed monthly';
      });
    });
  }

  // Use case tabs
  const ucTabs = document.querySelectorAll('.uc-tab');
  ucTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      ucTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.uc-panel').forEach(p => p.classList.remove('active'));
      const target = document.getElementById(tab.dataset.target);
      if (target) target.classList.add('active');
    });
  });

  // Pricing pay-mode tabs (Credits / Pay-per-lead / Subscription)
  const payTabs = document.querySelectorAll('.pay-tab');
  payTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      payTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.pay-panel').forEach(p => p.classList.remove('active'));
      const target = document.getElementById(tab.dataset.target);
      if (target) target.classList.add('active');
    });
  });

  // Template filters
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const filter = pill.dataset.filter;
      document.querySelectorAll('.tpl-card').forEach(card => {
        card.style.display = (filter === 'all' || card.dataset.category === filter) ? '' : 'none';
      });
    });
  });
});

/* ================================================================
   DEMO SCORECARD ENGINE
   Mirrors the real ScoreApp mechanism: gated lead capture ->
   single-question flow with live progress -> weighted scoring ->
   personalized results page with category breakdown.
   ================================================================ */

const SCORECARD = {
  title: "The Lead-Readiness Score",
  intro: "Answer 9 quick questions about how your business currently generates and qualifies leads, and get an instant, personalized readiness score.",
  questions: [
    {
      id: 'source',
      text: "Where do most of your new leads come from today?",
      type: 'choice',
      options: [
        { label: 'WhatsApp / Instagram DMs', score: { speed: 1, process: 0, data: 0 } },
        { label: 'Referrals and word of mouth', score: { speed: 2, process: 1, data: 0 } },
        { label: 'A website contact form', score: { speed: 2, process: 2, data: 1 } },
        { label: 'Paid ads (Meta, Google)', score: { speed: 2, process: 2, data: 2 } },
      ],
    },
    {
      id: 'response_time',
      text: "How quickly does someone on your team usually respond to a new lead?",
      type: 'choice',
      options: [
        { label: 'Within minutes', score: { speed: 3, process: 2, data: 1 } },
        { label: 'Within a few hours', score: { speed: 2, process: 2, data: 1 } },
        { label: 'By the next day', score: { speed: 1, process: 1, data: 1 } },
        { label: 'It varies a lot', score: { speed: 0, process: 0, data: 0 } },
      ],
    },
    {
      id: 'qualify_before_call',
      text: "Do you know anything about a lead's budget or intent before you call or message them back?",
      type: 'yesno',
      options: [
        { label: 'Yes, usually', score: { process: 3, data: 2 } },
        { label: 'No, we find out on the call', score: { process: 0, data: 0 } },
      ],
    },
    {
      id: 'time_wasted',
      text: "In a typical week, how much time does your team spend on leads that were never a real fit?",
      type: 'choice',
      options: [
        { label: 'Barely any', score: { process: 3 } },
        { label: 'A few hours', score: { process: 2 } },
        { label: 'Most of a working day', score: { process: 1 } },
        { label: "I honestly don't know", score: { process: 0 } },
      ],
    },
    {
      id: 'record_keeping',
      text: "Where do your lead details end up after first contact?",
      type: 'choice',
      options: [
        { label: 'A proper CRM or spreadsheet', score: { data: 3, process: 1 } },
        { label: 'Saved contacts / chat history only', score: { data: 1 } },
        { label: 'Wherever the salesperson kept it', score: { data: 0 } },
      ],
    },
    {
      id: 'followup',
      text: "If a lead goes quiet, do they get a structured follow-up, or does it depend on someone remembering?",
      type: 'yesno',
      options: [
        { label: 'Structured follow-up', score: { process: 3, data: 1 } },
        { label: 'Depends on memory', score: { process: 0 } },
      ],
    },
    {
      id: 'payment_method',
      text: "How do most of your customers prefer to pay once they're ready to buy?",
      type: 'choice',
      options: [
        { label: 'Bank transfer', score: { speed: 1 } },
        { label: 'Card via Paystack', score: { speed: 2 } },
        { label: 'POS / cash on delivery', score: { speed: 1 } },
        { label: 'Mix of all the above', score: { speed: 2 } },
      ],
    },
    {
      id: 'team_size',
      text: "How many people on your team currently handle inbound leads?",
      type: 'choice',
      options: [
        { label: "Just me", score: { process: 1 } },
        { label: '2-5 people', score: { process: 2 } },
        { label: 'A dedicated sales team', score: { process: 3 } },
      ],
    },
    {
      id: 'goal',
      text: "What would help your business most right now?",
      type: 'choice',
      options: [
        { label: 'More leads', score: { speed: 1 } },
        { label: 'Better-quality leads', score: { process: 1, data: 1 } },
        { label: 'Faster follow-up', score: { speed: 1, process: 1 } },
        { label: 'Clearer data on who converts', score: { data: 2 } },
      ],
    },
  ],
};

(function initDemo() {
  const root = document.getElementById('demo-root');
  if (!root) return;

  let step = -1; // -1 = gate
  const answers = [];
  const maxPerCategory = { speed: 8, process: 15, data: 9 };

  function render() {
    if (step === -1) return renderGate();
    if (step >= SCORECARD.questions.length) return renderResult();
    renderQuestion();
  }

  function renderGate() {
    root.innerHTML = `
      <div class="demo-body">
        <div class="demo-q" style="margin-bottom:10px;">${SCORECARD.title}</div>
        <p style="text-align:center;color:var(--ink-soft);font-size:14.5px;margin-bottom:26px;">${SCORECARD.intro}</p>
        <div class="demo-gate">
          <div class="demo-gate-row">
            <input type="text" id="g-first" placeholder="First name" />
            <input type="text" id="g-last" placeholder="Last name" />
          </div>
          <input type="text" id="g-business" placeholder="Business name" />
          <input type="email" id="g-email" placeholder="Work email" />
          <button class="btn btn-accent btn-block" id="g-start">Start my score →</button>
          <p style="text-align:center;font-size:12px;color:var(--ink-faint);">Your personalised score is generated instantly. No spam — this is a live demo, nothing is stored or sent anywhere.</p>
        </div>
      </div>
    `;
    document.getElementById('g-start').addEventListener('click', () => {
      step = 0;
      renderProgress();
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
    const pct = step < 0 ? 0 : Math.round((step / SCORECARD.questions.length) * 100);
    bar.querySelector('.demo-progress-fill').style.width = pct + '%';
    bar.querySelector('.demo-progress-label').textContent = pct + '% complete';
    bar.style.display = step >= SCORECARD.questions.length ? 'none' : 'flex';
  }

  function renderQuestion() {
    const q = SCORECARD.questions[step];
    renderProgress();
    const rowClass = q.type === 'yesno' ? 'row' : '';
    root.innerHTML = `
      <div class="demo-body">
        ${step > 0 ? `<div class="demo-back" id="d-back">← Back</div>` : ''}
        <div class="demo-q">${q.text}</div>
        <div class="demo-answers ${rowClass}">
          ${q.options.map((opt, i) => `<button class="demo-opt" data-i="${i}">${opt.label}</button>`).join('')}
        </div>
      </div>
    `;
    if (step > 0) {
      document.getElementById('d-back').addEventListener('click', () => {
        step -= 1;
        answers.pop();
        render();
      });
    }
    root.querySelectorAll('.demo-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const opt = q.options[parseInt(btn.dataset.i, 10)];
        answers[step] = opt;
        step += 1;
        render();
      });
    });
  }

  function renderResult() {
    renderProgress();
    const totals = { speed: 0, process: 0, data: 0 };
    answers.forEach(a => {
      Object.entries(a.score || {}).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + v; });
    });
    const pct = {
      speed: Math.min(100, Math.round((totals.speed / maxPerCategory.speed) * 100)),
      process: Math.min(100, Math.round((totals.process / maxPerCategory.process) * 100)),
      data: Math.min(100, Math.round((totals.data / maxPerCategory.data) * 100)),
    };
    const overall = Math.round((pct.speed + pct.process + pct.data) / 3);
    let tier = 'Building the basics';
    if (overall >= 75) tier = 'Sales-ready';
    else if (overall >= 50) tier = 'Getting there';

    root.innerHTML = `
      <div class="demo-body demo-result">
        <div class="result-tier">${tier}</div>
        <div class="score-ring" style="--pct:${overall}">
          <div class="score-ring-inner">
            <div class="score-ring-num">${overall}%</div>
            <div class="score-ring-label">OVERALL SCORE</div>
          </div>
        </div>
        <div class="result-cats">
          <div class="result-cat-row"><div class="result-cat-name">Response speed</div><div class="result-cat-bar"><div class="result-cat-fill" style="width:${pct.speed}%"></div></div><div class="result-cat-pct">${pct.speed}%</div></div>
          <div class="result-cat-row"><div class="result-cat-name">Qualification process</div><div class="result-cat-bar"><div class="result-cat-fill" style="width:${pct.process}%"></div></div><div class="result-cat-pct">${pct.process}%</div></div>
          <div class="result-cat-row"><div class="result-cat-name">Lead data & tracking</div><div class="result-cat-bar"><div class="result-cat-fill" style="width:${pct.data}%"></div></div><div class="result-cat-pct">${pct.data}%</div></div>
        </div>
        <p style="color:var(--ink-soft);font-size:14.5px;margin-bottom:24px;">This is exactly the kind of personalised result page every Sieve scorecard generates automatically for your own leads — built once, then run for every visitor.</p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary" id="d-restart">Try it again</button>
          <a class="btn btn-ghost" href="pricing.html">See pricing →</a>
        </div>
      </div>
    `;
    document.getElementById('d-restart').addEventListener('click', () => {
      step = -1;
      answers.length = 0;
      render();
    });
  }

  render();
})();
