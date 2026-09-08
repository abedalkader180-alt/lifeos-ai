// ===== Database layer =====
// Automatic mode:
//   - If DATABASE_URL (or POSTGRES_URL/POSTGRESQL_URL) is defined -> PostgreSQL (for Vercel).
//   - Otherwise -> local SQLite file (for development / preview).

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || '';
// Not Vercel-specific: if DATABASE_URL exists we use Postgres.
// Else in local dev use SQLite; on cloud without DB keep a clear error.
const IS_PG = !(process.env.FORCE_SQLITE === 'true') && !!PG_URL;

let pool = null;
let sqlite = null;
let SQLITE_FILE = '';
let DB_ERROR = null;

if (IS_PG) {
  const { Pool } = require('pg');
  // Remove sslmode from the URL: we configure TLS explicitly below, which silences
  // pg's "SSL modes 'prefer', 'require', 'verify-ca' are treated as aliases" warning.
  const cleanUrl = PG_URL.replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '');
  pool = new Pool({
    connectionString: cleanUrl,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  console.log('[db] Using PostgreSQL database');
} else if (process.env.VERCEL === '1' || process.env.RENDER === 'true') {
  // Cloud without DATABASE_URL: keep app alive with a clear error (no node:sqlite import).
  DB_ERROR = 'DATABASE_URL is not set. Add it in Render/Vercel environment variables, then redeploy.';
  console.error('[db] ' + DB_ERROR);
} else {
  // Local dev/preview without DATABASE_URL: fall back to SQLite (node:sqlite).
  // Local dev/preview only. Load the built-in sqlite lazily/indirectly so
  // serverless bundlers (Vercel NCC/NFT, Node 20) never try to resolve
  // `node:sqlite` at bundle time (it does not exist on Node 20 / Vercel).
  const req = require;
  const sqliteBare = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = req(sqliteBare);
  const DATA_DIR = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  SQLITE_FILE = path.join(DATA_DIR, 'lifeos.db');
  sqlite = new DatabaseSync(SQLITE_FILE);
  // node:sqlite doesn't expose pragma(); journal/foreign_keys are acceptable defaults for dev.
  console.log('[db] Using SQLite file', SQLITE_FILE);
}

// Convert `?` placeholders (SQLite style) to `$1,$2...` (Postgres style).
function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function needDb() {
  if (DB_ERROR) throw new Error(DB_ERROR);
}
async function all(sql, params = []) {
  if (pool) {
    const r = await pool.query(pgSql(sql), params);
    return r.rows;
  }
  needDb();
  return sqlite.prepare(sql).all(...params);
}

async function get(sql, params = []) {
  if (pool) {
    const r = await pool.query(pgSql(sql), params);
    return r.rows[0] || null;
  }
  needDb();
  return sqlite.prepare(sql).get(...params);
}

async function run(sql, params = []) {
  if (pool) {
    const r = await pool.query(pgSql(sql), params);
    return {
      changes: r.rowCount || 0,
      lastInsertRowid: (r.rows && r.rows[0] && r.rows[0].id) || null,
    };
  }
  needDb();
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

// ===== schema =====
const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    plan TEXT NOT NULL DEFAULT 'free',
    plan_until TEXT,
    ref_code TEXT UNIQUE,
    ref_by INTEGER,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_code TEXT,
    verify_expires TEXT,
    verify_attempts INTEGER NOT NULL DEFAULT 0,
    life_mode TEXT NOT NULL DEFAULT 'general',
    life_profile TEXT,
    challenge_start TEXT,
    challenge_day INTEGER NOT NULL DEFAULT 0,
    challenge_streak INTEGER NOT NULL DEFAULT 0,
    challenge_points INTEGER NOT NULL DEFAULT 0,
    challenge_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    due TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target INTEGER NOT NULL DEFAULT 1,
    completed_today INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email TEXT,
    plan TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    network TEXT NOT NULL DEFAULT 'TRC20',
    wallet_address TEXT,
    tx_hash TEXT,
    coupon TEXT,
    discount_percent REAL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_user_id INTEGER,
    invited_email TEXT,
    invited_user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    reward TEXT NOT NULL DEFAULT 'discount',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    path TEXT,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS mail_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    mode TEXT,
    sent INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    mail_from TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS life_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT,
    goals TEXT,
    struggles TEXT,
    hours_per_day REAL DEFAULT 2,
    plan_json TEXT,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS challenge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'done',
    note TEXT,
    ai_approved INTEGER NOT NULL DEFAULT 0,
    task_type TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    plan TEXT NOT NULL DEFAULT 'free',
    plan_until TEXT,
    ref_code TEXT UNIQUE,
    ref_by INTEGER,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_code TEXT,
    verify_expires TEXT,
    verify_attempts INTEGER NOT NULL DEFAULT 0,
    life_mode TEXT NOT NULL DEFAULT 'general',
    life_profile TEXT,
    challenge_start TEXT,
    challenge_day INTEGER NOT NULL DEFAULT 0,
    challenge_streak INTEGER NOT NULL DEFAULT 0,
    challenge_points INTEGER NOT NULL DEFAULT 0,
    challenge_completed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    due TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS habits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target INTEGER NOT NULL DEFAULT 1,
    completed_today INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    email TEXT,
    plan TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    network TEXT NOT NULL DEFAULT 'TRC20',
    wallet_address TEXT,
    tx_hash TEXT,
    coupon TEXT,
    discount_percent REAL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    inviter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    invited_email TEXT,
    invited_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    reward TEXT NOT NULL DEFAULT 'discount',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    path TEXT,
    email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS mail_logs (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    mode TEXT,
    sent INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    mail_from TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS life_plans (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT,
    goals TEXT,
    struggles TEXT,
    hours_per_day REAL DEFAULT 2,
    plan_json TEXT,
    summary TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS challenge_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'done',
    note TEXT,
    ai_approved INTEGER NOT NULL DEFAULT 0,
    task_type TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

async function ensureColumn(table, column, ddl) {
  if (pool) {
    // pg: add if not exists
    const col = await get(`SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ?`, [table, column]);
    if (!col) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } else if (sqlite) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
}

async function initSchema() {
  if (DB_ERROR) {
    console.error('[db] initSchema skipped: ' + DB_ERROR);
    return;
  }
  if (pool) {
    await pool.query(SCHEMA_PG);
  } else if (sqlite) {
    sqlite.exec(SCHEMA_SQLITE);
  }
  // Migrate existing DBs that were created before referral fields existed.
  await ensureColumn('users', 'ref_code', 'ref_code TEXT');
  await ensureColumn('users', 'ref_by', 'ref_by INTEGER');
  await ensureColumn('users', 'email_verified', 'email_verified INTEGER DEFAULT 0');
  await ensureColumn('users', 'verify_code', 'verify_code TEXT');
  await ensureColumn('users', 'verify_expires', 'verify_expires TEXT');
  await ensureColumn('users', 'verify_attempts', 'verify_attempts INTEGER DEFAULT 0');
  await ensureColumn('users', 'life_profile', 'life_profile TEXT');
  await ensureColumn('users', 'life_mode', 'life_mode TEXT DEFAULT \'general\'');
  await ensureColumn('users', 'challenge_start', 'challenge_start TEXT');
  await ensureColumn('users', 'challenge_day', 'challenge_day INTEGER DEFAULT 0');
  await ensureColumn('users', 'challenge_streak', 'challenge_streak INTEGER DEFAULT 0');
  await ensureColumn('users', 'challenge_points', 'challenge_points INTEGER DEFAULT 0');
  await ensureColumn('users', 'challenge_completed', 'challenge_completed INTEGER DEFAULT 0');
  await ensureColumn('challenge_logs', 'ai_approved', 'ai_approved INTEGER DEFAULT 0');
  await ensureColumn('challenge_logs', 'task_type', 'task_type TEXT');
  await ensureColumn('challenge_logs', 'points', 'points INTEGER DEFAULT 0');
  await ensureColumn('users', 'plan_remind_stage', 'plan_remind_stage INTEGER DEFAULT 0');
  await ensureColumn('users', 'ch_swap', 'ch_swap TEXT');
  await ensureColumn('payments', 'coupon', 'coupon TEXT');
  await ensureColumn('payments', 'discount_percent', 'discount_percent REAL');
  await ensureColumn('payments', 'verified', 'verified INTEGER DEFAULT 0');
  // Unique index is safe on both engines and works even if column was added later.
  if (pool) {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code)');
  } else if (sqlite) {
    sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code)');
  }

  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  if (!DB_ERROR && ownerEmail && ownerPassword) {
    const exists = await get('SELECT id FROM users WHERE email = ?', [ownerEmail.toLowerCase()]);
    if (!exists) {
      const hash = bcrypt.hashSync(ownerPassword, 10);
      await run(
        'INSERT INTO users (email, name, password_hash, plan, plan_until, email_verified) VALUES (?, ?, ?, ?, ?, 1) RETURNING id',
        [ownerEmail.toLowerCase(), 'Owner', hash, 'life', '2999-12-31']
      );
      console.log('[db] Owner account created:', ownerEmail);
    }
  }
}

async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

async function listUsers() {
  return all(
    'SELECT id, email, name, locale, plan, plan_until, created_at FROM users ORDER BY id DESC'
  );
}

async function listPayments() {
  return all('SELECT * FROM payments ORDER BY id DESC');
}

async function listWaitlist() {
  return all('SELECT * FROM waitlist ORDER BY id DESC');
}

async function listReferrals() {
  return all('SELECT * FROM referrals ORDER BY id DESC');
}

async function listEvents() {
  return all('SELECT * FROM events ORDER BY id DESC');
}

async function countEvents(type) {
  const row = await get('SELECT COUNT(*) n FROM events WHERE type = ?', [type]);
  return row ? (row.n || 0) : 0;
}

async function listNotifications(userId) {
  return all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC', [userId]);
}

async function unreadNotifications(userId) {
  const row = await get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0', [userId]);
  return row ? (row.n || 0) : 0;
}

module.exports = {
  IS_PG,
  PG_URL,
  DB_ERROR,
  all,
  get,
  run,
  initSchema,
  getSetting,
  setSetting,
  listUsers,
  listPayments,
  listWaitlist,
  listReferrals,
  listEvents,
  countEvents,
  listNotifications,
  unreadNotifications,
};
