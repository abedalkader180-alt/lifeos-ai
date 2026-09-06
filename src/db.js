// ===== Database layer =====
// Automatic mode:
//   - If DATABASE_URL (or POSTGRES_URL/POSTGRESQL_URL) is defined -> PostgreSQL (for Vercel).
//   - Otherwise -> local SQLite file (for development / preview).

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || '';
// FORCE_SQLITE=true is used for local preview when the cloud DB is not reachable from this sandbox.
const IS_PG = !(process.env.FORCE_SQLITE === 'true') && !!PG_URL;

let pool = null;
let sqlite = null;
let SQLITE_FILE = '';

if (IS_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: PG_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  console.log('[db] Using PostgreSQL database');
} else {
  const { DatabaseSync } = require('node:sqlite');
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

async function all(sql, params = []) {
  if (pool) {
    const r = await pool.query(pgSql(sql), params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function get(sql, params = []) {
  if (pool) {
    const r = await pool.query(pgSql(sql), params);
    return r.rows[0] || null;
  }
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
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

async function initSchema() {
  if (pool) {
    await pool.query(SCHEMA_PG);
  } else {
    sqlite.exec(SCHEMA_SQLITE);
  }

  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  if (ownerEmail && ownerPassword) {
    const exists = await get('SELECT id FROM users WHERE email = ?', [ownerEmail.toLowerCase()]);
    if (!exists) {
      const hash = bcrypt.hashSync(ownerPassword, 10);
      await run(
        'INSERT INTO users (email, name, password_hash, plan, plan_until) VALUES (?, ?, ?, ?, ?) RETURNING id',
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

module.exports = {
  IS_PG,
  PG_URL,
  all,
  get,
  run,
  initSchema,
  getSetting,
  setSetting,
  listUsers,
  listPayments,
};
