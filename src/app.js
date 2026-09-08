require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const db = require('./db');
const ai = require('./ai');
const mail = require('./mail');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase();
const WALLET = process.env.TRUST_WALLET_ADDRESS || 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const PRICE_PRO = parseFloat(process.env.PRICE_PRO || 9.99);
const PRICE_LIFE = parseFloat(process.env.PRICE_LIFE || 19.99);
const COUPON_CODE = (process.env.LAUNCH_COUPON || 'LIFE20').toUpperCase();
const COUPON_PERCENT = parseFloat(process.env.LAUNCH_COUPON_PERCENT || '50');

const TRONSCAN_BASE = 'https://apilist.tronscanapi.com';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(u) {
  const isOwner = u.email.toLowerCase() === OWNER_EMAIL;
  let life_profile = null;
  try { life_profile = u.life_profile ? JSON.parse(u.life_profile) : null; } catch (e) {}
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    locale: u.locale,
    plan: u.plan,
    plan_until: u.plan_until,
    is_owner: isOwner,
    life_mode: (u.life_mode || 'general'),
    life_profile,
    challenge_start: u.challenge_start,
    challenge_day: u.challenge_day || 0,
    challenge_streak: u.challenge_streak || 0,
    challenge_points: u.challenge_points || 0,
    challenge_completed: !!(u.challenge_completed),
  };
}

function planPrice(plan) {
  if (plan === 'pro') return PRICE_PRO;
  if (plan === 'life') return PRICE_LIFE;
  return 0;
}

function applyCoupon(amount, coupon) {
  const code = String(coupon || '').trim().toUpperCase();
  if (code === COUPON_CODE) {
    return {
      amount: Math.round(amount * (100 - COUPON_PERCENT) / 100 * 100) / 100,
      discount_percent: COUPON_PERCENT,
      coupon: code,
    };
  }
  return { amount, discount_percent: 0, coupon: code || null };
}

async function notifyOwner(title, body, link) {
  const owner = await db.get('SELECT id FROM users WHERE email = ?', [OWNER_EMAIL]);
  if (owner) {
    await db.run('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)', [owner.id, title, body, link || '']);
  }
}

async function isOwnerEmail(email) {
  return (email || '').toLowerCase() === OWNER_EMAIL;
}

// Radical fix: email verification is OPTIONAL. Accounts are usable from the
// moment they are created. We auto-verify any existing row that still has the
// old verification flag set, so nobody is ever blocked by mail again.
async function autoVerifyUser(user) {
  if (user && !user.email_verified) {
    await db.run('UPDATE users SET email_verified = 1, verify_code = NULL, verify_expires = NULL, verify_attempts = 0 WHERE id = ?', [user.id]);
    user.email_verified = 1;
    user.verify_code = null;
    user.verify_expires = null;
  }
  return user;
}

async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    // Email verification is no longer required; auto-verify legacy users so
    // nobody is blocked by email delivery issues.
    await autoVerifyUser(user);
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

async function ownerAuth(req, res, next) {
  await auth(req, res, () => {
    if (req.user.email.toLowerCase() !== OWNER_EMAIL) return res.status(403).json({ error: 'forbidden' });
    next();
  });
}

// ===== AI status (diagnostic) =====
app.get('/api/ai/status', async (req, res) => {
  let reachable = false;
  let detail = 'AI provider was not reachable from this environment.';
  let models = [];
  let chosen = ai.AI_MODEL;
  if (ai.AI_ENABLED) {
    try {
      const base = ai.AI_BASE_URL;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${process.env.AI_API_KEY}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      reachable = r.ok;
      detail = reachable ? 'AI provider reachable.' : `Provider responded HTTP ${r.status}.`;
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        models = (data.data || []).map(m => m.id);
        chosen = ai.pickWorkingModel(models);
      }
    } catch (e) {
      detail = `Reachability check failed: ${e.message}`;
    }
  }
  res.json({ enabled: ai.AI_ENABLED, reachable, detail, base_url: ai.AI_BASE_URL, model: chosen, available_models: models.slice(0, 30), last_error: ai.getLastError ? ai.getLastError() : null });
});

// ===== real AI live test (GET or POST so it can be opened in a browser) =====
app.all('/api/ai/test', async (req, res) => {
  const message = (req.body && req.body.message || req.query.message || 'What is the quickest way to organize my morning? Reply in one short paragraph.').toString();
  const t0 = Date.now();
  try {
    const reply = await ai.chat({ user: { name: 'Test', plan: 'free', locale: 'en', email: 'test@example.com' }, message, history: [], locale: 'en' });
    const models = await ai.listModels().catch(() => []);
    const chosen = ai.pickWorkingModel(models || []);
    res.json({ ok: true, elapsed_ms: Date.now() - t0, enabled: ai.AI_ENABLED, model: chosen, reply, last_error: ai.getLastError ? ai.getLastError() : null });
  } catch (e) {
    const models = await ai.listModels().catch(() => []);
    const chosen = ai.pickWorkingModel(models || []);
    res.status(500).json({ ok: false, elapsed_ms: Date.now() - t0, enabled: ai.AI_ENABLED, model: chosen, error: e.message, last_error: ai.getLastError ? ai.getLastError() : null });
  }
});

// ===== health =====
app.get('/api/health', (req, res) => res.json({
  ok: true,
  db: db.IS_PG ? 'postgres' : 'sqlite',
  ai: ai.AI_ENABLED,
  mail: mail && mail.mailConfig ? mail.mailConfig : { mode: 'unconfigured' },
  time: new Date().toISOString(),
}));

