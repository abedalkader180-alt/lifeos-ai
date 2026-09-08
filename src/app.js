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

// ===== plan state =====
// Pro is monthly: it stays active only while plan_until >= today. Life is a
// one-time lifetime plan. Legacy boost20 buyers keep their perks.
function planInfo(u) {
  const today = new Date().toISOString().slice(0, 10);
  if (u.plan === 'life') return { plan: 'life', active: true, premium: true, days_left: null };
  if (u.plan === 'boost20') return { plan: 'boost20', active: true, premium: true, days_left: null };
  if (u.plan === 'pro') {
    if (u.plan_until && u.plan_until >= today) {
      const days = Math.ceil((new Date(u.plan_until + 'T23:59:59Z').getTime() - Date.now()) / 864e5);
      return { plan: 'pro', active: true, premium: true, days_left: Math.max(0, days) };
    }
    return { plan: 'pro', active: false, premium: false, days_left: 0, expired: true };
  }
  return { plan: 'free', active: false, premium: false, days_left: null };
}

// Renewal reminders: email the user once per threshold (7 / 3 / 1 days left).
async function syncPlanReminders(u) {
  try {
    if (u.plan !== 'pro' || !u.plan_until) return u;
    const pi = planInfo(u);
    if (!pi.active || pi.days_left === null || pi.days_left > 7) return u;
    const stage = pi.days_left <= 1 ? 3 : pi.days_left <= 3 ? 2 : 1;
    if ((u.plan_remind_stage || 0) < stage) {
      await db.run('UPDATE users SET plan_remind_stage = ? WHERE id = ?', [stage, u.id]);
      u.plan_remind_stage = stage;
      mail.sendPlanReminder(u.email, u.locale === 'ar' ? 'ar' : 'en', pi.days_left)
        .then(r => logMail(u.email, 'reminder', r.sent, r.detail))
        .catch(e => logMail(u.email, 'reminder', false, e.message));
    }
  } catch (e) { /* never block auth on reminders */ }
  return u;
}

