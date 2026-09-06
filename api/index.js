// Vercel Node.js serverless entrypoint.
// We deliberately avoid requiring the app at module load time.
// If anything in startup is broken (env/db/deps), we surface it as JSON
// instead of a generic "FUNCTION_INVOCATION_FAILED", which makes debugging possible.

let started = false;
let startupError = null;

async function ensureStartup() {
  if (started) return true;
  if (startupError) return false;

  try {
    // Load config (LIFEOS_SETTINGS) and database, create schema, then load app.
    require('../src/config');
    const db = require('../src/db');
    await db.initSchema();
    const { app } = require('../src/app');
    if (typeof app !== 'function') throw new Error('Express app is not a function');
    ensureStartup.app = app;
    started = true;
    return true;
  } catch (e) {
    startupError = e;
    // Always log so Vercel runtime logs contain the real stack.
    console.error('[lifeos] startup failed:', e && e.stack ? e.stack : e);
    return false;
  }
}

async function handler(req, res) {
  const ok = await ensureStartup();
  if (!ok) {
    const e = startupError || new Error('Unknown startup error');
    res.status(500).json({
      error: 'startup_error',
      message: String(e.message || e),
      stack: String(e.stack || '').slice(0, 2000),
    });
    return;
  }
  try {
    ensureStartup.app(req, res);
  } catch (e) {
    console.error('[lifeos] request error:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'request_error', message: String(e.message || e) });
    }
  }
}

module.exports = handler;