app.get('/api/debug', (req, res) => {
  res.json({
    vercel: process.env.VERCEL || '0',
    has_db: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL),
    db_is_pg: db.IS_PG,
    db_error: db.DB_ERROR || null,
    db_url_redacted: process.env.DATABASE_URL ? (process.env.DATABASE_URL.split('@')[1] || 'set') : 'not set',
  });
});

app.get('/api/env-check', (req, res) => {
  const names = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'TRUST_WALLET_ADDRESS', 'AI_ENABLED', 'AI_API_KEY', 'OWNER_EMAIL', 'OWNER_PASSWORD', 'JWT_SECRET', 'SMTP_HOST', 'SMTP_USER', 'MAIL_FROM', 'RESEND_API_KEY'];
  const out = {};
  for (const n of names) {
    const v = process.env[n] || '';
    out[n] = v ? 'SET' : 'EMPTY';
  }
  out.lifeos_settings = process.env.LIFEOS_SETTINGS ? 'SET' : 'EMPTY';
  out.vercel = process.env.VERCEL || '0';
  out.render = process.env.RENDER || 'false';
  out.vercel_env = process.env.VERCEL_ENV || '';
  out.vercel_branch = process.env.VERCEL_GIT_BRANCH || '';
  out.database_prefix = process.env.DATABASE_URL ? String(process.env.DATABASE_URL).slice(0, 12) : 'none';
  out.postgres_prefix = process.env.POSTGRES_URL ? String(process.env.POSTGRES_URL).slice(0, 12) : 'none';
  res.json(out);
});

// ===== diagnostic test (works with GET, does not create account) =====
app.get('/api/test', async (req, res) => {
  const out = { ok: false, steps: [], database_url: !!process.env.DATABASE_URL, owner_email: process.env.OWNER_EMAIL || '' };
  try {
    const usersCols = await db.all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', ['users']).catch(() => null);
    out.steps.push({ step: 'users_columns', rows: Array.isArray(usersCols) ? usersCols.map(c => c.column_name) : 'FAILED' });
    const c = await db.get('SELECT COUNT(*) n FROM users', []).catch(() => null);
    out.steps.push({ step: 'users_count', count: c ? Number(c.n) : 'FAILED' });
    out.ok = true;
  } catch (e) {
    out.steps.push({ step: 'error', detail: e.message });
  }
  res.json(out);
});

app.get('/api/db/check', async (req, res) => {
  const out = { ok: false, tables: {}, errors: [] };
  try {
    const tables = ['users', 'tasks', 'habits', 'payments', 'waitlist', 'referrals', 'events', 'notifications'];
    for (const t of tables) {
      try {
        const r = await db.get(`SELECT count(*) n FROM ${t}`, []);
        out.tables[t] = r ? r.n : 0;
      } catch (e) {
        out.tables[t] = 'MISSING:' + e.message;
        out.errors.push(t + ': ' + e.message);
      }
    }
    // Check users column existence
    try {
      const cols = await db.all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', ['users']);
      out.users_columns = (cols || []).map(c => c.column_name);
    } catch (e) {
      out.users_columns = 'ERR:' + e.message;
    }
    out.ok = !out.errors.length;
  } catch (e) {
    out.ok = false;
    out.errors.push(e.message);
  }
  res.json(out);
});

// ===== mail test (diagnostic, no real user) =====
app.get('/api/mail-test', async (req, res) => {
  const cfg = mail && mail.mailConfig ? mail.mailConfig : {};
  const to = (req.query.to || process.env.MAIL_TEST_TO || 'test@example.com').toString();
  let result = { sent: false, mode: 'none' };
  try {
    result = await Promise.race([
      mail.sendVerificationCode(to, '123456', 'en'),
      new Promise(resolve => setTimeout(() => resolve({ sent: false, mode: 'timeout', detail: 'mail-test timed out after 30s' }), 30000)),
    ]);
  } catch (e) {
    result = { sent: false, mode: 'error', detail: e.message };
  }
  await logMail(to, result.mode, result.sent, result.detail);
  res.json({ config: cfg, to, result });
});

// ===== mail logs (diagnostic; shows real SMTP errors) =====
app.get('/api/mail-logs', async (req, res) => {
  const email = (req.query.email || '').toString().trim().toLowerCase();
  try {
    const rows = email
      ? await db.all('SELECT id, email, mode, sent, detail, mail_from, created_at FROM mail_logs WHERE email = ? ORDER BY id DESC LIMIT 20', [email])
      : await db.all('SELECT id, email, mode, sent, detail, mail_from, created_at FROM mail_logs ORDER BY id DESC LIMIT 30');
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: 'logs unavailable', detail: e.message });
  }
});

// ===== public config =====
app.get('/api/config/public', (req, res) => {
  res.json({
    wallet_address: WALLET,
    network: 'TRC20',
    asset: 'USDT',
    prices: { pro: PRICE_PRO, life: PRICE_LIFE },
    ai_enabled: ai.AI_ENABLED,
    coupon: { code: COUPON_CODE, percent: COUPON_PERCENT, active: true },
  });
});

// ===== lightweight analytics event (public) =====
app.post('/api/events', async (req, res) => {
  const { type, path, email } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type required' });
  await db.run('INSERT INTO events (type, path, email) VALUES (?, ?, ?)', [
    String(type).slice(0, 60),
    String(path || '').slice(0, 200),
    email ? String(email).slice(0, 200) : null,
  ]);
  res.json({ ok: true });
});

