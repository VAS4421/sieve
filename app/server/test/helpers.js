// Test bootstrapping — Postgres version.
//
// SQLite's version of this file pointed DB_PATH at a throwaway file per test
// run. A real Postgres instance doesn't have an equivalent "just make me a
// new file" trick, so instead every test run gets its own throwaway SCHEMA
// inside the same database (Postgres's namespace mechanism — think of it as
// a folder inside the database). The app's own connection pool is pointed at
// that schema via the `options=-c search_path=...` connection parameter, so
// every table the app creates and every query it runs during the test run
// lands there — completely isolated from real data and from any other test
// run happening at the same time (useful once this runs in CI, where two
// runs could overlap).
//
// Needs a real reachable Postgres instance — set TEST_DATABASE_URL (falls
// back to DATABASE_URL) before running `npm test`. A local Docker instance
// is the easiest: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`
// then TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres

const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');

// index.js loads .env too, but only once it's required further down this
// file — too late for the check just below. Load it here first.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!baseUrl) {
  throw new Error(
    'Set TEST_DATABASE_URL (or DATABASE_URL) to a reachable Postgres instance before running tests. ' +
    'See the comment at the top of test/helpers.js.'
  );
}

// Schema names can't contain hyphens unquoted — sanitize the uuid.
const schemaName = `test_${crypto.randomUUID().replace(/-/g, '')}`;

async function createTestSchema() {
  const client = new Client({ connectionString: baseUrl, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await client.end();
}

async function dropTestSchema() {
  const client = new Client({ connectionString: baseUrl, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await client.end();
}

// Point the app's own pool (created when '../index' is required below) at
// the throwaway schema, before that require happens.
const scopedUrl = new URL(baseUrl);
scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
process.env.DATABASE_URL = scopedUrl.toString();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-production';
process.env.RESEND_API_KEY = ''; // force mailer into "skip + log" mode during tests

const app = require('../index');
const db = require('../db');

async function startServer() {
  await createTestSchema();
  await db.migrate(); // creates this run's tables inside the throwaway schema
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function cleanupDb() {
  await db.close(); // release the app's pooled connections first
  await dropTestSchema();
}

// A tiny fetch wrapper that remembers cookies between calls, like a browser tab.
function makeClient(baseUrl) {
  let cookie = '';
  async function request(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      // acts like a browser page on Sieve itself: browsers always say where a request came from (see middleware/csrf.js)
      headers: { 'Content-Type': 'application/json', Origin: baseUrl, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    // For binary responses (PNG/PDF) — the wrapped get() above always calls
    // res.json(), which throws on a non-JSON body. Sends the same session
    // cookie, but returns the raw Response so a test can read status,
    // headers, and an arrayBuffer/blob body itself.
    rawGet: (path) => fetch(baseUrl + path, { headers: cookie ? { Cookie: cookie } : {} }),
  };
}

module.exports = { startServer, cleanupDb, makeClient };
