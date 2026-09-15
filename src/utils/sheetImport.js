// ---------- استيراد إجابات الطلاب من شيت (Google Forms وغيره) ----------
//
// **المشكلة:** الاختبار اتحل على Google Forms، والإجابات في شيت — والنظام مايعرفش عنها
// حاجة. نقلها بالإيد لـ٥٠٠ طالب مستحيل، والتصحيح المقالي هناك مش موجود أصلًا.
//
// **ليه الربط يدوي مش تلقائي بالكامل:** كل فورم بيسمّي أعمدته بطريقته، والتخمين الغلط
// معناه إجابات طالب بتتحسب على سؤال تاني — وده أسوأ من إن الموظف يربط بنفسه مرة واحدة.
// فالوحدة دي **بتقترح** الربط بمطابقة النصوص، والموظف بيراجعه ويعدّله قبل أي كتابة.
//
// الوحدة دي **بتقرا وبتحلّل بس** — مافيهاش أي كتابة في القاعدة. الحفظ في الكنترولر بعد
// موافقة صريحة، زي استيراد أسئلة Word بالظبط.

const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');

// **الحد على الصفوف مش على البايتات.** ملف ٥٠٠ طالب × ٥٠ عمود حجمه صغير، لكن شيت فيه
// عشرات الآلاف من الصفوف (لو حد رفع الملف الغلط) بيملى الذاكرة قبل ما نكتشف إنه غلط
const MAX_ROWS = 5000;
const MAX_COLUMNS = 200;
// عيّنة بتترجع للواجهة عشان الموظف يشوف المحتوى وهو بيربط — الأعمدة لوحدها مش كفاية
// للتفرقة بين "سؤال ٣" و"سؤال ٣ (الدرجة)"
const SAMPLE_ROWS = 3;

// ---------- قراءة الملف ----------
//
// الاتنين بيرجعوا نفس الشكل: { headers: [...], rows: [[...], ...] }. Google Forms
// بيصدّر xlsx و csv الاتنين، والموظف بياخد أي واحد فيهم من غير ما يعرف الفرق
async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('الملف مافيهوش أي شيت');

  const rows = [];
  let headers = [];
  sheet.eachRow({ includeEmpty: false }, (row, index) => {
    if (rows.length >= MAX_ROWS) return;
    // `values` بيبدأ من الفهرس ١ في exceljs — الفهرس صفر دايمًا فاضي
    const values = (row.values || []).slice(1, MAX_COLUMNS + 1).map(cellText);
    if (index === 1) { headers = values; return; }
    rows.push(values);
  });
  return { headers, rows };
}

function readCsvBuffer(buffer) {
  const records = parseCsv(buffer.toString('utf8'), {
    bom: true, skip_empty_lines: true, relax_column_count: true, to: MAX_ROWS + 1,
  });
  if (!records.length) throw new Error('الملف فاضي');
  return {
    headers: records[0].slice(0, MAX_COLUMNS).map((v) => String(v ?? '').trim()),
    rows: records.slice(1).map((r) => r.slice(0, MAX_COLUMNS).map((v) => String(v ?? '').trim())),
  };
}

// **الخلية مش دايمًا نص.** exceljs بيرجّع كائنات للصيغ والروابط والنص الغني، و`String()`
// عليها بتطلّع "[object Object]" — وده كان هيتحفظ كإجابة الطالب
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // صيغة: بناخد النتيجة مش الصيغة نفسها
    if ('result' in value) return cellText(value.result);
    // نص غني: أجزاء متفرقة بتتجمع
    if (Array.isArray(value.richText)) return value.richText.map((p) => p.text || '').join('');
    if ('text' in value) return cellText(value.text);
    if ('hyperlink' in value) return cellText(value.text || value.hyperlink);
    return '';
  }
  return String(value).trim();
}

async function readSheet(buffer, filename = '') {
  const isCsv = /\.csv$/i.test(filename);
  const { headers, rows } = isCsv ? readCsvBuffer(buffer) : await readWorkbook(buffer);
  if (!headers.length) throw new Error('مالقيناش صف عناوين في الملف');
  // صف فاضي تمامًا بيتشال: Google Forms بيسيب صفوف فاضية في آخر الشيت
  const filled = rows.filter((row) => row.some((cell) => String(cell).trim() !== ''));
  return { headers, rows: filled, sample: filled.slice(0, SAMPLE_ROWS) };
}

