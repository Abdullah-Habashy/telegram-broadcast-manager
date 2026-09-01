// ---------- بناء ملف نموذج الأسئلة ----------
//
// `public/quiz-template.docx` هو الملف اللي التيم العلمي بينزّله من اللوحة ويكتب أسئلته
// مكانه. **كان مبني بإيد ومن غير سكربت**، يعني أي تعديل فيه كان معناه إعادة بناء يدوية
// ومحدش يعرف اتعمل إزاي. دلوقتي بيتبني من هنا:
//
//     node src/scripts/buildQuizTemplate.js
//
// **الصورة جوه الملف مقصودة.** الميزة كلها عن استيراد الصور، وملف نموذج من غير صورة
// مابيعلّمش الشكل. وهي تحت `س2` مش فوق — الصورة اللي قبل أول سؤال بتوقّف الاستيراد
// لأنها مالهاش سؤال تتنسب له، والنموذج المفروض يوري الشكل الصح.
//
// الـdocx زيب: `[Content_Types].xml` بيعلن الأنواع، و`_rels` بتربط الأجزاء، و
// `word/document.xml` هو المستند، و`word/media` الصور.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const JSZip = require('jszip');

// ---------- رسم صورة المثال ----------
//
// **مرسومة بالكود مش ملف جاهز.** أي ملف صورة كان هيحتاج يتخزّن في المستودع ويتشرح
// جاي منين؛ ٤٠ سطر رياضيات أوضح، والصورة بتفضل قابلة للتعديل.
// شكل خلية نباتية مبسّط: جدار وسيتوبلازم ونواة — بيوضّح "دي صورة سؤال" وخلاص
function drawSampleCell() {
  const width = 320;
  const height = 200;
  const pixels = Buffer.alloc(width * height * 3);

  const paint = (x, y, [r, g, b]) => {
    const at = (y * width + x) * 3;
    pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b;
  };

  const WHITE = [255, 255, 255];
  const WALL = [46, 125, 50];
  const CYTOPLASM = [232, 245, 233];
  const NUCLEUS = [27, 94, 32];

  const centreX = width / 2;
  const centreY = height / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const insideWall = x >= 30 && x <= width - 31 && y >= 25 && y <= height - 26;
      const onWall = insideWall && (x <= 36 || x >= width - 37 || y <= 31 || y >= height - 32);
      const distance = Math.hypot(x - centreX, y - centreY);
      if (distance <= 34) paint(x, y, NUCLEUS);
      else if (onWall) paint(x, y, WALL);
      else if (insideWall) paint(x, y, CYTOPLASM);
      else paint(x, y, WHITE);
    }
  }
  return { width, height, pixels };
}

