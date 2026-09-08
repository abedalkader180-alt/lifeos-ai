// ===== مزوّد ذكاء اصطناعي قابل للتهيئة =====
// إذا كان AI_API_KEY موجوداً: نستخدم مزوّداً متوافقاً مع OpenAI.
// إذا لم يكن موجوداً: نستخدم مساعداً داخلياً (regles) يعمل بدون مفتاح.

const KEY = (process.env.AI_API_KEY || '').trim();

// يكتشف تلقائياً من بداية المفتاح: Groq / OpenRouter / OpenAI
function detectProvider(key) {
  if (key.startsWith('gsk_')) return { base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' };
  if (key.startsWith('sk-or-')) return { base: 'https://openrouter.ai/api/v1', model: 'openrouter/free' };
  return { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
}

const provider = detectProvider(KEY);
const AI_ENABLED = process.env.AI_ENABLED === 'true' && !!KEY;
const AI_BASE_URL = (process.env.AI_BASE_URL || provider.base).replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || provider.model;

let lastError = null;
let modelsCache = null;
function getLastError() { return lastError; }

// Try a list of strong models, in order. As soon as one is actually accepted by
// the provider, we switch to it permanently (in-memory). This fixes the common
// case where a key is valid but a specific model id is not available/authorized.
const MODEL_CANDIDATES = [
  process.env.AI_MODEL,
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama-3.1-70b-versatile',
  'llama-3.3-70b-specdec',
  'llama-3.3-70b-instruct',
  'llama-3.2-3b-preview',
  'llama-3.2-1b-preview',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
  'qwen-2.5-32b',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'groq/compound',
  'groq/compound-mini',
  'allam-2-7b',
].filter(Boolean);

async function listModels() {
  if (modelsCache) return modelsCache;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${AI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    const ids = (data.data || []).map(m => m.id);
    modelsCache = ids;
    return ids;
  } catch (e) {
    return [];
  }
}

function pickWorkingModel(available) {
  if (available && available.length) {
    for (const cand of MODEL_CANDIDATES) {
      if (available.includes(cand)) return cand;
    }
    // Prefer a useful chat model if any available; avoid tiny/whisper/guard models.
    const preferred = available.find(id => /qwen|\bllama\b|gpt-oss|compound|gemma|mistral/.test(id) && !/whisper|guard|22m|86m|prompt/.test(id));
    if (preferred) return preferred;
    return available[0];
  }
  return AI_MODEL;
}

async function chat({ user, message, history = [], locale = 'en' }) {
  const system = buildSystemPrompt(user, locale);
  if (AI_ENABLED) {
    try {
      const available = await listModels();
      if (!available.length) console.warn('[ai] could not list models; trying configured model');
      const reply = await chatWithProvider(system, message, history, locale, pickWorkingModel(available));
      lastError = null;
      return reply;
    } catch (err) {
      lastError = 'Provider error: ' + (err && err.message ? err.message : String(err));
      console.error('[ai] provider error:', lastError);
      if (process.env.AI_ALLOW_FALLBACK === 'true') {
        return fallbackAssistant(user, message, locale);
      }
      throw new Error(lastError);
    }
  }
  return fallbackAssistant(user, message, locale);
}

async function chatWithProvider(system, message, history, locale, model) {
  const messages = [
    { role: 'system', content: system },
    ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: message },
  ];

  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: model || AI_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 900,
    }),
  });

  if (!res.ok) {
    throw new Error(`provider status ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'Sorry, I could not generate a response.';
}

function buildSystemPrompt(user, locale) {
  const lang = locale === 'ar' ? 'Arabic' : 'English';
  return `You are LifeOS AI, a helpful, warm, and practical AI life guide.
Language: respond in ${lang}. Keep answers concise (under ~180 words), structured, and actionable.
You help the user organize their daily and weekly routine, solve productivity problems, and balance work, health, relationships, and growth.
Always ask clarifying questions when needed, and propose concrete steps the user can do today.
Use simple bullet lists. Do not promise income, medical advice, or financial opportunities. Users: ${user.name}, plan ${user.plan}.`;
}

// ===== مساعد داخلي بدون مفتاح =====
function fallbackAssistant(user, message, locale) {
  const m = message.toLowerCase();
  const ar = locale === 'ar';

  const intro = ar
    ? `أهلاً ${user.name}! أنا مرشد حياتك الذكي. أحلل رسالتك وأنظم لك نصائح عملية.`
    : `Hi ${user.name}! I'm LifeOS AI, your life guide. I analyzed your message and turned it into practical steps.`;

  const blocks = [];
  blocks.push(intro);

  if (/(gym|workout|exercise|تمرين|رياضة|جيم|لياقة)/.test(m)) {
    blocks.push(
      ar
        ? `بخصوص الرياضة:\n1. ابدأ بجلسة قصيرة ٢٠-٣٠ دقيقة قبل يوم العمل.\n2. حدد ٣ جلسات أساسية أسبوعياً (الاثنين/الأربعاء/السبت).\n3. ابدأ بـ cardio خفيف ثم قوّة.\n4. ضع تذكيرات في الصباح حتى لا تتراكم.`
        : `About fitness:\n1. Start with a short 20-30 min session before work.\n2. Lock in 3 core sessions weekly (Mon/Wed/Sat).\n3. Warm up with light cardio, then strength.\n4. Set morning reminders so it doesn't slip.`
    );
  } else if (/(time|busy|schedule|وقت|مشغول|جدول|ضيق)/.test(m)) {
    blocks.push(
      ar
        ? `إدارة الوقت:\n1. حدد أهم ٣ مهام اليوم فقط.\n2. كتلة "عمل عميق" ٩-١١ صباحاً.\n3. اجمع المهام المتشابهة معاً.\n4. استخدم بومودورو ٢٥ دقيقة + استراحة ٥.\n5. اترك مساحة غير مخططة ٣٠ دقيقة.`
        : `Time management:\n1. Pick only your top 3 tasks for today.\n2. Protect a 9-11 AM deep-work block.\n3. Batch similar tasks together.\n4. Use 25-min Pomodoro + 5-min breaks.\n5. Keep a 30-min buffer unplanned.`
    );
  } else if (/(stress|tired|overwhelmed|انزعاج|توتر|قلق|تعبت|ضغط)/.test(m)) {
    blocks.push(
      ar
        ? `للتوتر والضغط:\n1. خذ نفساً عميقاً ٤-٧-٨ لمدة دقيقة.\n2. انقل مهمة واحدة من اليوم لغد.\n3. أضف ١٠ دقائق تأمل أو مشي خفيف.\n4. نام ٧-٨ ساعات هذا الليل.\n5. أكتب ٣ أشياء تشكر عليها.`
        : `For stress:\n1. Take a 4-7-8 breath for one minute.\n2. Move one task to tomorrow.\n3. Add 10 min of meditation or a short walk.\n4. Target 7-8 hours of sleep tonight.\n5. Write 3 things you're grateful for.`
    );
  } else if (/(money|income|pay|دخل|فلوس|ربح|مال)/.test(m)) {
    blocks.push(
      ar
        ? `ملاحظة صادقة: لا أستطيع ضمان دخل لك، لكن أقدر أساعدك تنظّم أهدافك المالية:\n1. حدد مصدر دخل رئيسي + مصدر دخل ثانوي.\n2. خصص ١٠٪ من دخلك للتوفير.\n3. ضع هدفاً أسبوعياً صغيراً واحداً قابلاً للقياس.\n4. تعلّم مهارة عالية الطلب ٤٥ دقيقة/يوم.`
        : `Honest note: I can't guarantee income. But I can help you build a plan:\n1. Keep one main income + explore one secondary stream.\n2. Save 10% of every payment.\n3. Set one small measurable weekly goal.\n4. Spend 45 min/day building an in-demand skill.`
    );
  } else {
    blocks.push(
      ar
        ? `خطوة عملية اليوم:\n1. اكتب هدفك الحالي بوضوح.\n2. قسّمه إلى ٣ مهام صغيرة.\n3. نفّذ أول مهمة في أول ٢٥ دقيقة.\n4. راجع تقدمك مساءً وعدّل الخطة.\n\nاطلب مني جدولاً تفصيلياً أو خطة أسبوعية وسأنظمها لك.`
        : `One practical step today:\n1. Write your current goal clearly.\n2. Break it into 3 small tasks.\n3. Execute the first one in the next 25 minutes.\n4. Review progress tonight and adjust.\n\nAsk me for a detailed schedule or weekly plan and I'll structure it for you.`
    );
  }

  if (ar) blocks.push('هل تريدني أن أضيف هذه الخطوات إلى جدولك والمهام؟');
  else blocks.push('Would you like me to add these steps to your tasks and calendar?');

  return blocks.join('\n\n');
}

module.exports = { chat, AI_ENABLED, AI_MODEL, AI_BASE_URL, getLastError, listModels, pickWorkingModel };
