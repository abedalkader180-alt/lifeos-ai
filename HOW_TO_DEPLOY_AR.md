# 🌍 دليل النشر عبر Vercel + Neon (بدون Turso)

> **جاهز!** اخترت بحسابك Vercel القاعدة **Neon (Postgres)**، وأرسلت `DATABASE_URL`. الكود جاهز يدعمها تلقائياً.
> هذه الصفحة توضح ما تفعله في لوحة Vercel (نسخ/لصق/رفع) — لا تعديل كود مطلوب.

---

## ✅ ما تم إنجازه برمجياً (من قائد المشروع)
- الكود يعمل على: محلي (SQLite) وVercel (Postgres).
- متغير `DATABASE_URL` مدعوم مع `POSTGRES_URL`.
- نقطة دخول Vercel: `api/index.js`.
- إعدادات `vercel.json` جاهزة.
- عنوان المحفظة الصحيح `TXzD...` (Tron TRC20) مضبوط.
- مفتاح Groq مضبوط.
- **لا ملفات أسرار في Git** (تمت إضافتها لقائمة الاستثناء).

---

## خطوة 1: أضف قاعدة Neon إلى مشروع Vercel (إن لم تكتمل)
1. `vercel.com` ← **Storage** (أو **Integrations**).
2. **Neon** أو **Marketplace → Neon**.
3. **Install** واربط بحساب Vercel.
4. أنشئ مشروعاً باسم `lifeos` (الخطة المجانية).
5. اربطه بمشروعك في Vercel (Connect Project).
6. خذ قيم:
   - `DATABASE_URL=postgresql://...`
   - (اختياري) `POSTGRES_URL=...`

## خطوة 2: أضف متغيرات البيئة في Vercel
افتح **Project Settings → Environment Variables** وأضف:

| الاسم | القيمة |
|---|---|
| `DATABASE_URL` | `postgresql://neondb_owner:...@...neon.tech/neondb?sslmode=require` |
| `JWT_SECRET` | سلسلة عشوائية طويلة (مثلها مثل `abc123...`) |
| `OWNER_EMAIL` | إيميلك (مثال: `owner@lifeos.app`) |
| `OWNER_PASSWORD` | كلمة مرور قوية تختارها |
| `TRUST_WALLET_ADDRESS` | `T...(عنوانك الحقيقي من Trust Wallet)` |
| `AI_ENABLED` | `true` |
| `AI_API_KEY` | `gsk_...` |
| `AI_BASE_URL` | `https://api.groq.com/openai/v1` |
| `AI_MODEL` | `llama-3.3-70b-versatile` |
| `PRICE_PRO` | `9.99` |
| `PRICE_LIFE` | `19.99` |
| `FORCE_SQLITE` | (لا تضعها إطلاقاً) |

> **مهم:** لا تضع `FORCE_SQLITE=true` في Vercel. هذا خاص بالمعاينة المحلية فقط.
> لا تضع `.env` في Vercel. ضع القيم مباشرة في متغيرات البيئة.

## خطوة 3: ارفع المشروع
1. بدّل الفرع الحالي إلى `arena/01a07754-lifeos-ai` (أو الفرع الرئيسي لاحقاً).
2. من **GitHub** اربط المستودع `abedalkader180-alt/lifeos-ai`.
3. في Vercel: **Deploy**.
4. ستحصل على رابط مثل `https://lifeos-ai.vercel.app`.

## خطوة 4: تحقق
- افتح `/` على الرابط.
- سجّل حساباً، أضف مهمة، تحدث مع الذكاء.
- افتح `Upgrade` → يجب أن يظهر عنوان محفظتك `TXzD...`.
- أرسل USDT TRC20 ثم الصق Hash.
- افتح `/admin` بحساب المالك وأكّد الدفعة → يتفعّل الاشتراك.

---

## 🔴 أسئلة شائعة
- **لماذا يعمل الذكاء هنا؟** — على Vercel يكون الاتصال بـ Groq متاحاً (البيئة المحلية هنا لا تصل إليه).
- **لماذا لا نحتاج Turso؟** — نستخدم Neon بدلاً منه، أقرب لـ Vercel وأسهل.
- **هل البيانات محفوظة؟** — نعم في قاعدة Neon الدائمة.

---

## 🚀 بعد النشر
- أرسل الرابط لأول 3-5 أشخاص تجريبيين.
- أفعّل خطة الربح في `MONEY_PATH_AR.md` (كوبون، إحالات، منشورات).
- سنضيف لاحقاً "التحقق التلقائي من TRON" الذي يقلل عمل المالك.
