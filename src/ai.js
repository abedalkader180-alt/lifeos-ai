// ===== مزوّد ذكاء اصطناعي قابل للتهيئة =====
// إذا كان AI_API_KEY موجوداً: نستخدم مزوّداً متوافقاً مع OpenAI.
// إذا لم يكن موجوداً: نستخدم مساعداً داخلياً (regles) يعمل بدون مفتاح.

const AI_ENABLED = process.env.AI_ENABLED === 'true' && !!process.env.AI_API_KEY;
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

async function chat({ user, message, history = [], locale = 'en' }) {
  const system = buildSystemPrompt(user, locale);
  if (AI_ENABLED) {
    try {
      return await chatWithProvider(system, message, history, locale);
    } catch (err) {
      console.error('[ai] provider error, falling back:', err.message);
      return fallbackAssistant(user, message, locale);
    }
  }
  return fallbackAssistant(user, message, locale);
}

async function chatWithProvider(system, message, history, locale) {
  const messages = [
    { role: 'system', content: system },
    ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: message },
  ];

  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
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
  return `You are LifeOS AI, a helpful, warm, and practical AI life architect.
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
    ? `أهلاً ${user.name}! أنا أرشيتكت حياتك. أحلل رسالتك وأنظم نصائح عملية لك.`
    : `Hi ${user.name}! I'm your life architect. I analyzed your message and turned it into practical steps.`;

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

module.exports = { chat, AI_ENABLED, AI_MODEL };
