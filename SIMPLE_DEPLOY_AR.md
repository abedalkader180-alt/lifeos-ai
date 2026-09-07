# 🖱️ الدليل البسيط: ضع المتغيرات المنفردة (بدون أسرار)

> الموقع حي الآن. **متبقي فقط: إدخال قاعدة البيانات في Vercel.**
> هذه القيم ستحصل عليها من **المحادثة/المساعد** (ليست مكتوبة هنا لأسباب أمان).

---

## 📋 المتغيرات التي ستضيفها في Vercel

يكون الرموز الآتية **قيم عامة** — **استبدلها (Value) بالقيم التي أرسلها لك المساعد في المحادثة**.

| الاسم | مثال عام (استبدله بالقيم الحقيقية) |
|---|---|
| `DATABASE_URL` | `postgresql://USER:PASS@HOST/DB?sslmode=require` |
| `TRUST_WALLET_ADDRESS` | `T...(عنوانك الحقيقي)` |
| `AI_ENABLED` | `true` |
| `AI_API_KEY` | `gsk_...(مفتاحك)` |
| `OWNER_EMAIL` | `owner@lifeos.app` |
| `OWNER_PASSWORD` | `(كلمة مرورك)` |
| `JWT_SECRET` | `(سر طويل)` |

---

## خطوات (اضغط بالترتيب)
1. لوحة Vercel ← مشروعك ← **Settings**.
2. من القائمة اليسرى ← **Environment Variables**.
3. اضغط **New Variable**.
4. اكتب **Key** ثم لصق **Value** من المحادثة.
5. **Add** / **Save**. أعد لكل متغير.
6. **Deployments** ← **Redeploy**.

---

## بعد إضافة المتغيرات وتحقق
افتح:
```
https://abedalkader180-alt-lifeos-ai-577a.vercel.app/api/debug
```
يجب أن يصبح:
```
{"vercel":"1","has_db":true,"db_is_pg":true,"db_error":null,...}
```

---

## 🔒 أمان
- لا تضع القيم الحقيقية في ملف عام.
- يمكنك لاحقاً تغيير `OWNER_PASSWORD` و `JWT_SECRET` من نفس الصفحة.
