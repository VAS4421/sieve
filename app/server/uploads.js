// Uploaded pictures (scorecard covers and brand logos) live in the database, not on the server's disk, so a redeploy
// can't wipe them. The builder shrinks and compresses each picture before upload; the server allows 3 MB at most,
// checks the bytes really are an image, serves it with long browser caching, and sweeps away pictures no scorecard uses.
const crypto = require('node:crypto');
const { run, get } = require('./db');

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const TYPES = { 'image/jpeg': { ext: '.jpg', magic: ['ffd8ff'] }, 'image/png': { ext: '.png', magic: ['89504e47'] }, 'image/webp': { ext: '.webp', magic: ['52494646'] }, 'image/gif': { ext: '.gif', magic: ['47494638'] } };

// the first bytes must match the claimed type (a script renamed .png is refused)
function imageBufferOk(buf, mime) {
  const t = TYPES[mime];
  if (!t || !buf || buf.length < 12) return false;
  const hex = buf.subarray(0, 12).toString('hex');
  if (mime === 'image/webp' && buf.subarray(8, 12).toString() !== 'WEBP') return false;
  return t.magic.some((m) => hex.startsWith(m));
}

async function saveUpload(userId, mime, buf) {
  const id = crypto.randomUUID();
  await run('INSERT INTO uploads (id, user_id, mime, data, size) VALUES (?, ?, ?, ?, ?)', [id, userId, mime, buf, buf.length]);
  return `/uploads/${id}${TYPES[mime].ext}`;
}

// GET /uploads/<id>.<ext>: from the database; anything else falls through to the old files on disk (if any survive)
async function serveUpload(req, res, next) {
  const m = String(req.params.file || '').match(/^([0-9a-f-]{36})\.(jpg|png|webp|gif)$/);
  if (!m) return next();
  try {
    const row = await get('SELECT mime, data FROM uploads WHERE id = ?', [m[1]]);
    if (!row) return next();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');   // fetched once, then kept by browsers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(row.data);
  } catch (err) { next(err); }
}

// pictures uploaded more than a day ago that no scorecard uses (replaced covers, deleted scorecards, abandoned uploads)
async function sweepUnusedUploads() {
  const r = await run(`DELETE FROM uploads u WHERE u.created_at < now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM scorecards s WHERE COALESCE(s.cover_image, '') LIKE '%' || u.id || '%' OR COALESCE(s.profile_capture, '') LIKE '%' || u.id || '%')`);
  return (r && r.changes) || 0;
}
function startUploadSweep() {
  const tick = () => sweepUnusedUploads().then((n) => { if (n) console.log(`[uploads] removed ${n} unused picture(s)`); }).catch((e) => console.error('[uploads] sweep failed:', e.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 6 * 60 * 60 * 1000).unref();
}

module.exports = { MAX_UPLOAD_BYTES, TYPES, imageBufferOk, saveUpload, serveUpload, sweepUnusedUploads, startUploadSweep };