// ===== auth =====
function makeRefCode() {
  return 'LIFE' + Math.random().toString(36).slice(2, 8).toUpperCase();
}
function makeVerifyCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function verifyExpiry() {
  return new Date(Date.now() + 10 * 60 * 1000).toISOString();
}
function devCodeAllowed() {
  return process.env.ALLOW_DEV_VERIFY !== 'false';
}
async function logMail(email, mode, sent, detail) {
  try {
    await db.run('INSERT INTO mail_logs (email, mode, sent, detail, mail_from) VALUES (?, ?, ?, ?, ?)',
      [email || '', mode || 'unknown', sent ? 1 : 0, String(detail || '').slice(0, 500), (mail && mail.mailConfig ? mail.mailConfig.from : '')]);
  } catch (e) {
    console.error('[mail-log] failed to store:', e && e.message ? e.message : e);
  }
}

function deliveryPayload(result, email, code) {
  const out = { delivery: result.mode || 'unconfigured', delivery_sent: !!result.sent, detail: result.detail || null };
  // While the email is actually being attempted in the background, do NOT leak the
  // code on screen. The user waits for the real inbox code.
  if (!result.sent && result.mode !== 'sending') {
    out.dev_code = code || result.dev_code;
    out.dev_note = result.mode === 'error'
      ? 'Email could not be sent yet. Use the code on screen for now.'
      : 'Email sending is not configured yet. Use the code on screen for now.';
  } else if (result.mode === 'sending') {
    out.dev_note = 'We are sending you a real email. Check your inbox (and spam) for the code.';
  }
  return { ...out, email };
}

// Generate + save a new code, then SEND the email in the background so the API
// responds instantly. The send promise runs on its own (Gmail can take >5s),
// and we record the real outcome in mail_logs for diagnostics.
async function sendCode(user, lang, opts = {}) {
  const code = makeVerifyCode();
  const expires = verifyExpiry();
  await db.run('UPDATE users SET verify_code = ?, verify_expires = ?, verify_attempts = 0 WHERE id = ?', [code, expires, user.id]);
  const firePromise = () => mail.sendVerificationCode(user.email, code, lang)
    .then(r => {
      logMail(user.email, r.mode, r.sent, r.detail);
      if (r && r.sent) console.log('[mail] verification code SENT to', user.email);
      else console.warn('[mail] verification code not sent to', user.email, r && r.mode, r && r.detail);
      return r;
    })
    .catch(e => {
      logMail(user.email, 'error', false, e.message);
      return { sent: false, mode: 'error', detail: 'Email failed: ' + e.message };
    });

  // Default: respond instantly, email sent in background.
  if (!opts.wait) {
    firePromise();
    return { code, result: { sent: false, mode: 'sending', detail: 'Email is being sent in the background.' } };
  }

  // Resend / explicit retry: wait up to 12s for a real provider answer so we can
  // tell the user honestly whether it worked or show the code as a fallback.
  const result = await Promise.race([
    firePromise(),
    new Promise(resolve => setTimeout(() => resolve({ sent: false, mode: 'timeout', detail: 'Email is taking longer than expected. Check inbox/spam.' }), 12000)),
  ]);
  return { code, result };
}

app.post('/api/auth/register', async (req, res) => {
  const { email, name, password, locale, ref } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, name, password required' });
  const mailAddr = email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailAddr)) return res.status(400).json({ error: 'invalid email' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short (min 6)' });
  const exists = await db.get('SELECT id, email_verified FROM users WHERE email = ?', [mailAddr]);
  if (exists) {
    // Legacy unverified account: activate it and sign the user in right away.
    const user = await db.get('SELECT * FROM users WHERE id = ?', [exists.id]);
    await autoVerifyUser(user);
    return res.json({ token: tokenFor(user), user: publicUser(user), auto_verified: true });
  }

  // Optional referral: inviter code -> ref_by + referrals row.
  let inviter = null;
  if (ref && String(ref).trim()) {
    inviter = await db.get('SELECT id, ref_code FROM users WHERE ref_code = ?', [String(ref).trim().toUpperCase()]);
  }

  const hash = bcrypt.hashSync(password, 10);
  const refCode = makeRefCode();
  const lang = locale === 'ar' ? 'ar' : 'en';
  // IMPORTANT: email verification is disabled. The account is usable immediately.
  const info = await db.run(
    'INSERT INTO users (email, name, password_hash, locale, plan, ref_code, ref_by, email_verified, verify_code, verify_expires) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL) RETURNING id',
    [mailAddr, name.trim(), hash, lang, 'free', refCode, inviter ? inviter.id : null]
  );
  const user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);

  if (inviter) {
    await db.run(
      'INSERT INTO referrals (inviter_user_id, invited_email, invited_user_id, status, reward) VALUES (?, ?, ?, ?, ?)',
      [inviter.id, mailAddr, user.id, 'pending', 'discount']
    );
  }

  // Best-effort welcome email in the background; it never blocks the signup.
  mail.sendVerificationCode(user.email, user.verify_code || '', lang || 'en')
    .then(r => logMail(user.email, r.mode, r.sent, r.detail))
    .catch(e => logMail(user.email, 'error', false, e.message));

  res.json({ token: tokenFor(user), user: publicUser(user) });
});

