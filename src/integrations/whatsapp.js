// ---------- واتساب: Meta WhatsApp Cloud API ----------
//
// **الفرق الجوهري عن تليجرام:** تليجرام بيدّي توكن واحد وخلاص. واتساب بيدّي أربع حاجات
// منفصلة، وكل واحدة ليها دور مختلف — وخلطهم بيدّي أخطاء مالهاش معنى:
//
//   verify_token    — نص إحنا اللي بنخترعه. فيسبوك بيبعته لنا مرة واحدة وقت تسجيل
//                     الويبهوك عشان يتأكد إن السيرفر بتاعنا فعلًا. مالوش أي دور بعدها.
//   app_secret      — بيه بنتحقق إن كل طلب جاي من فيسبوك فعلًا (توقيع HMAC).
//                     **من غيره أي حد يعرف الرابط يقدر يزوّر رسايل طلاب.**
//   access_token    — بيه بنبعت رسايل. بيخلص وبيتجدّد.
//   phone_number_id — الرقم اللي بنبعت منه. **مش رقم الموبايل** — ده رقم داخلي لفيسبوك.
//
// ⚠️ **نافذة الـ٢٤ ساعة:** واتساب مابيسمحش تبعت للطالب رسالة حرة إلا لو هو كلّمك في آخر
// ٢٤ ساعة. بعد كده مفيش غير القوالب المعتمدة مسبقًا، وليها تكلفة لكل رسالة. ده قيد من
// واتساب مش من الكود، وبيغيّر شكل أي إرسال جماعي أو إشعار آلي.

const crypto = require('crypto');
const pool = require('../config/db');
const { encrypt, decrypt } = require('../utils/crypto');

const WEBHOOK_PATH = '/whatsapp/webhook';
const GRAPH_VERSION = 'v21.0';

const SETTING_KEYS = [
  'whatsapp_verify_token',
  'whatsapp_app_secret_encrypted',
  'whatsapp_access_token_encrypted',
  'whatsapp_phone_number_id',
];

async function readSettings() {
  const { rows } = await pool.query(
    'SELECT key, value FROM settings WHERE key = ANY($1::text[])', [SETTING_KEYS]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function decryptOrNull(value, label) {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch (error) {
    console.error(`❌ Failed to decrypt the stored WhatsApp ${label}:`, error.message);
    return null;
  }
}

async function getConfig() {
  const s = await readSettings();
  return {
    verifyToken: s.whatsapp_verify_token || null,
    appSecret: decryptOrNull(s.whatsapp_app_secret_encrypted, 'app secret'),
    accessToken: decryptOrNull(s.whatsapp_access_token_encrypted, 'access token'),
    phoneNumberId: s.whatsapp_phone_number_id || null,
  };
}

// **بيتعمل لوحده أول تشغيل.** التسجيل في لوحة فيسبوك محتاج النص ده جاهز قبل ما نبدأ،
// وتوليده عشوائي أأمن من إن حد يكتب كلمة يفتكرها
async function ensureVerifyToken() {
  const existing = await pool.query(
    "SELECT value FROM settings WHERE key = 'whatsapp_verify_token' AND value IS NOT NULL AND value <> ''");
  if (existing.rows.length) return existing.rows[0].value;

  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('whatsapp_verify_token', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [token]);
  console.log('🔑 A WhatsApp verify token was generated; paste it into the Meta webhook setup.');
  return token;
}

async function saveCredentials({ appSecret, accessToken, phoneNumberId }) {
  const updates = [];
  if (appSecret) updates.push(['whatsapp_app_secret_encrypted', encrypt(appSecret)]);
  if (accessToken) updates.push(['whatsapp_access_token_encrypted', encrypt(accessToken)]);
  if (phoneNumberId) updates.push(['whatsapp_phone_number_id', String(phoneNumberId).trim()]);
  for (const [key, value] of updates) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  }
  return updates.length;
}

// ---------- التحقق من إن الطلب جاي من فيسبوك ----------
//
// **التوقيع بيتحسب على البايتات الخام زي ما وصلت بالحرف.** لو اتحسب على الكائن بعد ما
// Express فكّه وبنيناه تاني، أي فرق في ترتيب المفاتيح أو المسافات بيغيّر الهاش —
// فالتحقق بيفشل على طلبات سليمة. عشان كده `server.js` بيحتفظ بـ`req.rawBody`.
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return { ok: false, reason: 'app secret مش متسجّل' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'الجسم الخام مش موجود' };
  const signature = String(header || '');
  if (!signature.startsWith('sha256=')) return { ok: false, reason: 'التوقيع ناقص' };

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // المقارنة بطول ثابت: المقارنة العادية بتقف عند أول حرف مختلف، وده بيسرّب معلومة
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'التوقيع مش مطابق' };
  }
  return { ok: true };
}

// ---------- قراءة ما وصل ----------
//
// شكل فيسبوك متداخل: entry[] ← changes[] ← value ← messages[]/statuses[].
// الدالة دي بتفرده لصف واحد لكل رسالة عشان باقي النظام مايتعاملش مع الشكل ده.
function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        const contact = contacts.find((c) => c.wa_id === message.from) || contacts[0] || {};
        out.push({
          waMessageId: message.id,
          from: message.from,
          name: contact.profile?.name || null,
          type: message.type,
          text: message.text?.body || message.button?.text || message.interactive?.list_reply?.title || null,
          // الوسائط بترجع كمعرّف لازم يتنزّل بنداء تاني — بنسجّله دلوقتي وبننزّله بعدين
          mediaId: message[message.type]?.id || null,
          caption: message[message.type]?.caption || null,
          timestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
          phoneNumberId: value.metadata?.phone_number_id || null,
        });
      }
    }
  }
  return out;
}

// حالات التسليم (اتبعتت/اتسلّمت/اتقرت) — بتيجي على نفس الويبهوك وبتتسجّل من غير ما تفتح تذكرة
function extractStatuses(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const status of change.value?.statuses || []) {
        out.push({
          waMessageId: status.id,
          recipient: status.recipient_id,
          status: status.status,
          timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date(),
          error: status.errors?.[0]?.title || null,
        });
      }
    }
  }
  return out;
}

// **بيتسجّل كل اللي وصل زي ما هو.** لسه مافيش ربط بصندوق الدعم، والتسجيل الخام معناه إن
// الرسايل اللي بتوصل دلوقتي مش بتضيع — هتتعالج لما الربط يتبني.
async function storeEvent({ payload, messages, statuses }) {
  await pool.query(
    `INSERT INTO whatsapp_events (payload, message_count, status_count)
     VALUES ($1::jsonb, $2, $3)`,
    [JSON.stringify(payload), messages.length, statuses.length]);
}

module.exports = {
  WEBHOOK_PATH,
  GRAPH_VERSION,
  getConfig,
  ensureVerifyToken,
  saveCredentials,
  verifySignature,
  extractMessages,
  extractStatuses,
  storeEvent,
};
