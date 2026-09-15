// ---------- مرفق PDF في المحادثة ----------
//
// الطالب بيبعت ورقة امتحان مصوّرة PDF، والموظف بيبعتله مذكرة أو نموذج إجابة. قبل كده
// الاتنين مكانوش ممكن: البوت كان بيسجّل "📎 ملف (اتطلب منه يبعت مكتوب أو صورة)"
// والملف نفسه بيتسقط.
//
// الوحدة دي فيها الحدود والفحوصات المشتركة بين تلات أماكن (هاندلر البوت، الكنترولر،
// مسار الرفع) عشان الحد مايختلفش بين مكان ومكان — الحد اللي بيختلف بيبان للموظف
// على إنه "الملف اترفع وبعدين فشل"

const fs = require('fs');

// **الحد ده مش اختيارنا — ده حد تليجرام.** getFile للبوتات بتفك ملفات لحد ٢٠ ميجا بس،
// فأي ملف أكبر من كده مش هنقدر ننزّله من عند الطالب أصلًا مهما عملنا. وخلّيناه نفس
// الحد في الاتجاهين عشان الموظف مايشرحش للطالب حد وهو ماشي على حد تاني
const MAX_BYTES = 20 * 1024 * 1024;

const MIME = 'application/pdf';

// السطر اللي بيتعرض بدل الرسالة في المعاينات (قايمة التذاكر، الاقتباس، الإشعار)
const LABEL = '📄 ملف';

// **الامتداد والنوع المعلَن الاتنين كذّابين.** اسم الملف بيكتبه اللي بيبعت، والنوع
// المعلَن جاي من متصفحه أو من تطبيق تليجرام عنده. الحقيقة الوحيدة هي أول خمس بايتات
function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

function isPdfOnDisk(absolutePath) {
  let handle = null;
  try {
    handle = fs.openSync(absolutePath, 'r');
    const head = Buffer.alloc(5);
    fs.readSync(handle, head, 0, 5, 0);
    return isPdfBuffer(head);
  } catch (error) {
    return false;
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

// **الاسم ده بيوصل من بره ومابيتحوّلش لاسم على القرص أبدًا** — الملف بياخد UUID،
// والاسم الأصلي بيتخزّن للعرض بس. وبرضه بينضّف: `../` في اسم بيتحط في خانة تنزيل
// المتصفح، والأحرف الخفية بتخلي الاسم يبان حاجة وهو حاجة تانية
function safeName(raw) {
  const cleaned = String(raw || '')
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[\\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'ملف.pdf';
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

// الحجم بيتعرض جنب الاسم: الموظف على موبايل بشبكة ضعيفة بيقرر يفتح ولا لأ من الرقم ده
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} كيلو`;
  return `${(value / (1024 * 1024)).toFixed(1)} ميجا`;
}

module.exports = { MAX_BYTES, MIME, LABEL, isPdfBuffer, isPdfOnDisk, safeName, formatBytes };
