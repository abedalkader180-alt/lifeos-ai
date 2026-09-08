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
  const useModel = model || AI_MODEL;

  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: useModel,
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

const MODE_GUIDE = {
  work: { en: 'Work & productivity', ar: 'العمل والإنتاجية' },
  health: { en: 'Health & fitness', ar: 'الصحة واللياقة' },
  family: { en: 'Family & life balance', ar: 'الأسرة والتوازن' },
  money: { en: 'Money & goals', ar: 'المال والأهداف' },
  faith: { en: 'Spirituality & prayer', ar: 'العبادة والصلاة' },
  general: { en: 'General life', ar: 'الحياة العامة' },
};

function buildSystemPrompt(user, locale) {
  const lang = locale === 'ar' ? 'Arabic' : 'English';
  const mode = (user && user.life_mode) || 'general';
  const guide = MODE_GUIDE[mode] || MODE_GUIDE.general;
  const modeDesc = (locale === 'ar' ? guide.ar : guide.en);
  const profile = (user && user.life_profile && user.life_profile.goals)
    ? `The user's personal context (goals/struggles): ${user.life_profile.goals || ''} ${user.life_profile.struggles ? '| Challenges: ' + user.life_profile.struggles : ''}`
    : '';
  return `You are LifeOS AI, a warm, practical AI life guide. Your specialty right now is: ${modeDesc}.
Language: respond in ${lang}. Keep answers concise (under ~180 words), structured, and actionable.
You help the user organize their daily and weekly routine, solve productivity problems, and balance work, health, relationships, family, money, and growth.
Always ask clarifying questions when needed, and propose concrete steps the user can do today.
Use simple bullet lists. Be honest and do not promise income, medical advice, or financial opportunities. ${profile}
Users: ${user && user.name || 'friend'}, plan ${user && user.plan || 'free'}.`;
}

// Build a structured weekly life plan. Returns a JSON object the frontend can render.
async function buildWeeklyPlan({ user, mode = 'general', goals = '', struggles = '', hoursPerDay = 2, locale = 'en' }) {
  const lang = locale === 'ar' ? 'Arabic' : 'English';
  const guide = MODE_GUIDE[mode] || MODE_GUIDE.general;
  const modeName = (locale === 'ar' ? guide.ar : guide.en);
  const system = `You are LifeOS AI, a practical life-plan builder. Create a weekly life plan in ${lang}.
Specialty: ${modeName}. Available time per day: ${hoursPerDay} hours.
User goals: ${goals || 'improve daily life and productivity'}. User challenges: ${struggles || 'not specified'}.
Return ONLY valid JSON with this exact shape:
{
  "summary": "1-2 sentence overview of the plan",
  "focus": "The single most important area this week",
  "tasks": [{"text":"concrete task","priority":"high|medium|low"}],
  "habits": [{"name":"daily habit","target":1}],
  "goals": ["goal 1","goal 2","goal 3"],
  "daily_plan": [{"day":"Monday","focus":"short text"}]
}
Tasks: 7-10 concrete, realistic tasks. Habits: 4-6 easy daily habits. Goals: 3 clear goals. Do not include markdown or talk outside JSON.`;
  const message = 'Build my weekly life plan.';
  try {
    let text;
    if (AI_ENABLED) {
      const available = await listModels();
      text = await chatWithProvider(system, message, [], locale, pickWorkingModel(available));
    } else {
      text = fallbackPlan(system);
    }
    return parsePlan(text, goalDefault(goals), habitsDefault(mode, locale));
  } catch (e) {
    lastError = 'Plan build error: ' + (e && e.message ? e.message : String(e));
    console.error('[ai] plan build error:', lastError);
    return fallbackPlanObject(mode, goals, struggles, hoursPerDay, locale);
  }
}

function parsePlan(text, fallbackGoals, fallbackHabits) {
  const jsonMatch = String(text).match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const p = JSON.parse(jsonMatch[0]);
      if (p && typeof p === 'object') return p;
    } catch (e) {}
  }
  return fallbackPlanObject('general', '', '', 2, 'en', fallbackGoals, fallbackHabits);
}

