// Postgres database layer (replaces the earlier node:sqlite version). Every
// route still calls the same run()/get()/all() shapes — the only real change
// a caller needs to make is `await` in front of each call, because a real
// network database is inherently asynchronous (SQLite's DatabaseSync was not).
//
// Callers still write `?` placeholders exactly as before (SQLite style) —
// toPgPlaceholders() below rewrites them to Postgres's $1/$2/... style, so no
// route file needs its SQL strings rewritten, only its call sites awaited.
//
// Column types deliberately mirror the old SQLite schema as closely as
// possible (JSON blobs stay TEXT, booleans stay INTEGER 0/1) rather than
// adopting native JSONB/BOOLEAN — that's a real, separate improvement for
// later, once route code is ready to stop JSON.stringify/parse-ing those
// columns itself. Doing both at once would make this change much riskier to
// verify. See MIGRATION_NOTES.md.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Add it to app/server/.env — see .env.example. ' +
    'Local dev: run a Postgres instance (Docker: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`) ' +
    'and set DATABASE_URL=postgres://postgres:postgres@localhost:5432/sieve — or point it at a free managed instance ' +
    '(Neon, Railway, Supabase) for zero local setup.'
  );
}

// Managed Postgres providers (Neon, Railway, Supabase, Render) require SSL and
// hand out a certificate that Node's default trust store doesn't chain to
// cleanly. rejectUnauthorized:false is the standard pragmatic setting for
// these providers' pooled connection strings — the connection is still
// encrypted, this only skips CA-chain verification. Set PGSSL=disable for a
// local, non-SSL Postgres instance (e.g. the Docker command above).
const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Fires for errors on idle clients in the pool (e.g. the server restarting
  // underneath us) — log, don't crash the whole process over one bad connection.
  console.error('[db] Unexpected error on idle Postgres client:', err);
});

function toPgPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

async function run(sql, params = []) {
  const result = await pool.query(toPgPlaceholders(sql), params);
  return { changes: result.rowCount, rows: result.rows };
}

async function get(sql, params = []) {
  const result = await pool.query(toPgPlaceholders(sql), params);
  return result.rows[0];
}