app.post('/api/auth/verify-email', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'email and code required' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!user) return res.status(404).json({ error: 'user not found' });
  await autoVerifyUser(user);
  return res.json({ token: tokenFor(user), user: publicUser(user) });
  if (!user.verify_code) return res.status(400).json({ error: 'no_code_sent', message: 'Request a new code.' });

  const expired = user.verify_expires && new Date(user.verify_expires).getTime() < Date.now();
  if (expired) return res.status(400).json({ error: 'code_expired', message: 'Code expired. Request a new one.' });

  if ((user.verify_attempts || 0) >= 5) return res.status(400).json({ error: 'too_many_attempts', message: 'Too many attempts. Request a new code.' });

  if (String(user.verify_code).trim() !== String(code).trim()) {
    await db.run('UPDATE users SET verify_attempts = verify_attempts + 1 WHERE id = ?', [user.id]);
    return res.status(400).json({ error: 'invalid_code', message: 'Incorrect code.' });
  }

  await db.run('UPDATE users SET email_verified = 1, verify_code = NULL, verify_expires = NULL, verify_attempts = 0 WHERE id = ?', [user.id]);
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  res.json({ token: tokenFor(fresh), user: publicUser(fresh), verified: true });
});

app.post('/api/auth/resend', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (user.email_verified) return res.status(400).json({ error: 'already_verified' });
  const sent = await sendCode(user, user.locale === 'ar' ? 'ar' : 'en', { wait: true });
  res.json({ ...deliveryPayload(sent.result, email, sent.code) });
});

// ===== waitlist (public) =====
app.post('/api/waitlist', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
  const exists = await db.get('SELECT id FROM waitlist WHERE email = ?', [email]);
  if (!exists) await db.run('INSERT INTO waitlist (email) VALUES (?)', [email]);
  res.json({ ok: true, message: 'Added to waitlist.' });
});

// ===== referral (authenticated) =====
app.get('/api/referral', auth, async (req, res) => {
  const code = req.user.ref_code || makeRefCode();
  if (!req.user.ref_code) {
    await db.run('UPDATE users SET ref_code = ? WHERE id = ?', [code, req.user.id]);
  }
  const invites = await db.all('SELECT * FROM referrals WHERE inviter_user_id = ? ORDER BY id DESC', [req.user.id]);
  res.json({ code, link: `/app?ref=${code}`, invites: invites.length });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  // Email verification is no longer required; legacy unverified accounts are
  // activated automatically so nobody is blocked.
  await autoVerifyUser(user);
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put('/api/me/locale', auth, async (req, res) => {
  const locale = req.body.locale === 'ar' ? 'ar' : 'en';
  await db.run('UPDATE users SET locale = ? WHERE id = ?', [locale, req.user.id]);
  req.user.locale = locale;
  res.json({ user: publicUser(req.user) });
});

// ===== tasks =====
app.get('/api/tasks', auth, async (req, res) => {
  const rows = await db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, due ASC, id DESC', [req.user.id]);
  res.json(rows);
});

app.post('/api/tasks', auth, async (req, res) => {
  const { text, priority, due } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const info = await db.run(
    'INSERT INTO tasks (user_id, text, priority, due) VALUES (?, ?, ?, ?) RETURNING id',
    [req.user.id, text.trim(), priority || 'medium', due || null]
  );
  const row = await db.get('SELECT * FROM tasks WHERE id = ?', [info.lastInsertRowid]);
  res.json(row);
});

app.patch('/api/tasks/:id', auth, async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!task) return res.status(404).json({ error: 'not found' });
  const done = req.body.done == null ? task.done : (req.body.done ? 1 : 0);
  const priority = req.body.priority || task.priority;
  const due = req.body.due !== undefined ? req.body.due : task.due;
  const text = req.body.text || task.text;
  await db.run('UPDATE tasks SET done = ?, priority = ?, due = ?, text = ? WHERE id = ?', [done, priority, due, text, task.id]);
  res.json(await db.get('SELECT * FROM tasks WHERE id = ?', [task.id]));
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  const info = await db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ deleted: info.changes > 0 });
});

// ===== habits =====
app.get('/api/habits', auth, async (req, res) => {
  res.json(await db.all('SELECT * FROM habits WHERE user_id = ? ORDER BY id DESC', [req.user.id]));
});

app.post('/api/habits', auth, async (req, res) => {
  const { name, target } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const info = await db.run(
    'INSERT INTO habits (user_id, name, target) VALUES (?, ?, ?) RETURNING id',
    [req.user.id, name.trim(), target || 1]
  );
  res.json(await db.get('SELECT * FROM habits WHERE id = ?', [info.lastInsertRowid]));
});