// ---------- ترميز PNG ----------
// PNG = توقيع + مقاطع. كل مقطع: طول + نوع + بيانات + CRC. الصفر في أول كل سطر هو
// "مفيش فلتر" — أبسط صيغة وحجمها مقبول لصورة بسيطة زي دي
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // ٨ بت للقناة
  header[9] = 2;   // RGB من غير شفافية
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), pixels.subarray(y * width * 3, (y + 1) * width * 3));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- محتوى النموذج ----------
//
// **كل سطور الشرح فوق قبل أول `س`** عن قصد: القارئ بيسقط أي سطر قبل أول سؤال، فالشرح
// بيفضل في الملف للمدرّس ومابيدخلش الاختبار. ولو اتحط بين الأسئلة كان هيتقري اختيار زيادة
const BLOCKS = [
  { text: 'نموذج أسئلة الاختبار', bold: true },
  { text: 'امسح الأمثلة اللي تحت واكتب مكانها أسئلتك بنفس الشكل، وسيب سطر فاضي بين كل سؤال والتاني.' },
  { text: 'رقم السؤال ودرجته: س1 - 2 يعني السؤال الأول عليه درجتين. نص السؤال في السطر اللي تحته.' },
  { text: 'السؤال الاختياري: الاختيارات الأربعة كل واحد في سطر لوحده بالترتيب أ ب جـ د من غير ما تكتب الحروف، وحط *** بعد الاختيار الصح.' },
  { text: 'السؤال المقالي: ج + رقم السؤال، والإجابة النموذجية في السطر اللي تحته.' },
  { text: 'ت + رقم السؤال = تعليمات تصحيح إضافية للسؤال ده، اختيارية.' },
  { text: 'الفروع المقالية: س1أ ثم س1ب وهكذا، والحرف ملزوق بالرقم بدون مسافة.' },
  { text: 'الصور: الزق صورة السؤال في سطر لوحدها تحته — زي سؤال ٢ تحت. صورة واحدة لكل سؤال، ومافيش صور قبل أول سؤال.' },
  { text: '' },

  { text: 'س1 - 2' },
  { text: 'أي مما يلي يُعد من نواتج عملية البناء الضوئي؟' },
  { text: 'ثاني أكسيد الكربون' },
  { text: 'الأكسجين ***' },
  { text: 'النيتروجين' },
  { text: 'الأمونيا' },
  { text: '' },

  { text: 'س2 - 3' },
  { text: 'الشكل التالي يمثّل الخلية النباتية. اذكر اسم الجزء الموضّح في المنتصف ووظيفته.' },
  { image: true },
  { text: 'ج2' },
  { text: 'النواة، وهي المسؤولة عن تنظيم نشاط الخلية وحفظ المادة الوراثية.' },
  { text: 'ت2' },
  { text: 'المطلوب الاسم والوظيفة — الاسم وحده نصف الدرجة.' },
  { text: '' },

  { text: 'س3' },
  { text: 'اقرأ العبارة التالية ثم أجب عن الفروع:' },
  { text: 'ترتفع درجة حرارة الأرض عامًا بعد عام نتيجة تراكم الغازات الدفيئة في الغلاف الجوي.' },
  { text: 'س3أ - 1' },
  { text: 'اذكر اسم الظاهرة التي تصفها العبارة.' },
  { text: 'ج3أ' },
  { text: 'ظاهرة الاحتباس الحراري.' },
  { text: 'س3ب - 2' },
  { text: 'اذكر غازين من الغازات الدفيئة.' },
  { text: 'ج3ب' },
  { text: 'ثاني أكسيد الكربون والميثان.' },
];

// ---------- بناء المستند ----------
const escape = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// bidi على الفقرة وrtl على الحرف — من غيرهم Word بيفتح النص العربي بمحاذاة مقلوبة
const paragraph = (text, bold) =>
  '<w:p><w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr><w:r>'
  + `<w:rPr>${bold ? '<w:b/>' : ''}<w:rtl/></w:rPr>`
  + `<w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;

// DrawingML هو اللي Word نفسه بيكتبه — فالملف بيفتح ويتعدّل ويتحفظ من غير ما يتلخبط.
// المقاسات بالـEMU: ٩١٤٤٠٠ لكل بوصة
const picture = (widthPx, heightPx) => {
  const emu = (px) => Math.round((px / 96) * 914400);
  return '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>'
    + `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(widthPx)}" cy="${emu(heightPx)}"/>`
    + '<wp:docPr id="1" name="صورة السؤال"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:nvPicPr><pic:cNvPr id="1" name="صورة السؤال"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(widthPx)}" cy="${emu(heightPx)}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
};

async function build(outPath) {
  const drawing = drawSampleCell();
  const png = encodePng(drawing);

  const body = BLOCKS.map((block) => (block.image
    ? picture(drawing.width, drawing.height)
    : paragraph(block.text, block.bold))).join('');

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.file('word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cell.png"/>'
    + '</Relationships>');
  zip.file('word/media/cell.png', png);
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + `<w:body>${body}<w:sectPr><w:bidi/></w:sectPr></w:body></w:document>`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outPath, buffer);
  return { bytes: buffer.length, image: png.length };
}

if (require.main === module) {
  const out = path.join(__dirname, '..', '..', 'public', 'quiz-template.docx');
  build(out)
    .then(({ bytes, image }) => console.log(`✅ ${out} — ${bytes} بايت، الصورة ${image} بايت`))
    .catch((error) => { console.error('❌ Failed to build the quiz template:', error.message); process.exit(1); });
}

module.exports = { build };
