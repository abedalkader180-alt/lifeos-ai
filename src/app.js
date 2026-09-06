require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const db = require('./db');
const ai = require('./ai');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase();
const WALLET = process.env.TRUST_WALLET_ADDRESS || 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const PRICE_PRO = parseFloat(process.env.PRICE_PRO || 9.99);
const PRICE_LIFE = parseFloat(process.env.PRICE_LIFE || 19.99);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function tokenFor(user) {
  return jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '7d' });
}

function publicUser(u) {
  const isOwner = u.email.toLowerCase() === OWNER_EMAIL;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    locale: u.locale,
    plan: u.plan,
    plan_until: u.plan_until,
    is_owner: isOwner,
  };
}

function planPrice(plan) {
  if (plan === 'pro') return PRICE_PRO;
  if (plan === 'life') return PRICE_LIFE;
  return 0;
}

async function auth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
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
  if (ai.AI_ENABLED) {
    try {
      const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${process.env.AI_API_KEY}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      reachable = r.ok;
      detail = reachable ? 'AI provider reachable.' : `Provider responded HTTP ${r.status}.`;
    } catch (e) {
      detail = `Reachability check failed: ${e.message}`;
    }
  }
  res.json({ enabled: ai.AI_ENABLED, reachable, detail, base_url: (process.env.AI_BASE_URL || '').replace(/\/$/, ''), model: ai.AI_MODEL });
});

// ===== health =====
app.get('/api/health', (req, res) => res.json({
  ok: true,
  db: db.IS_PG ? 'postgres' : 'sqlite',
  ai: ai.AI_ENABLED,
  time: new Date().toISOString(),
}));

// ===== public config =====
app.get('/api/config/public', (req, res) => {
  res.json({
    wallet_address: WALLET,
    network: 'TRC20',
    asset: 'USDT',
    prices: { pro: PRICE_PRO, life: PRICE_LIFE },
    ai_enabled: ai.AI_ENABLED,
  });
});

// ===== auth =====
function makeRefCode() {
  return 'LIFE' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.post('/api/auth/register', async (req, res) => {
  const { email, name, password, locale, ref } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, name, password required' });
  const mail = email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: 'invalid email' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short (min 6)' });
  const exists = await db.get('SELECT id FROM users WHERE email = ?', [mail]);
  if (exists) return res.status(409).json({ error: 'account already exists' });

  // Optional referral: inviter code -> ref_by + referrals row.
  let inviter = null;
  if (ref && String(ref).trim()) {
    inviter = await db.get('SELECT id, ref_code FROM users WHERE ref_code = ?', [String(ref).trim().toUpperCase()]);
  }

  const hash = bcrypt.hashSync(password, 10);
  const refCode = makeRefCode();
  const info = await db.run(
    'INSERT INTO users (email, name, password_hash, locale, plan, ref_code, ref_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [mail, name.trim(), hash, locale === 'ar' ? 'ar' : 'en', 'free', refCode, inviter ? inviter.id : null]
  );
  const user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);

  if (inviter) {
    await db.run(
      'INSERT INTO referrals (inviter_user_id, invited_email, invited_user_id, status, reward) VALUES (?, ?, ?, ?, ?)',
      [inviter.id, mail, user.id, 'pending', 'discount']
    );
  }

  res.json({ token: tokenFor(user), user: publicUser(user) });
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

app.post('/api/chat', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

  if (req.user.plan === 'free') {
    const usedToday = await db.get(
      "SELECT COUNT(*) n FROM conversations WHERE user_id = ? AND role = 'ai' AND date(created_at) = date('now')",
      [req.user.id]
    );
    if ((usedToday?.n || 0) >= 3) {
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

// ===== checkout / payments =====
app.post('/api/checkout', async (req, res) => {
  const { plan, email } = req.body || {};
  const valid = ['pro', 'life'];
  if (!valid.includes(plan)) return res.status(400).json({ error: 'invalid plan' });
  const amount = planPrice(plan);
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
    'INSERT INTO payments (user_id, email, plan, amount_usd, network, wallet_address) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [userId, email || null, plan, amount, 'TRC20', address]
  );

  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [info.lastInsertRowid]);
  const qr = await QRCode.toDataURL(address);

  res.json({
    payment_id: payment.id,
    asset: 'USDT',
    network: 'TRC20',
    address,
    amount,
    plan,
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

app.post('/api/payments/:id/claim', auth, async (req, res) => {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [req.params.id]);
  if (!payment) return res.status(404).json({ error: 'not found' });
  const { tx_hash } = req.body || {};
  if (!tx_hash || !tx_hash.trim()) return res.status(400).json({ error: 'tx_hash required' });
  await db.run('UPDATE payments SET tx_hash = ?, status = ? WHERE id = ?', [tx_hash.trim(), 'submitted', payment.id]);
  res.json({ status: 'submitted', message: 'Payment submitted. Owner will confirm it.' });
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
  });
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