app.post('/api/habits/:id/complete', auth, async (req, res) => {
  const habit = await db.get('SELECT * FROM habits WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!habit) return res.status(404).json({ error: 'not found' });
  const next = Math.min(habit.completed_today + 1, habit.target);
  await db.run('UPDATE habits SET completed_today = ? WHERE id = ?', [next, habit.id]);
  res.json(await db.get('SELECT * FROM habits WHERE id = ?', [habit.id]));
});

app.delete('/api/habits/:id', auth, async (req, res) => {
  const info = await db.run('DELETE FROM habits WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ deleted: info.changes > 0 });
});

// ===== AI chat =====
app.get('/api/conversations', auth, async (req, res) => {
  const rows = await db.all('SELECT * FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
  res.json(rows.reverse());
});

// Free users get a generous daily limit (default 10). Pro/Life is unlimited.
const FREE_AI_DAILY_LIMIT = parseInt(process.env.FREE_AI_DAILY_LIMIT || '10', 10);

app.post('/api/chat', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

  if (req.user.plan === 'free') {
    const usedToday = await db.get(
      "SELECT COUNT(*) n FROM conversations WHERE user_id = ? AND role = 'ai' AND date(created_at) = date('now')",
      [req.user.id]
    );
    if ((usedToday?.n || 0) >= FREE_AI_DAILY_LIMIT) {
      return res.status(402).json({ error: 'free_daily_limit', message: 'You reached the free daily AI limit.' });
    }
  }

  const history = (await db.all(
    'SELECT role, content FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 10',
    [req.user.id]
  )).reverse();

  await db.run('INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)', [req.user.id, 'user', message]);
  const response = await ai.chat({ user: req.user, message, history, locale: req.user.locale });
  await db.run('INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)', [req.user.id, 'ai', response]);

  res.json({ reply: response });
});

// ===== LifeOS 40-Day Life Mountain =====
// Free: days 1-10 (Starter) - motivating, easy wins.
// Pro:  days 11-30 (Rise)   - creative, viral, harder.
// Life: days 31-40 (Legend) - intense, unforgettable.
// Every account gets a DIFFERENT sequence (seeded by user id), difficulty grows,
// and each check-in earns points/streak/milestone rewards.

const CH_FREE_DAYS = 10;
const CH_PRO_DAYS = 30;
const CH_TOTAL_DAYS = 40;
const CH_MILESTONES = { 7: 20, 10: 30, 14: 30, 21: 40, 30: 60, 40: 120 };

const CH_FREE_POOL = [
  { en: 'Write your #1 goal in one sentence and read it out loud.', ar: 'اكتب هدفك الأول بجملة واحدة واقرأه بصوت عالٍ.' },
  { en: 'Choose the 3 most important tasks for today; write them down.', ar: 'اختر أهم ٣ مهام لهذا اليوم واكتبها.' },
  { en: 'Do 20 minutes of focused work with zero phone.', ar: 'اعمل ٢٠ دقيقة بتركيز كامل بدون هاتف.' },
  { en: 'Drink 8 glasses of water today.', ar: 'اشرب ٨ أكواب ماء اليوم.' },
  { en: 'Walk or move outside for 15 minutes.', ar: 'امشِ أو تحرك خارجاً لمدة ١٥ دقيقة.' },
  { en: 'Make your bed first thing in the morning.', ar: 'رتّب سريرك أول ما تصحى.' },
  { en: 'Write 3 things you are grateful for.', ar: 'اكتب ٣ أشياء أنت ممتن لها.' },
  { en: 'Plan tomorrow tonight before you sleep.', ar: 'خطط ليوم غدٍ قبل النوم.' },
  { en: 'Read or listen to 10 minutes of something useful.', ar: 'اقرأ أو اسمع ١٠ دقائق شيئاً مفيداً.' },
  { en: 'Do one small healthy meal choice today.', ar: 'اختر وجبة صحية واحدة اليوم.' },
  { en: 'Remove one distraction from your environment.', ar: 'أزل مشتّتاً واحداً من بيئتك.' },
  { en: 'Message or call someone you care about.', ar: 'تواصل مع شخص تهتم لأمره.' },
  { en: 'Do 5 minutes of breathing or stretching.', ar: 'خذ ٥ دقائق تنفّس أو تمدّد.' },
  { en: 'Identify one thing that drains you and say no to it.', ar: 'حدد شيئاً يستنزفك وقل له لا.' },
  { en: 'Write one sentence about the person you want to become.', ar: 'اكتب جملة عن الشخص الذي تريد أن تصبحه.' },
  { en: 'Do one act of kindness, big or small.', ar: 'قدّم لطفاً واحداً، كبيراً أو صغيراً.' },
  { en: 'Check your energy: sleep, water, food. Fix one.', ar: 'افحص طاقتك: نوم، ماء، طعام. أصلح واحداً.' },
  { en: 'Set one realistic goal for next week.', ar: 'ضع هدفاً واقعياً للأسبوع القادم.' },
];

const CH_PRO_POOL = [
  { en: 'Record a 15-second video explaining your #1 goal. Post it if you dare.', ar: 'سجّل فيديو ١٥ ثانية تشرح فيه هدفك. انشره إذا تجرأت.' },
  { en: 'Do a "smart hour": one hour, no distractions, one important thing.', ar: 'اعمل "ساعة ذكية": ساعة واحدة بلا تشتيت لشيء مهم واحد.' },
  { en: 'Take a photo of your workspace and improve one thing about it.', ar: 'صوّر مكان عملك ثم حسّن شيئاً واحداً فيه.' },
  { en: 'Send a specific compliment to 3 different people.', ar: 'أرسل إطراءً محدداً إلى ٣ أشخاص مختلفين.' },
  { en: 'Do 30 minutes of exercise you actually enjoy (not punishment).', ar: 'أنجز ٣٠ دقيقة تمرين تستمتع به فعلاً.' },
  { en: 'Delete one app that wastes your time and note how it feels.', ar: 'احذف تطبيقاً يضيع وقتك ولاحظ شعورك.' },
  { en: 'Plan the next 7 days in 10 minutes. Take a screenshot.', ar: 'خطط الأيام السبعة القادمة في ١٠ دقائق. خذ لقطة شاشة.' },
  { en: 'Eat one meal without any screen. Fully present.', ar: 'تناول وجبة كاملة بدون شاشة. حضور كامل.' },
  { en: 'Write a 3-line "anti-routine": what you will NOT do tomorrow.', ar: 'اكتب "روتيناً مضاداً": ما الذي لن تفعله غداً.' },
  { en: 'Call someone who used to matter to you.', ar: 'اتصل بشخص كان يهمك يوماً ما.' },
  { en: 'Do one thing you have been postponing for over a week.', ar: 'أنهِ شيئاً تؤجله منذ أكثر من أسبوع.' },
  { en: 'Create a 1-minute morning ritual and actually do it.', ar: 'أنشئ طقس صباحي مدته دقيقة ونفّذه فعلاً.' },
  { en: 'Write 5 things you are proud of. Read them aloud.', ar: 'اكتب ٥ أشياء تفتخر بها واقرأها بصوت عالٍ.' },
  { en: 'Improve your sleep: no screens 30 minutes before bed.', ar: 'حسّن نومك: بلا شاشات قبل النوم ب٣٠ دقيقة.' },
  { en: 'Do one "brave" thing that scares you a little.', ar: 'افعل شيئاً "شجاعاً" يخيفك قليلاً.' },
  { en: 'Make a short list of people who lift you up. Thank one.', ar: 'اكتب قائمة الأشخاص الذين يرفعونك. اشكر واحداً.' },
  { en: 'Do a digital detox for 2 hours and notice everything.', ar: 'افصل عن العالم الرقمي ساعتين ولاحظ كل شيء.' },
  { en: 'Take a photo of what you did today and share why it matters.', ar: 'صوّر ما أنجزته اليوم وشارك سبب أهميته.' },
  { en: 'Say one hard truth you have been avoiding.', ar: 'قل حقيقة صعبة كنت تتجنبها.' },
  { en: 'Write down 10 ideas for your future. Keep all of them.', ar: 'اكتب ١٠ أفكار لمستقبلك. احتفظ بها كلها.' },
];

const CH_LIFE_POOL = [
  { en: 'Do a full 5-hour personal "deep work" marathon on your biggest goal.', ar: 'أنجز ماراثون "عمل عميق" ٥ ساعات كاملة على هدفك الأكبر.' },
  { en: 'Write a 30-day plan for your #1 life area and print/save it.', ar: 'اكتب خطة ٣٠ يوماً لأهم مجال في حياتك واحفظها.' },
  { en: 'Complete a project you have been putting off and document it.', ar: 'أنهِ مشروعاً يؤجله منذ زمن وتوثّقه.' },
  { en: 'Do a 24-hour challenge: no complaining, no negativity.', ar: 'تحدي ٢٤ ساعة: لا شكوى، لا سلبية.' },
  { en: 'Create something (article, video, design) and publish it.', ar: 'أنشئ شيئاً (مقال، فيديو، تصميم) وانشره.' },
  { en: 'Do 50 minutes of hard physical training that pushes you.', ar: 'أنجز ٥٠ دقيقة تمرين جسدي صعب يدفعك للحد.' },
  { en: 'Have one deep, honest 1-hour conversation with someone important.', ar: 'اخض محادثة صادقة وعميقة لساعة مع شخص مهم.' },
  { en: 'Reinvent your routine: design a "1% better" system for one life area.', ar: 'أعد تصميم روتينك: نظام "أفضل ١٪" لمجال واحد.' },
  { en: 'Do something public that shows your progress. Be proud.', ar: 'افعل شيئاً علنياً يعرض تقدمك. كن فخوراً.' },
  { en: 'Give 30 minutes to help someone achieve a goal.', ar: 'ساعد شخصاً لتحقيق هدفه لمدة ٣٠ دقيقة.' },
  { en: 'Write your own 5-year vision and read it aloud.', ar: 'اكتب رؤيتك لخمس سنوات واقرأها بصوت عالٍ.' },
  { en: 'Do one thing today that your future self will thank you for.', ar: 'افعل شيئاً يشكرك عليه "نسختك المستقبلية".' },
];

function chStage(day) {
  if (day <= 10) return { key: 'starter', name_en: 'Starter', name_ar: 'البداية', tier: 'free', color: '#34d399' };
  if (day <= 30) return { key: 'rise', name_en: 'Rise', name_ar: 'الصعود', tier: 'pro', color: '#c084fc' };
  return { key: 'legend', name_en: 'Legend', name_ar: 'الأسطورة', tier: 'life', color: '#fbbf24' };
}

function chTaskFor(day, userId, lang) {
  const stage = chStage(day);
  let pool;
  if (stage.tier === 'free') pool = CH_FREE_POOL;
  else if (stage.tier === 'pro') pool = CH_PRO_POOL;
  else pool = CH_LIFE_POOL;
  const idx = Math.abs(((userId * 37 + day * 53) % 97) % pool.length);
  const item = pool[idx];
  return { day, tier: stage.tier, stage: stage, text: lang === 'ar' ? item.ar : item.en };
}

function chReward(day, streak) {
  const base = 10 + Math.min(streak, 10); // streak bonus
  const milestone = CH_MILESTONES[day] || 0;
  const total = base + milestone;
  return { base, milestone, total, bonus: streak > 1 ? `+${Math.min(streak, 10)} streak` : null };
}

app.get('/api/challenge', auth, async (req, res) => {
  const u = req.user;
  const started = !!u.challenge_start;
  const day = u.challenge_day || 0;
  const completed = u.challenge_completed;
  const plan = u.plan || 'free';
  const lang = req.query.lang || u.locale || 'en';
  const logs = await db.all('SELECT day_number, status, note, created_at FROM challenge_logs WHERE user_id = ? ORDER BY day_number ASC', [u.id]);
  const maxAllowed = plan === 'life' ? CH_TOTAL_DAYS : (plan === 'pro' ? CH_PRO_DAYS : CH_FREE_DAYS);
  const total = CH_TOTAL_DAYS;
  const canContinue = started && !completed && (day < maxAllowed);
  const needUpgrade = started && !completed && (day >= maxAllowed) && (maxAllowed < total);
  const today = started && !completed ? Math.min(day + 1, maxAllowed) : day;
  const task = (started && !completed && canContinue) ? chTaskFor(Math.min(day + 1, maxAllowed), u.id, lang) : null;
  const nextStage = started && !completed && canContinue ? chStage(Math.min(day + 1, maxAllowed)) : null;
  res.json({
    started, completed, streak: u.challenge_streak || 0, points: u.challenge_points || 0,
    day, today, task, logs, plan, maxAllowed, total, needUpgrade, canContinue,
    stage: nextStage, all_stages: ['starter', 'rise', 'legend'],
    reward: task ? chReward(Math.min(day + 1, maxAllowed), (u.challenge_streak || 0) + 1) : null,
    share_text: started
      ? `I'm on Day ${Math.min(day + 1, maxAllowed)} of the LifeOS 40-Day Life Mountain 🚀 ${chStage(Math.min(day + 1, maxAllowed)).name_en} #LifeOS40 #مرشد_حياتك`
      : 'I just joined the LifeOS 40-Day Life Mountain 🚀 #LifeOS40 #مرشد_حياتك',
  });
});

app.post('/api/challenge/start', auth, async (req, res) => {
  const u = req.user;
  if (!u.challenge_start) {
    await db.run('UPDATE users SET challenge_start = ?, challenge_day = 0, challenge_streak = 0, challenge_points = 10, challenge_completed = 0 WHERE id = ?', [new Date().toISOString(), u.id]);
  }
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  res.json({ ok: true, challenge: { started: !!fresh.challenge_start, day: fresh.challenge_day, points: fresh.challenge_points, streak: fresh.challenge_streak } });
});

app.post('/api/challenge/checkin', auth, async (req, res) => {
  const u = req.user;
  if (u.challenge_completed) return res.status(400).json({ error: 'already_completed' });
  const plan = u.plan || 'free';
  const maxAllowed = plan === 'life' ? CH_TOTAL_DAYS : (plan === 'pro' ? CH_PRO_DAYS : CH_FREE_DAYS);
  const day = (u.challenge_day || 0) + 1;
  if (day > maxAllowed) return res.status(403).json({ error: 'upgrade_required', message: 'Upgrade to continue this challenge.' });
  const doneToday = await db.get('SELECT id FROM challenge_logs WHERE user_id = ? AND day_number = ? AND status = ?', [u.id, day, 'done']);
  if (doneToday) return res.status(400).json({ error: 'already_checked' });
  const note = (req.body && req.body.note || '').toString().slice(0, 200);
  await db.run('INSERT INTO challenge_logs (user_id, day_number, status, note) VALUES (?, ?, ?, ?)', [u.id, day, 'done', note]);
  const reward = chReward(day, (u.challenge_streak || 0) + 1);
  const completed = day >= CH_TOTAL_DAYS ? 1 : 0;
  const points = (u.challenge_points || 0) + reward.total;
  const streak = (u.challenge_streak || 0) + 1;
  await db.run('UPDATE users SET challenge_day = ?, challenge_points = ?, challenge_streak = ?, challenge_completed = ? WHERE id = ?', [day, points, streak, completed, u.id]);
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  res.json({
    ok: true, reward,
    challenge: { day: fresh.challenge_day, points: fresh.challenge_points, streak: fresh.challenge_streak, completed: !!fresh.challenge_completed },
    task: (completed || fresh.challenge_day >= maxAllowed) ? null : chTaskFor(fresh.challenge_day + 1, u.id, u.locale),
    needUpgrade: fresh.challenge_day >= maxAllowed && maxAllowed < CH_TOTAL_DAYS,
  });
});

app.post('/api/challenge/skip', auth, async (req, res) => {
  const u = req.user;
  const day = (u.challenge_day || 0) + 1;
  await db.run('INSERT INTO challenge_logs (user_id, day_number, status, note) VALUES (?, ?, ?, ?)', [u.id, day, 'skipped', 'skipped']);
  await db.run('UPDATE users SET challenge_day = ?, challenge_streak = 0 WHERE id = ?', [day, u.id]);
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  res.json({ ok: true, challenge: { day: fresh.challenge_day, streak: fresh.challenge_streak, points: fresh.challenge_points } });
});

// ===== checkout / payments =====
app.post('/api/checkout', async (req, res) => {
  const { plan, email, coupon } = req.body || {};
  const valid = ['pro', 'life'];
  if (!valid.includes(plan)) return res.status(400).json({ error: 'invalid plan' });
  const baseAmount = planPrice(plan);
  const discount = applyCoupon(baseAmount, coupon);
  const amount = discount.amount;
  const address = WALLET;

  let userId = null;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(h.slice(7), JWT_SECRET);
      userId = payload.id;
    } catch {}
  }

  const info = await db.run(
    'INSERT INTO payments (user_id, email, plan, amount_usd, network, wallet_address, coupon, discount_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [userId, email || null, plan, amount, 'TRC20', address, discount.coupon, discount.discount_percent]
  );

  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [info.lastInsertRowid]);
  const qr = await QRCode.toDataURL(address);

  // Notify owner (only production-friendly; safe if owner not found).
  await notifyOwner(
    `New USDT payment ${payment.id}`,
    `${payment.plan.toUpperCase()} — $${amount}${discount.coupon ? ' (' + discount.coupon + ')' : ''} / ${payment.email || ('user ' + userId)}`,
    '/admin'
  );

  res.json({
    payment_id: payment.id,
    asset: 'USDT',
    network: 'TRC20',
    address,
    amount,
    plan,
    coupon: discount.coupon,
    discount_percent: discount.discount_percent,
    qr,
    note: 'Send exact amount to the address above, then paste the transaction hash here.',
  });
});