function goalDefault(g) { return g ? String(g).split(',').map(s => s.trim()).slice(0, 3) : ['Improve daily routine', 'Increase focus', 'Build consistency']; }
function habitsDefault(mode, locale) {
  const ar = locale === 'ar';
  if (mode === 'health') return [{ name: ar ? 'تمرين خفيف' : 'Light exercise', target: 1 }, { name: ar ? 'ماء كافٍ' : 'Drink water', target: 1 }, { name: ar ? 'نوم ٧ ساعات' : 'Sleep 7h', target: 1 }];
  if (mode === 'faith') return [{ name: ar ? 'صلاة في وقتها' : 'Pray on time', target: 1 }, { name: ar ? 'قراءة قرآن' : 'Quran reading', target: 1 }, { name: ar ? 'ذكر الصباح' : 'Morning dhikr', target: 1 }];
  return [{ name: ar ? 'خطط يومك صباحاً' : 'Plan morning', target: 1 }, { name: ar ? 'راجع ٣ أهداف' : 'Review 3 goals', target: 1 }];
}
function fallbackPlan(system) {
  const m = String(system);
  const ar = /Arabic/.test(m);
  return JSON.stringify({
    summary: ar ? 'خطة أسبوعية عملية تركز على بناء روتين مستقر. ابدأ بخطوة واحدة صغيرة كل يوم.' : 'A practical weekly plan focused on consistent routine. Start with one small step each day.',
    focus: ar ? 'الروتين اليومي' : 'Daily routine',
    tasks: [
      { text: ar ? 'حدد أهم ٣ مهام اليوم' : 'Pick your top 3 tasks for today', priority: 'high' },
      { text: ar ? 'خصص ٣٠ دقيقة عمل عميق' : 'Block 30 min of deep work', priority: 'medium' },
      { text: ar ? 'راجع تقدمك مساءً' : 'Review progress tonight', priority: 'low' }
    ],
    habits: habitsDefault('general', ar ? 'ar' : 'en'),
    goals: goalDefault(''),
    daily_plan: [{ day: ar ? 'الإثنين' : 'Monday', focus: ar ? 'أساس الروتين' : 'Foundation routine' }, { day: ar ? 'الثلاثاء' : 'Tuesday', focus: ar ? 'استمرارية' : 'Consistency' }, { day: ar ? 'الأربعاء' : 'Wednesday', focus: ar ? 'تركيز' : 'Focus' }, { day: ar ? 'الخميس' : 'Thursday', focus: ar ? 'توازن' : 'Balance' }, { day: ar ? 'الجمعة' : 'Friday', focus: ar ? 'راحة وتجديد' : 'Rest & recharge' }, { day: ar ? 'السبت' : 'Saturday', focus: ar ? 'إنجاز' : 'Progress' }, { day: ar ? 'الأحد' : 'Sunday', focus: ar ? 'تخطيط' : 'Planning' }]
  });
}
function fallbackPlanObject(mode, goals, struggles, hours, locale, fg, fh) {
  const ar = locale === 'ar';
  return {
    summary: ar ? 'أنشأنا لك خطة عملية بديلة. اضبط أهدافك واطلب خطة جديدة لتحسينها.' : 'We built a practical backup plan for you. Refine your goals and rebuild for a better one.',
    focus: ar ? 'الروتين والاتساق' : 'Routine & consistency',
    tasks: [{ text: ar ? 'اكتب هدفك الأسبوعي' : 'Write your weekly goal', priority: 'high' }, { text: ar ? 'خطط ٣ أيام الأولى' : 'Plan the first 3 days', priority: 'medium' }, { text: ar ? 'ثبّت موعد يومي' : 'Lock a daily time', priority: 'medium' }],
    habits: habitsDefault(mode, locale) || [],
    goals: fg || goalDefault(goals || ''),
    daily_plan: [{ day: ar ? 'اليوم' : 'Today', focus: ar ? 'ابدأ بخطوة صغيرة' : 'Start small' }]
  };
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

// Free text-based challenge proof verification. The AI reads what the player did
// and returns a verdict. No images/videos needed, no extra cost.
async function validateChallengeProof({ user, task = '', proof = '', locale = 'en' }) {
  const lang = locale === 'ar' ? 'Arabic' : 'English';
  const system = `You are the strict but fair referee of a real-life challenge game. ${user ? user.name : 'A player'} claims to have completed this challenge: "${task}".
Their proof says: "${proof}".
In ${lang}. Decide honestly whether the proof is specific, believable, and shows the task was really attempted (not just "yes I did it").
Return ONLY JSON: {"approved":true|false,"feedback":"short reason shown to player","points_boost":0|5}
Rules:
- approved=true only if the proof has real details about WHERE/WHAT/HOW (public place, distance, seconds, people, etc.).
- approved=false if the proof is generic/one-line/fake/unrelated.
Keep feedback 1 sentence, encouraging if false.`;

  try {
    let text;
    if (AI_ENABLED) {
      const available = await listModels();
      text = await chatWithProvider(system, proof, [], locale, pickWorkingModel(available));
    } else {
      text = heuristicProof(proof, task);
    }
    return parseProofVerdict(text);
  } catch (e) {
    lastError = 'Proof check error: ' + (e && e.message ? e.message : String(e));
    return parseProofVerdict(heuristicProof(proof, task));
  }
}

// Premium helper: short practical coaching tips for the current challenge.
async function challengeCoach({ user, task = '', locale = 'en' }) {
  const ar = locale === 'ar';
  const lang = ar ? 'Arabic' : 'English';
  const system = `You are the coach of a real-life challenge game. The player drew this challenge: "${task}".
Give exactly 3 very short, practical tips (max 12 words each) that make completing it easy and fun.
Reply in ${lang} only. Format: exactly 3 lines, each starting with "1." "2." "3." — no intro, no outro.`;

  try {
    if (AI_ENABLED) {
      const available = await listModels();
      const text = await chatWithProvider(system, `Give me 3 tips for: ${task}`, [], locale, pickWorkingModel(available));
      const clean = String(text || '').trim();
      if (clean) return { tips: clean.slice(0, 700) };
    }
  } catch (e) {
    lastError = 'Coach error: ' + (e && e.message ? e.message : String(e));
  }
  // Honest, generic fallback if the provider is unreachable.
  return {
    tips: ar
      ? '1. جهّز المكان والأدوات قبل أن تبدأ.\n2. ابدأ خلال ٥ دقائق دون تفكير زائد.\n3. ركّز على إنهاء المحاولة لا الكمال.'
      : '1. Prepare your spot and tools first.\n2. Start within 5 minutes, no overthinking.\n3. Focus on finishing, not perfection.',
  };
}

function heuristicProof(proof, task) {
  const p = String(proof || '').trim();
  const specific = /(\d+|\bseconds\b|متر|دقيقة|ثانية|public|مكان|شارع|ناس|people|house|room|seconds|مرة|مرتين|person|friend|سلطة|سلة|ورقة|خطاء|قفز|squat|push)/i.test(p);
  const hasVerb = p.split(/\s+/).length >= 6;
  const approved = specific && hasVerb;
  return JSON.stringify({ approved, feedback: approved ? 'Good, you clearly did it. Claim locked in.' : 'Add more real detail: where, what, how long, or what happened.' });
}

function parseProofVerdict(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (typeof j.approved === 'boolean') return { approved: j.approved, feedback: j.feedback || '', points_boost: j.points_boost || 0 };
    } catch (e) {}
  }
  return { approved: /true/i.test(String(text)), feedback: String(text).slice(0, 160) };
}

module.exports = { chat, buildWeeklyPlan, validateChallengeProof, challengeCoach, AI_ENABLED, AI_MODEL, AI_BASE_URL, getLastError, listModels, pickWorkingModel };
