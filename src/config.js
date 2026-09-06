// ===== شريط تحميل الإعدادات =====
// يقرأ .env المحلي ثم يقرأ متغير واحد LIFEOS_SETTINGS
// الذي يحتوي كل الأسرار/الأعدادات بصيغة JSON (أو نص key=value).
// هذا يسمح بالنشر على Vercel بإضافة متغير واحد فقط بدل 7 متغيرات.

require('dotenv').config();

const ALLOWED = [
  'DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL',
  'JWT_SECRET', 'OWNER_EMAIL', 'OWNER_PASSWORD',
  'TRUST_WALLET_ADDRESS',
  'PRICE_PRO', 'PRICE_LIFE',
  'AI_ENABLED', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL',
  'LAUNCH_COUPON', 'LAUNCH_COUPON_PERCENT',
  'FORCE_SQLITE',
  'PORT',
];

const raw = process.env.LIFEOS_SETTINGS || '';

function parse(rawStr) {
  const s = String(rawStr).trim();
  if (!s) return {};
  const out = {};
  // 1) JSON object
  if (s.startsWith('{') && s.endsWith('}')) {
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
  }
  // 2) newline key=value  or  ampersand key=value
  const parts = s.split(/\r?\n|&/).map(x => x.trim()).filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (k) out[k] = v;
  }
  return out;
}

const merged = parse(raw);
for (const key of ALLOWED) {
  if (merged[key] !== undefined && process.env[key] === undefined) {
    process.env[key] = merged[key];
    console.log(`[config] applied ${key} from LIFEOS_SETTINGS`);
  }
}

module.exports = { LIFEOS_SETTINGS_CONFIGURED: !!raw };