// ---------- اقتراح الربط ----------
//
// **بالتطبيع مش بالمطابقة الحرفية.** عنوان العمود في Google Forms بيبقى نص السؤال زي ما
// اتكتب هناك، وفيه فروق دايمًا: ترقيم في الأول، مسافات زيادة، همزات، علامات ترقيم.
// من غير التطبيع ده الاقتراح بيفشل على كل الأسئلة تقريبًا.
function normalizeText(value) {
  return String(value || '')
    .replace(/[ً-ْٰ]/g, '')          // التشكيل
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')                // ترقيم ورموز
    .trim()
    .toLowerCase();
}

// أعمدة الموبايل: الفورم بيسميها بأشكال كتير، وكلها بتتعرف بالكلمة مش بالموضع
const PHONE_HINTS = ['موبايل', 'محمول', 'تليفون', 'هاتف', 'رقم', 'phone', 'mobile', 'whatsapp'];
const NAME_HINTS = ['اسم', 'الاسم', 'name'];

function guessPhoneColumn(headers, rows) {
  // الاسم بيرشّح، والمحتوى بيحسم: عمود اسمه "رقم" ممكن يكون رقم جلوس، والعمود اللي
  // أغلب قيمه أرقام موبايل مصرية هو الموبايل فعلًا مهما كان اسمه
  const scored = headers.map((header, index) => {
    const norm = normalizeText(header);
    const byName = PHONE_HINTS.some((h) => norm.includes(normalizeText(h))) ? 1 : 0;
    const values = rows.slice(0, 50).map((r) => String(r[index] || ''));
    const digits = values.filter((v) => {
      const d = v.replace(/[^0-9]/g, '');
      return d.length >= 10 && d.length <= 15 && /^(0|2|\+?2)?01[0-9]{9}$/.test(d.replace(/^\+/, ''));
    }).length;
    const byContent = values.length ? digits / values.length : 0;
    return { index, header, score: byName * 0.4 + byContent * 0.6 };
  });
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 0.3 ? best.index : null;
}

function guessNameColumn(headers) {
  const index = headers.findIndex((h) => {
    const norm = normalizeText(h);
    return NAME_HINTS.some((hint) => norm.includes(normalizeText(hint)));
  });
  return index >= 0 ? index : null;
}

// بيربط أعمدة الملف بأسئلة الاختبار. بيرجّع اقتراح لكل عمود — والموظف بيراجعه.
//
// **الأسئلة بتتطابق بنصها**، ولو النص في النظام صورة (نص فاضي) مفيش طريقة نطابقه
// تلقائيًا — بيترجع من غير اقتراح والموظف بيختاره بنفسه
function suggestMapping(headers, questions, rows) {
  const byNorm = new Map();
  questions.forEach((q) => {
    const norm = normalizeText(q.text);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, q.id);
  });

  const phoneIndex = guessPhoneColumn(headers, rows);
  const nameIndex = guessNameColumn(headers);

  const columns = headers.map((header, index) => {
    if (index === phoneIndex) return { index, header, role: 'phone', question_id: null };
    if (index === nameIndex) return { index, header, role: 'name', question_id: null };
    const norm = normalizeText(header);
    // مطابقة كاملة الأول، وبعدها احتواء (الفورم بيزوّد ترقيم أو تعليمات على نص السؤال)
    let questionId = byNorm.get(norm) || null;
    if (!questionId && norm.length >= 8) {
      for (const [qNorm, id] of byNorm) {
        if (qNorm.length >= 8 && (norm.includes(qNorm) || qNorm.includes(norm))) { questionId = id; break; }
      }
    }
    return { index, header, role: questionId ? 'question' : 'ignore', question_id: questionId };
  });

  return { columns, phone_index: phoneIndex, name_index: nameIndex };
}

module.exports = {
  readSheet, suggestMapping, normalizeText, cellText,
  MAX_ROWS, MAX_COLUMNS, SAMPLE_ROWS,
};