function publicUser(u) {
  const isOwner = u.email.toLowerCase() === OWNER_EMAIL;
  const pi = planInfo(u);
  let life_profile = null;
  try { life_profile = u.life_profile ? JSON.parse(u.life_profile) : null; } catch (e) {}
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    locale: u.locale,
    plan: u.plan,
    plan_until: u.plan_until,
    plan_active: pi.active,
    plan_days_left: pi.days_left,
    plan_expired: !!pi.expired,
    premium: pi.premium,
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
    // Best-effort renewal reminders (7/3/1 days before a Pro plan ends).
    await syncPlanReminders(user);
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

  // Expired Pro plans lose the unlimited chats too.
  if (!planInfo(req.user).premium) {
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

// ===== LifeOS Challenge Arena (120 missions) =====
// 4 stages: Seed (1-20) → Risk (21-50) → Beast (51-85) → Legend (86-120).
// Pro unlocks the full track + 2x points + 3 helper tools (coach, swap, stats).
// Life adds an endless mode after day 120. Proof is text-only and gets reviewed
// before points are counted. Categories: action, social, creative, brain,
// physical, laugh, freeze, film.

const CH_TOTAL = 120;
const CH_FREE_DAYS = parseInt(process.env.CH_FREE_DAYS || '10', 10);
const CH_MILESTONES = { 7: 20, 14: 30, 21: 40, 30: 60, 40: 80, 50: 100, 60: 120, 75: 150, 85: 180, 100: 220, 110: 260, 120: 350 };

function chStage(day) {
  if (day <= 20) return { key: 'seed', start: 1, end: 20, name_en: 'Seed', name_ar: 'البذرة', color: '#34d399' };
  if (day <= 50) return { key: 'risk', start: 21, end: 50, name_en: 'Risk', name_ar: 'المخاطرة', color: '#c084fc' };
  if (day <= 85) return { key: 'beast', start: 51, end: 85, name_en: 'Beast', name_ar: 'الوحش', color: '#fbbf24' };
  return { key: 'legend', start: 86, end: 120, name_en: 'Legend', name_ar: 'الأسطورة', color: '#f472b6' };
}

const CH_TYPE = {
  action: { en: 'Action', ar: 'حركي' },
  social: { en: 'Social', ar: 'اجتماعي' },
  creative: { en: 'Creative', ar: 'إبداعي' },
  brain: { en: 'Brain', ar: 'ذكاء' },
  physical: { en: 'Physical', ar: 'جسدي' },
  laugh: { en: 'No-Laugh', ar: 'بدون ضحك' },
  freeze: { en: 'Freeze/Glitch', ar: 'تجمّد/جليتش' },
  film: { en: 'Improv', ar: 'تمثيل' },
};

function chType(t) { return CH_TYPE[t] || CH_TYPE.action; }

// ---- Seed (1-20): warm, funny, energizing ----
const CH_SEED = [
  { en: 'Freeze like a statue for 10 seconds in a public place.', ar: 'تجمّد كتمثال ١٠ ثوانٍ في مكان عام.', type: 'freeze', timer: 10 },
  { en: 'Walk in a straight line for 20 metres without looking back.', ar: 'امشِ بخط مستقيم ٢٠ متراً دون أن تلتفت.', type: 'action', timer: 20 },
  { en: 'Do the "NPC Walk" — stiff, robot-like walking for 15 seconds.', ar: 'اعمل "مشية NPC" — مشية جامدة كالروبوت ١٥ ثانية.', type: 'action', timer: 15 },
  { en: 'Say a funny sentence to someone near you without laughing.', ar: 'قل جملة مضحكة لشخص قريب منك دون أن تضحك.', type: 'laugh' },
  { en: 'Make your bed the moment you wake up — no delays.', ar: 'رتّب سريرك لحظة استيقاظك — بلا تأجيل.', type: 'action' },
  { en: 'Drink a big glass of water and name one real benefit aloud.', ar: 'اشرب كوب ماء كبير واذكر فائدة حقيقية بصوت عالٍ.', type: 'physical' },
  { en: 'Do 10 jumping jacks before breakfast.', ar: 'اعمل ١٠ نطّات قفز قبل الفطور.', type: 'physical', timer: 30 },
  { en: 'Write your #1 goal in one sentence and read it out loud.', ar: 'اكتب هدفك الأول بجملة واحدة واقرأه بصوت عالٍ.', type: 'creative' },
  { en: 'Plan the next 7 days in 10 minutes.', ar: 'خطط الأيام السبعة القادمة في ١٠ دقائق.', type: 'brain', timer: 600 },
  { en: 'Say 3 things you are proud of. Out loud.', ar: 'قل ٣ أشياء تفتخر بها. بصوت عالٍ.', type: 'creative' },
  { en: 'Balance a pen on the back of your hand for 20 seconds.', ar: 'وازن قلماً على ظهر يدك ٢٠ ثانية.', type: 'physical', timer: 20 },
  { en: 'Walk 10 steps backwards in a clear, safe space.', ar: 'امشِ ١٠ خطوات إلى الخلف في مكان آمن وخالٍ.', type: 'action', timer: 30 },
  { en: 'Name 10 objects around you in 15 seconds.', ar: 'اذكر ١٠ أشياء حولك خلال ١٥ ثانية.', type: 'brain', timer: 15 },
  { en: 'Smile at 3 different people today and note their reaction.', ar: 'ابتسم لثلاثة أشخاص اليوم ولاحظ ردة فعلهم.', type: 'social' },
  { en: 'Do 10 squats right now, without stopping.', ar: 'اعمل ١٠ سكوات الآن دون توقف.', type: 'physical', timer: 45 },
  { en: 'Send a kind message to someone you have not talked to in a week.', ar: 'أرسل رسالة لطيفة لشخص لم تكلمه منذ أسبوع.', type: 'social' },
  { en: 'Draw a tiny doodle of your mood in under a minute.', ar: 'ارسم رسماً صغيراً يعبّر عن مزاجك في أقل من دقيقة.', type: 'creative', timer: 60 },
  { en: 'Hold a plank for 20 seconds with good form.', ar: 'ثبّت على وضعية البلانك ٢٠ ثانية بشكل صحيح.', type: 'physical', timer: 20 },
  { en: 'Estimate 30 seconds in your head, then check with a timer.', ar: 'قدّر ٣٠ ثانية في رأسك ثم قارنها بالمؤقت.', type: 'brain', timer: 30 },
  { en: 'Organize one small drawer or corner in 5 minutes.', ar: 'رتّب درجاً صغيراً أو زاوية واحدة خلال ٥ دقائق.', type: 'action', timer: 300 },
];

// ---- Risk (21-50): funnier, faster, braver ----
const CH_RISK = [
  { en: 'Do a "Glitch Walk" for 10 seconds like a broken video-game character.', ar: 'اعمل "مشية جليتش" ١٠ ثوانٍ كشخصية لعبة معطوبة.', type: 'freeze', timer: 10 },
  { en: 'Watch a funny video for 60 seconds without laughing.', ar: 'شاهد فيديو مضحك ٦٠ ثانية دون أن تضحك.', type: 'laugh', timer: 60 },
  { en: 'Let a friend try to make you laugh for 30 seconds. You cannot laugh.', ar: 'دع صديقك يحاول إضحاكك ٣٠ ثانية. ممنوع تضحك.', type: 'laugh', timer: 30 },
  { en: 'Tell your friend a joke without laughing yourself.', ar: 'حاول قول نكتة لصديقك دون أن تضحك أنت.', type: 'laugh' },
  { en: 'Lip-sync a famous song silently.', ar: 'قلّد أغنية مشهورة بدون صوت.', type: 'film', timer: 45 },
  { en: 'Lip-sync a super-fast song.', ar: 'اعمل Lip Sync لأغنية سريعة.', type: 'film', timer: 45 },
  { en: 'Lip-sync a song in a language you do not know.', ar: 'اعمل Lip Sync لأغنية بلغة لا تعرفها.', type: 'film', timer: 45 },
  { en: 'Solve a simple riddle in 60 seconds.', ar: 'حل لغزاً بسيطاً خلال ٦٠ ثانية.', type: 'brain', timer: 60 },
  { en: 'Solve a simple math riddle in 45 seconds.', ar: 'حل لغزاً رياضياً بسيطاً خلال ٤٥ ثانية.', type: 'brain', timer: 45 },
  { en: 'Solve a logic riddle in 30 seconds.', ar: 'حل لغزاً منطقياً خلال ٣٠ ثانية.', type: 'brain', timer: 30 },
  { en: 'Arrange 5 objects in 20 seconds.', ar: 'رتّب ٥ أغراض خلال ٢٠ ثانية.', type: 'brain', timer: 20 },
  { en: 'Say 10 words starting with the same letter in 30 seconds.', ar: 'قل ١٠ كلمات تبدأ بنفس الحرف خلال ٣٠ ثانية.', type: 'brain', timer: 30 },
  { en: 'Do 15 jumping jacks in 20 seconds.', ar: 'اعمل ١٥ Jumping Jacks خلال ٢٠ ثانية.', type: 'physical', timer: 20 },
  { en: 'Balance one small object on your finger for 10 seconds.', ar: 'وازن غرضاً صغيراً على إصبعك ١٠ ثوانٍ.', type: 'physical', timer: 10 },
  { en: 'Balance two objects at the same time.', ar: 'وازن غرضين في نفس الوقت.', type: 'physical', timer: 15 },
  { en: 'Toss a small paper into a bin from a short distance.', ar: 'ارمِ ورقة صغيرة في سلة من مسافة قصيرة.', type: 'action' },
  { en: 'Toss the paper into the bin from 3 metres away.', ar: 'ارمِ الورقة في السلة من مسافة ٣ أمتار.', type: 'action', timer: 30 },
  { en: 'Run across the room in slow motion for 10 seconds.', ar: 'اجري عبر الغرفة بحركة بطيئة لمدة ١٠ ثوانٍ.', type: 'action', timer: 10 },
  { en: 'Talk to a plant (or an object) for 20 seconds like it is your best friend.', ar: 'كلم نبتة (أو غرضاً) ٢٠ ثانية وكأنه أعز أصدقائك.', type: 'film', timer: 20 },
  { en: 'Announce your day plan like a news anchor for 30 seconds.', ar: 'قدّم خطة يومك كمذيع أخبار لمدة ٣٠ ثانية.', type: 'film', timer: 30 },
  { en: 'Hold eye contact with yourself in the mirror for 30 seconds without laughing.', ar: 'ثبّت النظر في عينيك أمام المرآة ٣٠ ثانية دون ضحك.', type: 'laugh', timer: 30 },
  { en: 'Sing "Happy Birthday" in a dramatic opera voice.', ar: 'غنِّ "سنة حلوة" بصوت أوبرالي درامي.', type: 'film', timer: 20 },
  { en: 'Count backwards from 30 in under 25 seconds.', ar: 'عُد من ٣٠ إلى ١ في أقل من ٢٥ ثانية.', type: 'brain', timer: 25 },
  { en: 'Do 20 wall push-ups without stopping.', ar: 'اعمل ٢٠ ضغطة على الحائط دون توقف.', type: 'physical', timer: 60 },
  { en: 'Spin a pen (or any object) continuously for 10 seconds.', ar: 'أدر قلماً (أو أي غرض) باستمرار ١٠ ثوانٍ.', type: 'creative', timer: 10 },
  { en: 'Give a 20-second weather report about your room.', ar: 'قدّم نشرة طقس لمدة ٢٠ ثانية عن غرفتك.', type: 'film', timer: 20 },
  { en: 'Type the full alphabet on your phone in under 15 seconds.', ar: 'اكتب الأبجدية كاملة على هاتفك في أقل من ١٥ ثانية.', type: 'brain', timer: 15 },
  { en: 'Walk like a penguin for 15 metres.', ar: 'امشِ مشية البطريق ١٥ متراً.', type: 'action', timer: 30 },
  { en: 'Say a tongue twister 3 times fast without messing up.', ar: 'قل جملة صعبة اللسان ٣ مرات بسرعة دون خطأ.', type: 'creative', timer: 30 },
  { en: 'Write a funny 4-line poem about your fridge.', ar: 'اكتب قصيدة مضحكة من ٤ أسطر عن ثلاجتك.', type: 'creative', timer: 120 },
];

// ---- Beast (51-85): hard, public, hilarious ----
const CH_BEAST = [
  { en: 'Freeze for 20 seconds in a crowded place.', ar: 'تجمّد ٢٠ ثانية في مكان مزدحم.', type: 'freeze', timer: 20 },
  { en: 'Toss the paper into the bin from a far distance.', ar: 'ارمِ الورقة في السلة من مسافة بعيدة.', type: 'action' },
  { en: 'Toss the paper from behind your back.', ar: 'ارمِ الورقة من خلف ظهرك.', type: 'action' },
  { en: 'Sing a full verse of a song with a straight face.', ar: 'غنِّ مقطعاً كاملاً بأغنية بوجه ثابت.', type: 'film', timer: 30 },
  { en: 'Give a 20-second motivational speech to an imaginary audience.', ar: 'ألقِ خطاباً تحفيزياً ٢٠ ثانية لجمهور خيالي.', type: 'film', timer: 20 },
  { en: 'Act out a movie scene for 30 seconds using only your face.', ar: 'مثّل مشهداً سينمائياً ٣٠ ثانية بوجهك فقط.', type: 'film', timer: 30 },
  { en: 'Do 25 squats in 45 seconds.', ar: 'اعمل ٢٥ سكوات في ٤٥ ثانية.', type: 'physical', timer: 45 },
  { en: 'Recite the alphabet backwards in 30 seconds.', ar: 'قل الأبجدية بالعكس خلال ٣٠ ثانية.', type: 'brain', timer: 30 },
  { en: 'Count from 50 to 1 in under 40 seconds.', ar: 'عُد من ٥٠ إلى ١ في أقل من ٤٠ ثانية.', type: 'brain', timer: 40 },
  { en: 'Memory test: memorize 7 random words in 60s, then repeat them.', ar: 'اختبار ذاكرة: احفظ ٧ كلمات عشوائية في ٦٠ ثانية ثم أعدها.', type: 'brain', timer: 60 },
  { en: 'Destroy the "to-do later" list: complete one task you have avoided for a week.', ar: 'أنهِ مهمة تؤجلها منذ أسبوع.', type: 'action' },
  { en: 'Compliment 3 different people genuinely, looking them in the eye.', ar: 'أعطِ ٣ إطراءات صادقة لثلاثة أشخاص وأنت تنظر في أعينهم.', type: 'social' },
  { en: 'Do 10 "walk of shame" steps in public without a smile.', ar: 'اعمل ١٠ خطوات "مشية إحراج" في مكان عام دون ابتسامة.', type: 'freeze', timer: 15 },
  { en: 'Perform a 10-second horror "glitch" sound with your voice.', ar: 'أدّي صوت "جليتش" مرعب بصوتك لمدة ١٠ ثوانٍ.', type: 'film', timer: 10 },
  { en: 'Do 30 seconds of robot dance in public.', ar: 'أدّي رقصة روبوت ٣٠ ثانية في مكان عام.', type: 'action', timer: 30 },
  { en: 'Whisper everything you say for 2 full minutes.', ar: 'تهامس بكل ما تقوله لمدة دقيقتين كاملتين.', type: 'social', timer: 120 },
  { en: 'Do 15 push-ups without stopping.', ar: 'اعمل ١٥ ضغطة دون توقف.', type: 'physical', timer: 90 },
  { en: '"Serve" a snack to someone like a fancy waiter, with a full announcement.', ar: '"قدّم" وجبة خفيفة لأحد كنادل راقٍ مع إعلان كامل.', type: 'film', timer: 45 },
  { en: 'Watch 2 funny videos back to back with a straight face.', ar: 'شاهد فيديوهين مضحكين متتاليين بوجه ثابت.', type: 'laugh', timer: 120 },
  { en: 'Keep a serious face while a friend says random words for 45 seconds.', ar: 'حافظ على وجه جدي بينما يقول صديقك كلمات عشوائية ٤٥ ثانية.', type: 'laugh', timer: 45 },
  { en: 'Solve 3 riddles in under 3 minutes.', ar: 'حل ٣ ألغاز في أقل من ٣ دقائق.', type: 'brain', timer: 180 },
  { en: 'Memorize a 10-digit number, then recite it after 2 minutes.', ar: 'احفظ رقماً من ١٠ خانات ثم أعده بعد دقيقتين.', type: 'brain', timer: 120 },
  { en: 'Do walking lunges across the whole room.', ar: 'اعمل تمرين الطعن (Lunges) عبر الغرفة كاملة.', type: 'physical', timer: 60 },
  { en: 'Speak only in rhymes for 60 seconds.', ar: 'تحدث بالقافية فقط لمدة ٦٠ ثانية.', type: 'creative', timer: 60 },
  { en: 'Give someone a genuine compliment about something not obvious.', ar: 'أعطِ أحدهم إطراءً صادقاً عن شيء غير واضح فيه.', type: 'social' },
  { en: 'Freeze mid-step on a street or staircase for 15 seconds.', ar: 'تجمّد في منتصف خطوة على الشارع أو الدرج ١٥ ثانية.', type: 'freeze', timer: 15 },
  { en: "Narrate someone's actions like a sports commentator for 30 seconds.", ar: 'علّق على تصرفات أحدهم كمعلّق رياضي ٣٠ ثانية.', type: 'film', timer: 30 },
  { en: 'Balance a book on your head for 60 seconds while standing still.', ar: 'وازن كتاباً على رأسك ٦٠ ثانية وأنت واقف بلا حركة.', type: 'physical', timer: 60 },
  { en: 'Hold a plank for a full 60 seconds.', ar: 'ثبّت على البلانك ٦٠ ثانية كاملة.', type: 'physical', timer: 60 },
  { en: 'Draw a portrait of a friend in 90 seconds, then show it to them.', ar: 'ارسم بورتريه لصديقك في ٩٠ ثانية ثم أرِه إياه.', type: 'creative', timer: 90 },
  { en: 'Invent a new handshake and teach it to someone.', ar: 'اخترع مصافحة جديدة وعلّمها لأحد.', type: 'social', timer: 60 },
  { en: 'Call a friend and speak only in questions for 60 seconds.', ar: 'اتصل بصديق وتحدث بالأسئلة فقط ٦٠ ثانية.', type: 'social', timer: 60 },
  { en: 'Perform a dramatic 30-second movie death scene.', ar: 'أدّي مشهد موت سينمائياً درامياً لمدة ٣٠ ثانية.', type: 'film', timer: 30 },
  { en: 'Say the months of the year backwards in 20 seconds.', ar: 'قل أشهر السنة بالعكس خلال ٢٠ ثانية.', type: 'brain', timer: 20 },
  { en: 'Lip-sync a full chorus with full performance moves.', ar: 'قلّد مقطعاً كاملاً من أغنية مع حركات أداء كاملة.', type: 'film', timer: 60 },
];

// ---- Legend (86-120+): the real bosses (also powers the endless mode) ----
const CH_LEGEND = [
  { en: 'Do the frozen "Mannequin Challenge" with 2 people for 30 seconds.', ar: 'اعمل تحدي "الدمية" مع شخصين لمدة ٣٠ ثانية.', type: 'freeze', timer: 30 },
  { en: 'Walk through a busy street with a fully straight face, 30 seconds.', ar: 'امشِ في شارع مزدحم بوجه ثابت تماماً، ٣٠ ثانية.', type: 'freeze', timer: 30 },
  { en: 'Hold a 30-second serious interview with an imaginary reporter.', ar: 'أجرِ مقابلة جدية ٣٠ ثانية مع مراسل خيالي.', type: 'film', timer: 30 },
  { en: 'Do 50 jumping jacks in 60 seconds.', ar: 'اعمل ٥٠ نطة قفز في ٦٠ ثانية.', type: 'physical', timer: 60 },
  { en: 'Balance a book on your head while walking 10 steps.', ar: 'وازن كتاباً على رأسك وأنت تمشي ١٠ خطوات.', type: 'physical', timer: 30 },
  { en: 'Memorize a 12-word sentence and repeat it perfectly after 2 minutes.', ar: 'احفظ جملة من ١٢ كلمة وكررها بإتقان بعد دقيقتين.', type: 'brain', timer: 120 },
  { en: 'Solve a 5-piece jigsaw-style logic puzzle in 90 seconds (use anything).', ar: 'حل لغزاً منطقياً من ٥ قطع في ٩٠ ثانية.', type: 'brain', timer: 90 },
  { en: 'Public improv: make a stranger believe your "tiny fact".', ar: 'ارتجال علني: اجعل غريباً يصدّق "حقيقة صغيرة" لديك.', type: 'social' },
  { en: 'Do a 45-second silent comedy scene with zero words.', ar: 'أدّي مشهداً كوميدياً ٤٥ ثانية بدون أي كلمة.', type: 'film', timer: 45 },
  { en: 'Give someone a sincere, detailed thank-you — 30 seconds.', ar: 'قدّم شكراً صادقاً ومفصّلاً لشخص — ٣٠ ثانية.', type: 'social', timer: 30 },
  { en: 'Do the "Zombie Walk" with a friend for 20 seconds without laughing.', ar: 'اعمل "مشية زامبي" مع صديق ٢٠ ثانية دون ضحك.', type: 'freeze', timer: 20 },
  { en: 'Recreate 3 famous poses in 60 seconds (in your own style).', ar: 'أعد تمثيل ٣ أوضاع شهيرة في ٦٠ ثانية.', type: 'film', timer: 60 },
  { en: 'Win a tiny personal battle: 30 push-ups or a 100 m sprint — then describe it.', ar: 'اربح معركتك الصغيرة: ٣٠ ضغطة أو ركض ١٠٠ متر — ثم صف ما حصل.', type: 'physical', timer: 120 },
  { en: 'Do a 60-second "worst advice ever" motivational speech.', ar: 'ألقِ خطاباً تحفيزياً بـ"أسوأ نصيحة بالتاريخ" لمدة ٦٠ ثانية.', type: 'film', timer: 60 },
  { en: 'Hold your breath for 15 seconds at the end of a funny act.', ar: 'احبس نفسك ١٥ ثانية في نهاية مشهد مضحك.', type: 'action', timer: 15 },
  { en: 'Do a 90-second silent "marathon" of 5 mini-tasks (balance, freeze, sing-whisper, robot, comedy pose).', ar: 'أدِّ "ماراثوناً" صامتاً ٩٠ ثانية من ٥ مهام صغيرة.', type: 'film', timer: 90 },
  { en: 'Freeze like a statue for a full 60 seconds in a public place.', ar: 'تجمّد كتمثال ٦٠ ثانية كاملة في مكان عام.', type: 'freeze', timer: 60 },
  { en: 'No-laugh marathon: 3 minutes of funny videos, zero laughter.', ar: 'ماراثون بلا ضحك: ٣ دقائق من فيديوهات مضحكة وبدون أي ضحكة.', type: 'laugh', timer: 180 },
  { en: 'Do 100 jumping jacks without stopping.', ar: 'اعمل ١٠٠ نطة قفز دون توقف.', type: 'physical', timer: 240 },
  { en: 'Talk to a stranger for 60 seconds about the weather, then thank them.', ar: 'تحدث مع شخص غريب ٦٠ ثانية عن الطقس ثم اشكره.', type: 'social', timer: 60 },
  { en: 'Perform a full song with choreography in front of a friend.', ar: 'أدِّ أغنية كاملة مع رقصة أمام صديق.', type: 'film', timer: 150 },
  { en: 'Memorize 10 objects on a table, look away, then list them all.', ar: 'احفظ ١٠ أشياء على الطاولة، ارفع نظرك عنها، ثم اذكرها كلها.', type: 'brain', timer: 120 },
  { en: 'Stack and balance 3 objects for 15 seconds.', ar: 'كوّم ووازن ٣ أشياء فوق بعضها لمدة ١٥ ثانية.', type: 'physical', timer: 15 },
  { en: 'Give a 2-minute serious speech about "why pigeons are underrated".', ar: 'ألقِ خطاباً جدياً لمدة دقيقتين عن "لماذا الحمام مظلوم".', type: 'film', timer: 120 },
  { en: 'Walk 100 metres in slow motion in public.', ar: 'امشِ ١٠٠ متر بحركة بطيئة أمام الناس.', type: 'action', timer: 180 },
  { en: 'Solve a bigger puzzle (or 3 hard riddles) in under 4 minutes.', ar: 'حل لغزاً أكبر (أو ٣ ألغاز صعبة) في أقل من ٤ دقائق.', type: 'brain', timer: 240 },
  { en: 'Hold a 2-minute conversation without saying "I", "me", or "my".', ar: 'أجرِ محادثة لمدة دقيقتين دون قول "أنا" أو "لي" أو "عندي".', type: 'social', timer: 120 },
  { en: 'Write and perform a 4-line rap about your day.', ar: 'اكتب وأدِّ راب من ٤ أسطر عن يومك.', type: 'creative', timer: 120 },
  { en: 'Hold a plank for 2 full minutes.', ar: 'ثبّت على البلانك دقيقتين كاملتين.', type: 'physical', timer: 120 },
  { en: 'Teach someone a skill you know in 60 seconds.', ar: 'علّم أحدهم مهارة تتقنها في ٦٠ ثانية.', type: 'social', timer: 60 },
  { en: 'Imitate an animal for 30 seconds in public.', ar: 'قلّد حيواناً لمدة ٣٠ ثانية أمام الناس.', type: 'freeze', timer: 30 },
  { en: 'Do 50 squats in 90 seconds.', ar: 'اعمل ٥٠ سكوات في ٩٠ ثانية.', type: 'physical', timer: 90 },
  { en: 'Say 20 words from one category in 30 seconds.', ar: 'قل ٢٠ كلمة من فئة واحدة خلال ٣٠ ثانية.', type: 'brain', timer: 30 },
  { en: 'Dramatically read an ingredients label like a movie trailer.', ar: 'اقرأ قائمة المكونات بدراما كإعلان فيلم سينمائي.', type: 'film', timer: 30 },
  { en: 'Complete a "perfect hour": move, tidy, learn, hydrate — then describe it.', ar: 'أنجز "ساعة مثالية": حركة، ترتيب، تعلّم، ماء — ثم صفها.', type: 'action', timer: 3600 },
];

function chPoolFor(day) {
  const s = chStage(day).key;
  if (s === 'seed') return CH_SEED;
  if (s === 'risk') return CH_RISK;
  if (s === 'beast') return CH_BEAST;
  return CH_LEGEND; // legend also powers the endless mode (Life plan)
}

// Deterministic per-user rotation: every player cycles the whole pool of a
// stage in their own order (no repeats inside a stage). swapOffset shifts the
// pick so a swapped day shows a different mission from the same pool.
function chTaskFor(day, userId, lang, swapOffset = 0) {
  const pool = chPoolFor(day);
  const stage = chStage(day);
  const inStage = day - stage.start;
  const seed = (Number(userId) * 7 + 13) % pool.length;
  const idx = ((inStage + seed + Number(swapOffset || 0) * 7) % pool.length + pool.length) % pool.length;
  const item = pool[idx];
  const type = chType(item.type);
  return {
    day,
    tier: stage.key,
    stage,
    type: item.type,
    type_name: lang === 'ar' ? type.ar : type.en,
    timer: item.timer || null,
    text: lang === 'ar' ? item.ar : item.en,
  };
}

function chSwapOffset(u, day) {
  try {
    const sw = u.ch_swap ? JSON.parse(u.ch_swap) : null;
    if (sw && Number(sw.day) === Number(day)) return Number(sw.offset) || 0;
  } catch (e) {}
  return 0;
}

function chReward(day, streak, premium) {
  const mult = premium ? 2 : 1;
  const base = (10 + Math.min(streak, 10)) * mult;
  const milestone = (CH_MILESTONES[day] || 0) * mult;
  const total = base + milestone;
  return { base, milestone, total, bonus: streak > 1 ? `+${Math.min(streak, 10) * mult} streak` : null };
}

app.get('/api/challenge', auth, async (req, res) => {
  const u = req.user;
  const pi = planInfo(u);
  const started = !!u.challenge_start;
  const day = u.challenge_day || 0;
  const lang = req.query.lang || u.locale || 'en';
  const logs = await db.all('SELECT day_number, status, note, created_at FROM challenge_logs WHERE user_id = ? ORDER BY day_number ASC', [u.id]);
  const lifeEndless = pi.plan === 'life';
  const finishedTrack = !!(u.challenge_completed && day >= CH_TOTAL && !lifeEndless);
  const unlocked = pi.premium || day < CH_FREE_DAYS;
  const canContinue = started && !finishedTrack && unlocked;
  const nextDay = day + 1;
  const task = canContinue ? chTaskFor(nextDay, u.id, lang, chSwapOffset(u, nextDay)) : null;
  res.json({
    started,
    completed: finishedTrack,
    streak: u.challenge_streak || 0,
    points: u.challenge_points || 0,
    day, today: nextDay, task, logs,
    plan: u.plan || 'free', total: CH_TOTAL,
    premium: pi.premium, multiplier: pi.premium ? 2 : 1,
    canContinue,
    needUpgrade: started && !unlocked && !finishedTrack,
    endless: lifeEndless && day >= CH_TOTAL,
    plan_days_left: pi.days_left,
    stage: task ? task.stage : chStage(Math.min(nextDay, CH_TOTAL)),
    all_stages: ['seed', 'risk', 'beast', 'legend'],
    categories: Object.values(CH_TYPE),
    reward: task ? chReward(nextDay, (u.challenge_streak || 0) + 1, pi.premium) : null,
    share_text: started
      ? `Day ${nextDay}${lifeEndless ? '' : '/' + CH_TOTAL} · ${task ? task.stage.name_en : 'Legend'} on Jibāl Al-Ḥayāt 🏔️ #تحديات #ChallengeArena`
      : 'I just joined Jibāl Al-Ḥayāt 🏔️ — real-life challenges. I dare you to do it. #ChallengeArena #تحديات',
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

// Proof review: the player's text proof is checked against the challenge, then
// a verdict (approved / retry) + feedback is returned. No media upload needed.
app.post('/api/challenge/validate-proof', auth, async (req, res) => {
  const u = req.user;
  const note = String((req.body && req.body.note) || '');
  const taskText = String((req.body && req.body.task_text) || '');
  const locale = (req.body && req.body.locale) || u.locale || 'en';
  if (!note.trim()) return res.json({ approved: false, feedback: locale === 'ar' ? 'اكتب إثباتاً قصيراً أولاً.' : 'Write a short proof first.' });
  if (note.trim().length < 12) return res.json({ approved: false, feedback: locale === 'ar' ? 'الإثبات قصير جداً. أضف تفاصيل أكثر.' : 'Proof is too short. Add a bit more detail.' });
  const verdict = await ai.validateChallengeProof({ user: u, task: taskText, proof: note, locale });
  res.json(verdict);
});

app.post('/api/challenge/checkin', auth, async (req, res) => {
  const u = req.user;
  const pi = planInfo(u);
  const day = (u.challenge_day || 0) + 1;
  const lifeEndless = pi.plan === 'life';
  if (day > CH_FREE_DAYS && !pi.premium) {
    return res.status(402).json({ error: 'upgrade_required', message: 'Subscription required to keep climbing.' });
  }
  if (day > CH_TOTAL && !lifeEndless) return res.status(400).json({ error: 'done' });
  const doneToday = await db.get('SELECT id FROM challenge_logs WHERE user_id = ? AND day_number = ? AND status = ?', [u.id, day, 'done']);
  if (doneToday) return res.status(400).json({ error: 'already_checked' });
  const note = (req.body && req.body.note || '').toString().slice(0, 400);
  const aiApproved = !!(req.body && req.body.ai_approved);
  const taskType = CH_TYPE[req.body && req.body.task_type] ? req.body.task_type : null;
  const reward = chReward(day, (u.challenge_streak || 0) + 1, pi.premium);
  await db.run(
    'INSERT INTO challenge_logs (user_id, day_number, status, note, ai_approved, task_type, points) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [u.id, day, 'done', note, aiApproved ? 1 : 0, taskType, reward.total]
  );
  const completed = day >= CH_TOTAL ? 1 : 0;
  const points = (u.challenge_points || 0) + reward.total;
  const streak = (u.challenge_streak || 0) + 1;
  await db.run('UPDATE users SET challenge_day = ?, challenge_points = ?, challenge_streak = ?, challenge_completed = ? WHERE id = ?', [day, points, streak, completed, u.id]);
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  const nextDay = day + 1;
  const nextUnlocked = pi.premium || nextDay <= CH_FREE_DAYS;
  const nextTask = (nextDay > CH_TOTAL && !lifeEndless) || !nextUnlocked
    ? null
    : chTaskFor(nextDay, u.id, u.locale, chSwapOffset(fresh, nextDay));
  res.json({
    ok: true, reward,
    challenge: { day: fresh.challenge_day, points: fresh.challenge_points, streak: fresh.challenge_streak, completed: !!fresh.challenge_completed },
    task: nextTask,
    needUpgrade: !nextUnlocked && nextDay <= CH_TOTAL,
  });
});

app.post('/api/challenge/skip', auth, async (req, res) => {
  const u = req.user;
  const pi = planInfo(u);
  const day = (u.challenge_day || 0) + 1;
  if (day > CH_TOTAL && pi.plan !== 'life') return res.status(400).json({ error: 'done' });
  await db.run('INSERT INTO challenge_logs (user_id, day_number, status, note) VALUES (?, ?, ?, ?)', [u.id, day, 'skipped', 'skipped']);
  await db.run('UPDATE users SET challenge_day = ?, challenge_streak = 0 WHERE id = ?', [day, u.id]);
  const fresh = await db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  res.json({ ok: true, challenge: { day: fresh.challenge_day, streak: fresh.challenge_streak, points: fresh.challenge_points } });
});

// ===== Premium helper #1: coach tips for today's challenge =====
app.post('/api/challenge/coach', auth, async (req, res) => {
  const pi = planInfo(req.user);
  if (!pi.premium) return res.status(402).json({ error: 'premium_required' });
  const u = req.user;
  const day = (u.challenge_day || 0) + 1;
  if (day > CH_TOTAL && pi.plan !== 'life') return res.status(400).json({ error: 'done' });
  const task = chTaskFor(day, u.id, u.locale || 'en', chSwapOffset(u, day));
  const out = await ai.challengeCoach({ user: u, task: task.text, locale: u.locale === 'ar' ? 'ar' : 'en' });
  res.json(out);
});

// ===== Premium helper #2: swap today's challenge for another one =====
app.post('/api/challenge/swap', auth, async (req, res) => {
  const u = req.user;
  const pi = planInfo(u);
  if (!pi.premium) return res.status(402).json({ error: 'premium_required' });
  if (!u.challenge_start) return res.status(400).json({ error: 'not_started' });
  const day = (u.challenge_day || 0) + 1;
  if (day > CH_TOTAL && pi.plan !== 'life') return res.status(400).json({ error: 'done' });
  let sw = {};
  try { sw = u.ch_swap ? JSON.parse(u.ch_swap) : {}; } catch (e) {}
  if (Number(sw.day) !== day) sw = { day, offset: 0 };
  sw.offset = (Number(sw.offset) || 0) + 1;
  await db.run('UPDATE users SET ch_swap = ? WHERE id = ?', [JSON.stringify(sw), u.id]);
  const task = chTaskFor(day, u.id, u.locale || 'en', sw.offset);
  res.json({ ok: true, task, reward: chReward(day, (u.challenge_streak || 0) + 1, pi.premium) });
});

// ===== Premium helper #3: advanced stats =====
app.get('/api/challenge/stats', auth, async (req, res) => {
  const pi = planInfo(req.user);
  if (!pi.premium) return res.status(402).json({ error: 'premium_required' });
  const logs = await db.all(
    'SELECT day_number, status, ai_approved, task_type, points, created_at FROM challenge_logs WHERE user_id = ? ORDER BY day_number ASC',
    [req.user.id]
  );
  const done = logs.filter(l => l.status === 'done');
  const byCategory = {};
  for (const l of done) {
    const k = l.task_type || 'other';
    if (!byCategory[k]) byCategory[k] = { done: 0, points: 0 };
    byCategory[k].done += 1;
    byCategory[k].points += l.points || 0;
  }
  const approved = done.filter(l => l.ai_approved).length;
  let best = 0, run = 0, prev = 0;
  for (const l of done) {
    run = (l.day_number === prev + 1) ? run + 1 : 1;
    prev = l.day_number;
    if (run > best) best = run;
  }
  res.json({
    total_done: done.length,
    total_points_earned: done.reduce((s, l) => s + (l.points || 0), 0),
    approval_rate: done.length ? Math.round((approved / done.length) * 100) : 0,
    best_streak: best,
    current_streak: req.user.challenge_streak || 0,
    by_category: byCategory,
    recent: done.slice(-8).reverse().map(l => ({ day: l.day_number, type: l.task_type, points: l.points, approved: !!l.ai_approved, at: l.created_at })),
  });
});

// ===== leaderboard (everyone can see it; drives the competition) =====
app.get('/api/leaderboard', auth, async (req, res) => {
  const top = await db.all(
    'SELECT name, challenge_points, challenge_streak, challenge_day FROM users WHERE challenge_start IS NOT NULL AND challenge_points > 0 ORDER BY challenge_points DESC, challenge_day DESC LIMIT 10'
  );
  const meRow = await db.get('SELECT COUNT(*) n FROM users WHERE challenge_points > ?', [req.user.challenge_points || 0]);
  res.json({
    top: top.map((r, i) => ({
      rank: i + 1,
      name: (String(r.name || 'Player').trim().split(/\s+/)[0] || 'Player').slice(0, 16),
      points: r.challenge_points,
      streak: r.challenge_streak,
      day: r.challenge_day,
    })),
    my_points: req.user.challenge_points || 0,
    my_rank: (meRow && Number(meRow.n) ? Number(meRow.n) : 0) + 1,
  });
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
    let until = '2999-12-31'; // Life (one-time) and legacy boost20 = lifetime
    if (payment.plan === 'pro') {
      // Monthly subscription: renewals stack on top of the remaining time.
      const buyer = await db.get('SELECT plan_until FROM users WHERE id = ?', [payment.user_id]);
      const today = new Date().toISOString().slice(0, 10);
      const base = (buyer && buyer.plan_until && buyer.plan_until > today) ? new Date(buyer.plan_until + 'T12:00:00Z') : new Date();
      until = new Date(base.getTime() + 30 * 864e5).toISOString().slice(0, 10);
    }
    await db.run('UPDATE users SET plan = ?, plan_until = ?, plan_remind_stage = 0 WHERE id = ?', [payment.plan, until, payment.user_id]);
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
