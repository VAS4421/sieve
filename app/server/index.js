const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const csrfOriginCheck = require('./middleware/csrf');

const { migrate } = require('./db'); // ensures Postgres tables/columns exist

const app = express();

// Behind a reverse proxy (Railway, Render, nginx) req.ip would otherwise be the
// proxy's address for every request, making the rate limiters below useless.
// Trusts only the first hop — adjust if deploying behind more than one proxy layer.
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());
app.use(csrfOriginCheck);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/scorecards', require('./routes/scorecards'));
app.use('/api/public', require('./routes/public'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/team', require('./routes/team'));
app.use('/api/templates', require('./routes/templates'));

// The static-file serving below (all three roots) is broad by necessity — the
// marketing site's assets live loose at the repo root. That means it's
// CRITICAL nothing under app/server is ever reachable through it: that's
// every route file, db.js, and — if a local .env file happens to exist on
// this filesystem — real credentials (DATABASE_URL, JWT_SECRET, live payment
// keys). Checked before any static middleware runs, so it protects all three
// roots below regardless of their individual configuration.
app.use((req, res, next) => {
  if (req.path.startsWith('/app/server')) return res.status(404).end();
  next();
});

// Builder / dashboard app — protected in the browser by checking /api/auth/me,
// not by the static file server (a real deploy could add server-side gating too).
app.use(express.static(path.join(__dirname, '..', 'public'), { dotfiles: 'deny' }));

// Public scorecard-taking page — shared by every published scorecard,
// the slug is read from the URL query string on the client.
app.use('/take', express.static(path.join(__dirname, '..', 'take'), { dotfiles: 'deny' }));

// The original marketing site lives one level up from /app. dotfiles: 'deny'
// here is defense-in-depth on top of the explicit app/server block above —
// it also stops .git or any other stray dotfile at the repo root from ever
// being served, not just app/server specifically.
app.use(express.static(path.join(__dirname, '..', '..'), { dotfiles: 'deny' }));

// Single global error handler — every route's `catch (err) { next(err); }`
// (and anything Express itself throws, e.g. express.json()'s own parse
// errors) ends up here. Keeps the existing console.error behavior AND
// persists a row to admin_error_log — see errorLog.js — so "a user says
// they couldn't submit" can be checked against a real record. Awaited (errors
// are not a hot path — a few extra milliseconds here is a fair trade for the
// row reliably existing by the time the error response reaches the client),
// but logError never throws itself, so this can't turn one error into two.
// Must come after every other app.use() call above — an Express error
// handler is only wired up correctly in that position.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || err.statusCode || 500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 5500;
if (require.main === module) {
  migrate()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Sieve server running at http://localhost:${PORT}`);
        console.log(`  Marketing site:      http://localhost:${PORT}/index.html`);
        console.log(`  Sign up / dashboard: http://localhost:${PORT}/signup.html`);
        const { startNudgeJob } = require('./nudge');
        startNudgeJob();
      });
    })
    .catch((err) => {
      console.error('[startup] Failed to migrate the database:', err);
      process.exit(1);
    });
}

// The test suite imports `app` directly (via supertest-style request()) and
// needs the schema to exist before making requests — it awaits this itself.
module.exports = app;
module.exports.migrate = migrate;