async function all(sql, params = []) {
  const result = await pool.query(toPgPlaceholders(sql), params);
  return result.rows;
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      billing_mode TEXT NOT NULL DEFAULT 'subscription',
      credit_balance INTEGER NOT NULL DEFAULT 0,
      cpl_rate_kobo INTEGER,
      paystack_authorization_code TEXT,
      paystack_customer_code TEXT,
      credit_exhausted_notified_at TIMESTAMPTZ,
      has_ever_paid BOOLEAN NOT NULL DEFAULT false,
      cpl_charge_failing BOOLEAN NOT NULL DEFAULT false,
      -- Set on a successful subscription payment (now() + 30 days) — there's
      -- no recurring charge behind this, so it's how a lapsed subscription is
      -- detected: once this is in the past, the account is treated the same
      -- as any other exhausted billing mode. NULL for an account that has
      -- never paid for a subscription plan.
      plan_expires_at TIMESTAMPTZ,
      -- Internal/operator accounts (VASNET's own) — never gated by billing,
      -- and the only accounts that can reach /api/admin/* and admin.html.
      -- Set by hand (there's no signup path to this); see requireAdmin.js.
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL DEFAULT (now()::text),
      -- Monthly response tracking for subscription plans — reset every 30 days.
      monthly_responses_used INTEGER NOT NULL DEFAULT 0,
      monthly_reset_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS scorecards (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled scorecard',
      intro TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '[]',
      questions TEXT NOT NULL DEFAULT '[]',
      tiers TEXT NOT NULL DEFAULT '[{"min":75,"label":"Sales-ready"},{"min":50,"label":"Getting there"},{"min":0,"label":"Building the basics"}]',
      brand_name TEXT,
      -- A photo/graphic shown behind the intro screen and the name/phone/email
      -- gate on the public taking page (a URL — either pasted by the owner or a
      -- template's own default). Never required — the take flow works with none.
      cover_image TEXT,
      -- JSON: {enabled, captureAge, captureGender, captureLocation, captureSocialClass,
      -- interestQuestion, interestOptions:[]} — powers the Brand Campaign Insight Report.
      profile_capture TEXT NOT NULL DEFAULT '{"enabled":false}',
      -- Mobile Engagement Agency mode: shows completion time + a share prompt on the
      -- results page, and surfaces engagement stats in the report.
      engagement_mode INTEGER NOT NULL DEFAULT 0,
      share_template TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (now()::text),
      updated_at TEXT NOT NULL DEFAULT (now()::text)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      scorecard_id TEXT NOT NULL REFERENCES scorecards(id),
      first_name TEXT,
      last_name TEXT,
      business_name TEXT,
      phone TEXT,
      email TEXT,
      answers TEXT NOT NULL,
      category_scores TEXT NOT NULL,
      overall_score INTEGER NOT NULL,
      tier TEXT NOT NULL,
      personalization TEXT,
      -- JSON: {ageRange, gender, location, socialClass, interest} — only the fields the
      -- scorecard's profile_capture config actually asked for are ever present.
      profile TEXT,
      time_to_complete_seconds INTEGER,
      created_at TEXT NOT NULL DEFAULT (now()::text)
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (now()::text)
    );

    -- A team member is an additional login under the same account (account_id
    -- points at the owning row in users). Chosen model: every member sees
    -- everything the account owns — no per-scorecard ownership split.
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES users(id),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      invite_token_hash TEXT,
      invite_expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (now()::text)
    );

    -- One row per person who starts a scorecard (clicks past the gate), regardless
    -- of whether they finish. Lets the aggregate report show a real completion
    -- rate, not just a count of finished leads.
    CREATE TABLE IF NOT EXISTS scorecard_starts (
      id TEXT PRIMARY KEY,
      scorecard_id TEXT NOT NULL REFERENCES scorecards(id),
      created_at TEXT NOT NULL DEFAULT (now()::text)
    );

    -- Tracks visitors who entered their contact info but did not complete the
    -- scorecard — used by the abandoned-quiz email nudge job (nudge.js).
    -- Only created for Business/Pro/Enterprise accounts (the endpoint checks).
    CREATE TABLE IF NOT EXISTS scorecard_nudge_starts (
      id TEXT PRIMARY KEY,
      scorecard_id TEXT NOT NULL REFERENCES scorecards(id),
      scorecard_slug TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      phone TEXT,
      completed_at TIMESTAMPTZ,
      nudge_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_nudge_starts_scorecard ON scorecard_nudge_starts(scorecard_id);
    CREATE INDEX IF NOT EXISTS idx_nudge_starts_pending ON scorecard_nudge_starts(nudge_sent_at, completed_at);

    -- One row per successful credit-bundle purchase (prepaid response-credit model).
    CREATE TABLE IF NOT EXISTS credit_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      amount_kobo INTEGER NOT NULL,
      credits_added INTEGER NOT NULL,
      paystack_reference TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (now()::text)
    );

    -- One row per pay-per-qualified-lead charge attempt (success or failure), fired
    -- in real time right after a CPL-mode scorecard submission.
    CREATE TABLE IF NOT EXISTS cpl_charges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      lead_id TEXT NOT NULL REFERENCES leads(id),
      amount_kobo INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      paystack_reference TEXT,
      created_at TEXT NOT NULL DEFAULT (now()::text)
    );

    -- Admin-managed content behind /templates.html and "Use this template" —
    -- replaces the old static scorecard-templates.js. Structurally the same
    -- shape as a scorecard's own editable fields (categories/questions/tiers
    -- are the identical JSON shape scorecards.js already reads/writes), plus
    -- the marketing metadata (description, filter_category, cta_label) that
    -- used to live only in templates.html's hand-written cards.
    -- uploaded pictures (covers, logos): stored here so a redeploy can't wipe them; see uploads.js
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      size INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      filter_category TEXT NOT NULL DEFAULT '',
      cover_image TEXT,
      intro TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '[]',
      questions TEXT NOT NULL DEFAULT '[]',
      tiers TEXT NOT NULL DEFAULT '[]',
      -- Applied as the top tier's recommendation text by
      -- createScorecardFromTemplate() client-side — see app.js. Deliberately
      -- no URL: no template can invent a real booking link, the owner adds
      -- that themselves once they're in the builder.
      cta_label TEXT,
      published INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (now()::text),
      updated_at TEXT NOT NULL DEFAULT (now()::text)
    );


    CREATE INDEX IF NOT EXISTS idx_scorecards_user ON scorecards(user_id);
    CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(filter_category);
    CREATE INDEX IF NOT EXISTS idx_templates_published ON templates(published);
    CREATE INDEX IF NOT EXISTS idx_starts_scorecard ON scorecard_starts(scorecard_id);
    CREATE INDEX IF NOT EXISTS idx_leads_scorecard ON leads(scorecard_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_account ON team_members(account_id);
    CREATE INDEX IF NOT EXISTS idx_credit_purchases_user ON credit_purchases(user_id);
    CREATE INDEX IF NOT EXISTS idx_cpl_charges_user ON cpl_charges(user_id);
  `);
  // Defensive column backfill, same intent as the old SQLite version: if this
  // ever runs against a database created before the billing-mode work, add
  // whatever's missing. Harmless no-op on a fresh database.
  const { rows: existingCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'users'
  `);
  const userColumns = new Set(existingCols.map((c) => c.column_name));
  const newUserColumns = [
    ["billing_mode", "TEXT NOT NULL DEFAULT 'subscription'"],
    ['credit_balance', 'INTEGER NOT NULL DEFAULT 0'],
    ['cpl_rate_kobo', 'INTEGER'],
    ['paystack_authorization_code', 'TEXT'],
    ['paystack_customer_code', 'TEXT'],
    ['credit_exhausted_notified_at', 'TIMESTAMPTZ'],
    ['has_ever_paid', 'BOOLEAN NOT NULL DEFAULT false'],
    ['cpl_charge_failing', 'BOOLEAN NOT NULL DEFAULT false'],
    ['plan_expires_at', 'TIMESTAMPTZ'],
    ['is_admin', 'BOOLEAN NOT NULL DEFAULT false'],
    ['monthly_responses_used', 'INTEGER NOT NULL DEFAULT 0'],
    ['monthly_reset_at', 'TIMESTAMPTZ'],
    ['session_version', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, def] of newUserColumns) {
    if (!userColumns.has(name)) {
      await pool.query(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
    }
  }
  const { rows: existingLeadCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'
  `);
  const leadColumns = new Set(existingLeadCols.map((c) => c.column_name));
  if (!leadColumns.has('phone')) {
    await pool.query(`ALTER TABLE leads ADD COLUMN phone TEXT`);
  }
  const { rows: existingScorecardCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'scorecards'
  `);
  const scorecardColumns = new Set(existingScorecardCols.map((c) => c.column_name));
  if (!scorecardColumns.has('cover_image')) {
    await pool.query(`ALTER TABLE scorecards ADD COLUMN cover_image TEXT`);
  }
  // Pricing change (Nov 2026): pay-per-lead moved from N200 to N389 per lead, for existing card-saved accounts too.
  // Only rows still on the old N200 rate change, so this is safe to run on every start.
  const moved = await pool.query('UPDATE users SET cpl_rate_kobo = 38900 WHERE cpl_rate_kobo = 20000');
  if (moved.rowCount) console.log(`[migrate] moved ${moved.rowCount} pay-per-lead account(s) from N200 to N389 per lead`);
  // team members' sessions can be ended too (see requireAuth.js)
  await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0`);
}

async function close() {
  await pool.end();
}

module.exports = { pool, run, get, all, migrate, close };
