// ===== Mailer: sends verification emails via Resend API or SMTP (nodemailer) =====
// Config:
//   RESEND_API_KEY  -> use Resend (https://resend.com)
//   MAIL_FROM       -> from address (default Resend testing address)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS -> use generic SMTP (Gmail app password, etc.)
//   MAIL_DEV        -> when "1", no real email is sent; code is returned/logged for local testing

const nodemailer = require('nodemailer');
const dns = require('dns');
const net = require('net');
const { NODE_ENV } = process.env;

const RESEND_KEY = (process.env.RESEND_API_KEY || '').trim();
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const MAIL_DEV = process.env.MAIL_DEV === '1';
// For Gmail SMTP the From address MUST be the authenticated account, otherwise
// Gmail rejects the send. We defensively derive it from SMTP_USER when MAIL_FROM
// is empty OR malformed (e.g. a value that lost the email part).
function cleanFrom(value, fallback) {
  const v = String(value || '').trim();
  if (/<[^>]+@[^>]+>/.test(v) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return v;
  return fallback;
}
const derivedFrom = SMTP_USER && /@/.test(SMTP_USER) ? `LifeOS AI <${SMTP_USER}>` : 'LifeOS AI <onboarding@resend.dev>';
// For SMTP (Gmail), the From must be the authenticated account itself. We always
// prefer SMTP_USER there; MAIL_FROM is only used for Resend or as fallback.
const MAIL_FROM = SMTP_HOST && SMTP_USER && /@/.test(SMTP_USER)
  ? `LifeOS AI <${SMTP_USER}>`
  : cleanFrom(process.env.MAIL_FROM, derivedFrom);

let transporter = null;
let resolvedIpv4 = SMTP_HOST;
let resolverState = 'idle';

// Force IPv4 for SMTP. Render's egress has no IPv6 route, and nodemailer can
// randomly pick Gmail's IPv6 address (2607:f8b0...), causing ENETUNREACH.
// We resolve smtp.gmail.com to an IPv4 literal ourselves (kept stable by DNS)
// and connect to that literal with servername set for TLS SNI.
function resolveIpv4(host) {
  if (!host || net.isIP(host)) return host;
  try {
    const found = dns.resolve4Sync(host);
    if (found && found[0]) {
      resolvedIpv4 = found[0];
      resolverState = 'ipv4';
      return found[0];
    }
  } catch (e) {
    // fall through to original hostname
  }
  resolvedIpv4 = host;
  resolverState = 'hostname';
  return host;
}

// Prioritize Resend (simplest, most reliable); fall back to SMTP only when no Resend key.
if (!RESEND_KEY && SMTP_HOST && SMTP_USER && SMTP_PASS) {
  const connectHost = resolveIpv4(SMTP_HOST);
  transporter = nodemailer.createTransport({
    host: connectHost,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Keep original hostname for TLS SNI / HELO even though we connect by IP.
    tls: { servername: SMTP_HOST },
    name: SMTP_HOST,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 25000,
  });
}

const mailEnabled = !!(RESEND_KEY || transporter);
const MAIL_MODE = RESEND_KEY ? 'resend' : (transporter ? 'smtp' : 'unconfigured');

function subject(lang) {
  return lang === 'ar'
    ? 'رمز تأكيد حسابك في LifeOS AI'
    : 'Your LifeOS AI verification code';
}

function bodyText(code, lang) {
  if (lang === 'ar') {
    return `أهلاً بك في LifeOS AI!\n\nرمز التأكيد الخاص بك هو:\n\n${code}\n\nأدخل هذا الرمز في التطبيق لإكمال إنشاء حسابك.\nإذا لم تطلب هذا، يمكنك تجاهل الرسالة.\n\n— فريق LifeOS AI`;
  }
  return `Welcome to LifeOS AI!\n\nYour verification code is:\n\n${code}\n\nEnter this code in the app to finish creating your account.\nIf you did not request this, you can ignore this email.\n\n— LifeOS AI Team`;
}

async function sendVerificationCode(email, code, lang) {
  if (MAIL_DEV) {
    console.log('[mail:dev] verification code for', email, '=', code);
    return { sent: false, mode: 'dev', detail: 'MAIL_DEV=1 (no real email sent)' };
  }

  try {
    if (RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: [email],
          subject: subject(lang),
          text: bodyText(code, lang),
        }),
      });
      if (!res.ok) throw new Error('Resend HTTP ' + res.status + ': ' + await res.text());
      return { sent: true, mode: 'resend' };
    }

    if (transporter) {
      await transporter.sendMail({
        from: MAIL_FROM,
        to: email,
        subject: subject(lang),
        text: bodyText(code, lang),
      });
      return { sent: true, mode: 'smtp' };
    }

    // No mail provider configured: return mode 'unconfigured' so the API can expose
    // a dev code during testing, showing clearly this is not a real email yet.
    return { sent: false, mode: 'unconfigured', detail: 'No mail provider configured. Set RESEND_API_KEY or SMTP_* to send real emails.' };
  } catch (e) {
    console.error('[mail] send failed:', e && e.message ? e.message : e);
    // Never let a mail failure crash the signup flow. Return an explicit error result.
    return { sent: false, mode: 'error', detail: 'Email sending failed: ' + (e && e.message ? e.message : 'unknown error') };
  }
}

