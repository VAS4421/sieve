// Public, unauthenticated reads for templates.html and the "Use this
// template" flow (app.js's createScorecardFromTemplate). Read-only —
// creating/editing/deleting a template is admin-only, see routes/admin.js.
const express = require('express');
const { get, all } = require('../db');
const { TEMPLATES, BY_SLUG } = require('../template-library');
const { CATEGORY_LABELS } = require('../template-library/sectors');

// The code library (template-library/) wins over a DB row with the same slug,
// so templates are upgraded and added by deploy, never by editing the database.
const card = (t) => ({ slug: t.slug, title: t.title, description: t.description, filterCategory: t.filterCategory, coverImage: t.coverImage });

const router = express.Router();

// The grid on templates.html — one lightweight row per published template,
// enough to render a card and filter by category. Never includes
// categories/questions/tiers (the "use this template" flow fetches the full
// row separately, only once someone actually clicks a card).
router.get('/', async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT slug, title, description, filter_category, cover_image
       FROM templates WHERE published = 1 ORDER BY sort_order ASC, title ASC`
    );
    const fromDb = rows.filter(r => !BY_SLUG.has(r.slug)).map(r => ({
      slug: r.slug, title: r.title, description: r.description, filterCategory: r.filter_category, coverImage: r.cover_image,
    }));
    const lib = [...TEMPLATES].sort((a, b) => a.sortOrder - b.sortOrder).map(card);
    res.json({ templates: [...lib, ...fromDb], categoryLabels: CATEGORY_LABELS });
  } catch (err) {
    next(err);
  }
});

// The full content behind one card, fetched only when someone clicks "Use
// this template" — this is what used to be a lookup into the static
// window.SIEVE_TEMPLATES global.
router.get('/:slug', async (req, res, next) => {
  try {
    const t = BY_SLUG.get(req.params.slug);
    if (t) {
      return res.json({ template: { slug: t.slug, title: t.title, coverImage: t.coverImage, intro: t.intro, categories: t.categories, questions: t.questions, tiers: t.tiers, ctaLabel: t.ctaLabel } });
    }
    const row = await get(
      `SELECT slug, title, cover_image, intro, categories, questions, tiers, cta_label
       FROM templates WHERE slug = ? AND published = 1`,
      [req.params.slug]
    );
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    res.json({
      template: {
        slug: row.slug,
        title: row.title,
        coverImage: row.cover_image,
        intro: row.intro,
        categories: JSON.parse(row.categories),
        questions: JSON.parse(row.questions),
        tiers: JSON.parse(row.tiers),
        ctaLabel: row.cta_label,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;