// ---------- صور الأسئلة اللي جوه ملف الـWord ----------
//
// **المشكلة:** الاستيراد كان بيقرا النص بس، وأي صورة في الملف بتتسقط في صمت. الاستيراد
// بينجح، والسؤال بيدخل المحرر من غير صورته، والغلطة مابتبانش غير لما الطالب يفتح
// الامتحان — يعني أي ورقة فيها أشكال لازم الموظف يرفع صورها بإيده واحدة واحدة بعدين.
//
// **الوحدة دي منفصلة عن قارئ الأسئلة عن قصد.** القارئ (`quizDocImport.js`) نضيف: مفيش
// فيه ملفات ولا شبكة ولا مكتبات تقيلة، وعشان كده بيتجرّب بسطر `node -e` واحد. حط
// المكتبة والقرص جواه كان هيلغي الخاصية دي.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { imageMarker } = require('./quizDocImport');
const { storeFile } = require('./objectStorage');

// نفس مجلد صور الأسئلة اليدوية — الصورة اللي جاية من الملف والصورة اللي الموظف بيرفعها
// بإيده مالهمش أي فرق بعد ما يتحفظوا
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');

// المتصفح لازم يعرضها. نفس فلتر الرفع اليدوي، زايد gif وwebp
const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// **دي مش صور — دي رسومات Word الداخلية.** لما المدرّس يكتب معادلة كيميائية في Word،
// أو يلزق رسم من Excel أو PowerPoint، Word بيخزّنها بالصيغ دي والمكتبة بتسلّمها لنا
// على إنها صورة. لو عدّيناها زي أي صورة، **ورقة كيمياء فيها ٦ معادلات هتترفض كلها**
// برسالة "السؤال فيه صورتين" والمدرّس مش فاهم إيه الصورتين أصلًا
const WORD_DRAWINGS = ['image/x-emf', 'image/emf', 'image/x-wmf', 'image/wmf'];

const MAX_IMAGES = 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// أول بايتات الملف بتقول نوعه. بتتستخدم لما Word مايعلنش النوع في المستند — بيحصل
// لما الامتداد مش مذكور في `[Content_Types].xml`
function sniff(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (whole, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (whole, name) => ENTITIES[name.toLowerCase()]);
}

// **الـHTML بيتحوّل لسطور، والصورة بتبقى سطر لوحدها.**
//
// القراءة بقت من تنسيق المستند مش من النص المجرّد، عشان الصور تيجي بمكانها الحقيقي.
// وده معناه إن الحاجات اللي كانت بتختفي في النص المجرّد بقت لازم تتترجم بإيدنا:
// الفقرات وعناصر القوائم وصفوف الجداول بتبقى سطور، وخلايا الصف بتتفصل بمسافة عشان
// الصف يفضل سطر واحد، والكيانات بتترجع لحروفها
function htmlToLines(html) {
  return String(html || '')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const found = tag.match(/src="qzimg:(\d+)"/i);
      return found ? `\n${imageMarker(found[1])}\n` : '';
    })
    .replace(/<\/(p|li|tr|div|blockquote|h[1-6])\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/ /g, ' ').trim())
    .join('\n');
}

// بتقرا الملف مرة واحدة وبترجّع النص ومعاه الصور بترتيبها الحقيقي.
//
// **نداء واحد مش نداءين.** النص والصور طالعين من نفس المرور، فترتيبهم مستحيل يختلف —
// مافيش حساب ربط منفصل ولا احتمال إن صورة تروح لسؤال غلط لأن المرورين مااتفقوش
async function readDocument(buffer) {
  // eslint-disable-next-line global-require
  const mammoth = require('mammoth');
  const handles = [];
  const { value: html } = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async (image) => {
      const index = handles.length;
      handles.push(image);
      return { src: `qzimg:${index}` };
    }),
  });
  return { text: htmlToLines(html), handles };
}

// بتصنّف الصور من غير ما تقرا بايتاتها: الصيغة معروفة من المستند، والقراءة أغلى
function classify(handles) {
  const usable = new Set();
  const drawings = new Set();
  const unsupported = [];
  handles.forEach((handle, index) => {
    const type = String(handle.contentType || '').toLowerCase();
    if (ALLOWED[type]) usable.add(index);
    else if (WORD_DRAWINGS.includes(type)) drawings.add(index);
    else unsupported.push({ index, type });
  });
  return { usable, drawings, unsupported };
}

// بتكتب الصور المطلوبة بس وبترجّع مساراتها. **مابتتناداش غير بعد ما كل التحقق يعدّي** —
// استيراد مرفوض مايسيبش ولا صورة على السيرفر
async function persistImages(handles, indexes, warnings) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const paths = new Map();
  for (const index of indexes) {
    const handle = handles[index];
    try {
      const buffer = await handle.readAsBuffer();
      if (buffer.length > MAX_IMAGE_BYTES) {
        warnings.push('صورة في الملف أكبر من ٨ ميجا واتجاهلت — صغّرها والزقها تاني.');
        continue;
      }
      const type = ALLOWED[String(handle.contentType || '').toLowerCase()] ? handle.contentType : sniff(buffer);
      const filename = `quiz-${crypto.randomUUID()}${ALLOWED[type] || '.jpg'}`;
      const full = path.join(uploadDir, filename);
      await fs.promises.writeFile(full, buffer);
      // نفس اللي بيحصل في الرفع اليدوي: بترفع للسحابة لو متظبّطة وإلا بتفضل على السيرفر
      const stored = await storeFile(full, `uploads/${filename}`);
      paths.set(index, stored.startsWith('http') ? stored : `/${stored}`);
    } catch (error) {
      // الصورة المربوطة بملف برّه المستند بترمي هنا. الأسئلة بتدخل عادي والموظف
      // بيرفعها بإيده — أرحم من إن الملف كله يترفض عشان صورة
      console.error('❌ Failed to store an image from the Word file:', error.message);
      warnings.push('صورة في الملف مقدرناش نقراها — الصقها جوه الملف نفسه بدل ما تكون مربوطة بملف تاني.');
    }
  }
  return paths;
}

module.exports = {
  readDocument, classify, persistImages, htmlToLines,
  MAX_IMAGES, ALLOWED, WORD_DRAWINGS,
};