function planReminderBody(daysLeft, lang) {
  if (lang === 'ar') {
    return `اشتراكك في LifeOS AI ينتهي خلال ${daysLeft} ${daysLeft === 1 ? 'يوم' : 'أيام'}.\n\nجدّد الآن من داخل التطبيق (صفحة الاشتراك) حتى لا تتوقف مزاياك: التحديات، النقاط المضاعفة، ووسائل المساعدة.\n\n— فريق LifeOS AI`;
  }
  return `Your LifeOS AI plan ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.\n\nRenew now from the app (Plans page) so your benefits don't stop: challenges, double points, and helper tools.\n\n— LifeOS AI Team`;
}

async function sendPlanReminder(email, lang, daysLeft) {
  if (MAIL_DEV) {
    console.log('[mail:dev] plan reminder for', email, '=', daysLeft, 'days left');
    return { sent: false, mode: 'dev', detail: 'MAIL_DEV=1 (no real email sent)' };
  }
  const subject = lang === 'ar'
    ? `تذكير: اشتراكك ينتهي خلال ${daysLeft} ${daysLeft === 1 ? 'يوم' : 'أيام'}`
    : `Reminder: your LifeOS AI plan ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  try {
    if (RESEND_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: MAIL_FROM,
          to: [email],
          subject,
          text: planReminderBody(daysLeft, lang),
        }),
      });
      if (!res.ok) throw new Error('Resend HTTP ' + res.status + ': ' + await res.text());
      return { sent: true, mode: 'resend' };
    }

    if (transporter) {
      await transporter.sendMail({
        from: MAIL_FROM,
        to: email,
        subject,
        text: planReminderBody(daysLeft, lang),
      });
      return { sent: true, mode: 'smtp' };
    }

    return { sent: false, mode: 'unconfigured', detail: 'No mail provider configured. Set RESEND_API_KEY or SMTP_* to send real emails.' };
  } catch (e) {
    console.error('[mail] send failed:', e && e.message ? e.message : e);
    return { sent: false, mode: 'error', detail: 'Email sending failed: ' + (e && e.message ? e.message : 'unknown') };
  }
}

module.exports = { sendVerificationCode, sendPlanReminder, mailEnabled, mailConfig: { mode: MAIL_MODE, from: MAIL_FROM, host: SMTP_HOST, resolved_host: resolvedIpv4, resolver: resolverState, user: SMTP_USER, hasPassword: !!SMTP_PASS, resendKey: !!RESEND_KEY } };