app.get('/api/payments/:id', async (req, res) => {
  const row = await db.get(
    'SELECT id, plan, amount_usd, network, wallet_address, tx_hash, status, created_at FROM payments WHERE id = ?',
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

async function verifyTronscanTx(txHash) {
  const url = `${TRONSCAN_BASE}/api/transaction-info?hash=${encodeURIComponent(txHash)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const data = await res.json();
  const ok = data && (data.contractRet === 'SUCCESS' || data.confirmed === true);
  const to = (data.toAddress || data.to_address || '').toLowerCase();
  const amount = data.amount || 0;
  const matchedWallet = to === WALLET.toLowerCase();
  const isUsdt = !data.contractAddress || String(data.contractAddress).toLowerCase() === USDT_TRC20_CONTRACT.toLowerCase();
  return { ok: ok && matchedWallet, reason: ok ? (matchedWallet ? 'matched wallet' : 'amount matched but wallet mismatch') : data.contractRet || 'not success', amount, to, isUsdt };
}

app.post('/api/payments/:id/verify', auth, async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'not found' });
  const hash = (req.body && req.body.tx_hash) || payment.tx_hash;
  if (!hash) return res.status(400).json({ error: 'tx_hash required' });
  try {
    const result = await verifyTronscanTx(hash);
    await db.run('UPDATE payments SET tx_hash = ?, verified = ? WHERE id = ?', [hash, result.ok ? 1 : 0, payment.id]);
    res.json({ status: result.ok ? 'verified' : 'unverified', ...result });
  } catch (e) {
    await db.run('UPDATE payments SET tx_hash = ?, verified = 0 WHERE id = ?', [hash, payment.id]);
    res.json({ status: 'unverified', reason: `verification failed: ${e.message}`, error: true });
  }
});

app.post('/api/payments/:id/claim', auth, async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'not found' });
  const { tx_hash } = req.body || {};
  if (!tx_hash || !tx_hash.trim()) return res.status(400).json({ error: 'tx_hash required' });
  await db.run('UPDATE payments SET tx_hash = ?, status = ? WHERE id = ?', [tx_hash.trim(), 'submitted', payment.id]);
  let auto = null;
  try {
    auto = await verifyTronscanTx(tx_hash.trim());
    await db.run('UPDATE payments SET verified = ? WHERE id = ?', [auto.ok ? 1 : 0, payment.id]);
  } catch (e) {
    auto = { status: 'unverified', reason: `auto-verify unavailable (${e.message})` };
  }
  await notifyOwner(`Payment #${payment.id} hash submitted`, `${payment.plan} — ${payment.email || ''}`, '/admin');
  res.json({ status: 'submitted', auto, message: 'Payment submitted. Owner can confirm it.' });
});

// ===== admin =====
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (email.toLowerCase() !== OWNER_EMAIL) return res.status(401).json({ error: 'not owner' });
  const user = await db.get('SELECT * FROM users WHERE email = ?', [OWNER_EMAIL]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

app.get('/api/admin/stats', ownerAuth, async (req, res) => {
  const users = await db.listUsers();
  const payments = await db.listPayments();
  const waitlist = await db.listWaitlist();
  const referrals = await db.listReferrals();
  const confirmed = payments.filter(p => p.status === 'confirmed');
  res.json({
    users: users.length,
    confirmed_payments: confirmed.length,
    revenue_usd: confirmed.reduce((s, p) => s + (p.amount_usd || 0), 0),
    pending_payments: payments.filter(p => p.status === 'pending' || p.status === 'submitted').length,
    waitlist: waitlist.length,
    referrals: referrals.length,
    pageviews: await db.countEvents('pageview'),
    notifications: await db.unreadNotifications(req.user.id),
  });
});

app.get('/api/admin/notifications', ownerAuth, async (req, res) => {
  const rows = await db.listNotifications(req.user.id);
  await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.user.id]);
  res.json(rows);
});

app.get('/api/admin/payments', ownerAuth, async (req, res) => res.json(await db.listPayments()));
app.get('/api/admin/users', ownerAuth, async (req, res) => res.json(await db.listUsers()));
app.get('/api/admin/waitlist', ownerAuth, async (req, res) => res.json(await db.listWaitlist()));
app.get('/api/admin/referrals', ownerAuth, async (req, res) => res.json(await db.listReferrals()));

app.post('/api/admin/payments/:id/confirm', ownerAuth, async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'not found' });
  const status = req.body.status === 'confirmed' ? 'confirmed' : 'rejected';
  await db.run('UPDATE payments SET status = ? WHERE id = ?', [status, payment.id]);

  if (status === 'confirmed' && payment.user_id) {
    const until = payment.plan === 'life' ? '2999-12-31' : `${new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)}`;
    await db.run('UPDATE users SET plan = ?, plan_until = ? WHERE id = ?', [payment.plan, until, payment.user_id]);
  }
  const updated = await db.get('SELECT * FROM payments WHERE id = ?', [payment.id]);
  res.json({ payment: updated });
});

// ===== static / SPA routes =====
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// error handler
app.use((err, req, res, next) => {
  console.error('[lifeos] error:', err);
  res.status(500).json({ error: 'internal error' });
});

module.exports = { app };
