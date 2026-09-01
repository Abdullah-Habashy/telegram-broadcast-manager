// ---------- تخزين الملفات بره القرص ----------
//
// **المشكلة:** كل صورة بتوصل من طالب، وكل صورة بيبعتها موظف، وكل رسالة صوتية بتتكتب على
// قرص السيرفر جنب التطبيق. دلوقتي ١٣٤ ميجا و٦١١ ملف — مالوش أي معنى. على موقع بمية ألف
// طالب ده بيبقى جيجات، والقرص اللي بيمتلي مش بس بيوقف الرفع: **النسخ الاحتياطي اليومي
// على نفس القرص**، فامتلاؤه معناه إن آخر نسخة سليمة بتبقى من قبل ما يمتلي.
//
// **الوحدة دي بتشتغل مع S3 وCloudflare R2 وDigitalOcean Spaces بنفس الكود** — التلاتة
// بيتكلموا نفس البروتوكول، فمافيش داعي نستنى قرار المزوّد عشان نكتب الكود.
//
// **ومن غير إعدادات، مافيش أي تغيير في السلوك.** لو المتغيّرات مش مضبوطة، الدالة بترجّع
// المسار المحلي زي ما هو والملف بيفضل على القرص — يعني النشر الحالي مايتأثرش بحرف،
// والتحويل بيحصل بإضافة المتغيّرات و restart بس.
//
// **والمسارات القديمة مابتتلمسش.** الصفوف القديمة في القاعدة فيها `uploads/x.png` وبتفضل
// بتتخدم من القرص؛ الجديدة بتبقى رابط كامل. الاتنين شغالين في <img src>، فمافيش هجرة
// بيانات ولا لحظة بيقع فيها الاتنين.
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.S3_BUCKET || '';
const REGION = process.env.S3_REGION || 'auto';
const ENDPOINT = process.env.S3_ENDPOINT || '';
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY || '';
// الرابط العام للملفات: دومين الـCDN أو الباكت. من غيره الملف بيترفع ومحدش يقدر يفتحه،
// فوجوده شرط في التشغيل مش اختياري
const PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || '').replace(/\/+$/, '');
// R2 وMinio محتاجين path-style؛ S3 الأصلي لأ
const FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === 'true';

const enabled = Boolean(BUCKET && ACCESS_KEY && SECRET_KEY && PUBLIC_BASE);

let client = null;

// العميل بيتعمل عند أول استخدام مش عند تحميل الوحدة: من غير إعدادات، المكتبة نفسها
// مابتتحمّلش أصلًا — وde بيوفّر وقت الإقلاع على السيرفر اللي مش مستخدمها
function getClient() {
  if (client) return client;
  // eslint-disable-next-line global-require
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    forcePathStyle: FORCE_PATH_STYLE,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  return client;
}

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function contentTypeFor(key) {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

// localPath: مكان الملف على القرص · key: مساره جوه الباكت (زي uploads/incoming/x.jpg)
//
// بيرجّع المسار اللي يتخزّن في القاعدة: رابط كامل لو الرفع نجح، والمسار المحلي زي ما هو
// لو التخزين مش مفعّل **أو لو الرفع فشل**.
//
// **الفشل مابيرميش.** الصورة موجودة على القرص خلاص والرسالة وصلت الموظف؛ إن الرفع
// لسحابة فشل مش سبب إن الرسالة نفسها تفشل. بيتسجّل في اللوج والملف بيفضل محلي.
// keepLocal: ارفع من غير ما تمسح المحلي. بيستخدم لما الصف في القاعدة لازم يتحدّث
// بالرابط الجديد بعد الرفع — المسح قبل التحديث معناه إن فشل التحديث بيضيّع الصورة
async function storeFile(localPath, key, { keepLocal = false } = {}) {
  if (!enabled) return key;
  try {
    // eslint-disable-next-line global-require
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getClient().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: contentTypeFor(key),
    }));
    // الملف المحلي بيتشال بعد الرفع — هو ده الهدف أصلًا. فشل المسح مش مشكلة تستاهل
    // إننا نرجّع خطأ: الرابط اتكوّن صح والملف الزيادة بيتنضّف بعدين
    if (!keepLocal) fs.promises.unlink(localPath).catch(() => {});
    return `${PUBLIC_BASE}/${key}`;
  } catch (error) {
    console.error(`❌ Failed to upload ${key} to object storage; keeping it on disk:`, error.message);
    return key;
  }
}

module.exports = { storeFile, isEnabled: () => enabled };
