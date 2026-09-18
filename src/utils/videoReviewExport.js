// ---------- تصدير أغلاط مراجعة الفيديو PDF ----------
//
// المونتير بيفتح بريمير على شاشة، والورقة دي على الشاشة التانية (أو مطبوعة). فكل غلطة
// لازم تبقى **مستقلة بذاتها**: التوقيت كبير وواضح، وصورة الشاشة تحتها، والتعليق جنبها.
// جدول مضغوط كان هيوفّر ورق ويخلّي المونتير يقرّب عينه على صورة ٢ سم.
//
// نفس نمط `utils/reportExport.js` — نفس puppeteer ونفس فكرة بناء HTML بـdir="rtl"
// وطبعه. اللي زيادة هنا حاجتين: تضمين الصور، والنص المخلوط.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// ---------- التوقيت ----------
//
// التخزين ثواني والعرض HH:MM:SS. الدالتين هنا عشان الكنترولر والـPDF والاستيراد كلهم
// يقروا نفس التعريف — لو الواجهة حسبت الثواني بطريقة والسيرفر بطريقة، الغلطة بتظهر
// عند توقيت تاني في الفيديو ومحدش بياخد باله.

function toSeconds({ hours = 0, minutes = 0, seconds = 0 } = {}) {
  const h = Number(hours) || 0;
  const m = Number(minutes) || 0;
  const s = Number(seconds) || 0;
  return Math.max(0, Math.round(h * 3600 + m * 60 + s));
}

// الساعة بتظهر دايمًا حتى لو صفر (00:12:30) — المونتير بيكتب التوقيت في بريمير زي ما هو،
// و«12:30» بتتقرا ١٢ ساعة ولا ١٢ دقيقة حسب اللي بيقراها
function formatTimecode(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

const STATUS_LABELS = {
  open: 'مفتوحة',
  fixed: 'اتصلّحت',
  rejected: 'مش غلطة',
};

// أهمية الغلطة عند المونتاج. الأيقونة مع النص مش بدله — الورقة ممكن تتطبع أبيض وأسود
const SEVERITY_LABELS = {
  must: '🔴 لازم تتصلح',
  preferred: '🟡 الأفضل تتصلح',
  minor: '⚪ سهلة وتعدي',
};

// ---------- الصور جوه الـPDF ----------
//
// **مسار الصورة نوعين** زي كل مرفقات المشروع (`utils/objectStorage.js`): رابط كامل لما
// التخزين السحابي مفعّل، أو مسار محلي `uploads/...` لما مقفول. الرابط الكامل puppeteer
// بينزّله لوحده مع `networkidle0`، والمحلي **لازم يتحوّل base64**: الصفحة بتتحمّل بـ
// `setContent` من غير عنوان، فـ`/uploads/x.png` مالوش أصل يتحل عليه ويطلع مربع مكسور.
function imageSource(storedPath) {
  const value = String(storedPath || '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  try {
    const key = value.replace(/^\/+/, '');
    const absolute = path.join(__dirname, '..', '..', 'public', key);
    const extension = path.extname(absolute).toLowerCase();
    const mime = extension === '.png' ? 'image/png' : (extension === '.webp' ? 'image/webp' : 'image/jpeg');
    return `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`;
  } catch (error) {
    // الصورة اتمسحت من القرص أو المسار قديم — الملاحظة نفسها لسه مفيدة (التوقيت
    // والتعليق)، فبنطبعها من غير صورة بدل ما التصدير كله يفشل
    console.error('⚠️ Screenshot missing while exporting a video review:', error.message);
    return null;
  }
}

function noteCard(note, index) {
  const source = imageSource(note.screenshot_path);
  const status = STATUS_LABELS[note.status] || note.status;
  const resolution = note.resolution_note
    ? `<div class="resolution"><b>رد المونتاج:</b> <span class="mixed">${escapeHtml(note.resolution_note)}</span></div>`
    : '';

  return `<section class="note">
    <div class="note-head">
      <span class="badge">${index}</span>
      <span class="timecode">${escapeHtml(formatTimecode(note.timecode_seconds))}</span>
      <span class="status sev-${escapeHtml(note.severity || 'must')}">${escapeHtml(SEVERITY_LABELS[note.severity] || SEVERITY_LABELS.must)}</span>
      <span class="status status-${escapeHtml(note.status)}">${escapeHtml(status)}</span>
      <span class="who">${escapeHtml(note.created_by_name || 'غير معروف')}</span>
    </div>
    <div class="note-body">
      ${/* من غير صورة مافيش عمود صورة خالص — المربع الفاضي كان بياخد نص عرض الورقة
           ويضغط التعليق في شريط ضيّق، والملاحظة الصوتية تعليقها هو كل حاجة */ ''}
      ${source ? `<div class="shot"><img src="${escapeHtml(source)}" alt="صورة الغلطة" /></div>` : ''}
      <div class="comment mixed">${escapeHtml(note.comment)}</div>
    </div>
    ${resolution}
  </section>`;
}

function buildHtml(videos, { title, generatedBy }) {
  const totalNotes = videos.reduce((sum, video) => sum + video.notes.length, 0);
  let counter = 0;

  const body = videos.map((video) => {
    // الترتيب في العنوان هو نفس ترتيب البحث عن الملف: الكتاب ← الباب ← الدرس ← الاسم
    const heading = [
      video.book_name,
      video.chapter ? `الباب ${video.chapter}` : null,
      video.video_number ? `الدرس ${video.video_number}` : null,
      video.title,
    ].filter(Boolean).join(' — ');
    // اللينك بيتطبع كنص كامل مش ككلمة «اضغط هنا» — الورقة دي بتتطبع، والمونتير بيقراها
    // من الشاشة التانية. وفي عارض PDF بيفضل قابل للضغط عادي
    const fileHint = [
      video.file_name ? `ملف المونتاج: <span class="ltr">${escapeHtml(video.file_name)}</span>` : '',
      video.video_url
        ? `لينك الفيديو: <a class="ltr" href="${escapeHtml(video.video_url)}">${escapeHtml(video.video_url)}</a>`
        : '',
    ].filter(Boolean).map((line) => `<div class="file-hint">${line}</div>`).join('');
    const cards = video.notes.map((note) => noteCard(note, ++counter)).join('');
    return `<div class="video-block">
      <h2>${escapeHtml(heading)}</h2>
      ${fileHint}
      <div class="video-meta">${video.notes.length} ملاحظة</div>
      ${cards || '<div class="empty">مفيش ملاحظات في الفلتر ده</div>'}
    </div>`;
  }).join('');

  // ⚠️ **`dir="rtl"` مش `dir="auto"`.** التعليقات عربية فيها مصطلحات إنجليزية
  // (`MnO2`، `Premiere`، أسماء ملفات)، و`auto` بيحدّد اتجاه الفقرة من **أول حرف قوي**
  // فيها — فالتعليق اللي بيبدأ بـ«MnO2 مكتوبة غلط» كان هيتقلب كله لليسار وعلامة النقطة
  // تروح لأول السطر. `rtl` بيخلي الفقرة عربية والخوارزمية بتظبّط المقاطع الإنجليزية
  // جواها لوحدها — وده بالظبط اللي احنا عايزينه.
  // و`pre-wrap` عشان سطور التيم متتلزقش في بعض.
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
    /* خلفية بيضا صريحة: printBackground بيطبع اللي متحدّد بس، والورقة من غير ده
       بتطلع بخلفية المتصفح — وده بيبان لما الملف يتفتح في عارض غامق */
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; color: #171b2b;
           background: #fff; padding: 18px 20px; }
    h1 { font-size: 19px; margin: 0 0 4px; }
    .meta { color: #5b6178; font-size: 12px; margin-bottom: 14px; }
    h2 { font-size: 15px; margin: 18px 0 2px; color: #3648d1; }
    .file-hint, .video-meta { color: #5b6178; font-size: 11px; margin-bottom: 4px; }
    .file-hint a { color: #3648d1; }
    .ltr { direction: ltr; unicode-bidi: isolate; display: inline-block; }
    .note { border: 1px solid #e2e5ee; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;
            page-break-inside: avoid; break-inside: avoid; }
    .note-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .badge { background: #3648d1; color: #fff; border-radius: 50%; width: 20px; height: 20px;
             display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
    .timecode { font-family: Consolas, 'Courier New', monospace; font-size: 17px; font-weight: 700;
                direction: ltr; unicode-bidi: isolate; letter-spacing: 0.5px; }
    .status { font-size: 11px; border-radius: 10px; padding: 2px 8px; background: #eaecfb; color: #3648d1; }
    .status-fixed { background: #e3f6ea; color: #1b7f43; }
    .status-rejected { background: #f3f3f5; color: #6b6f7d; }
    .sev-must { background: #fbebea; color: #d1453b; }
    .sev-preferred { background: #fbf1e0; color: #c17f14; }
    .sev-minor { background: #f3f3f5; color: #6b6f7d; }
    .who { color: #5b6178; font-size: 11px; margin-right: auto; }
    .note-body { display: flex; flex-direction: column-reverse; gap: 10px; align-items: stretch; }
    .shot { width: 100%; }
    /* السقف مهم: لقطة طولية (شاشة موبايل مثلًا) بعرض ٥٢٪ بتطلع أطول من الصفحة،
       و"page-break-inside: avoid" ساعتها بيسيب نص الصفحة فاضي قبلها */
    .shot img { max-width: 100%; height: auto; max-height: 150mm;
                border: 1px solid #e2e5ee; border-radius: 6px; }
    .no-shot { border: 1px dashed #d6d9e4; border-radius: 6px; padding: 18px 10px; text-align: center;
               color: #8a8fa0; font-size: 11px; }
    .comment { font-size: 12.5px; line-height: 1.8; }
    .mixed { white-space: pre-wrap; word-wrap: break-word; }
    .resolution { margin-top: 8px; border-top: 1px dashed #e2e5ee; padding-top: 6px; font-size: 11.5px; color: #4a4f63; }
    .empty { color: #8a8fa0; font-size: 12px; }
    .video-block { page-break-inside: auto; }
  </style></head><body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${totalNotes} ملاحظة — تصدير ${escapeHtml(generatedBy || '')} — ${new Date().toLocaleString('ar-EG')}</div>
    ${body || '<div class="empty">مفيش ملاحظات</div>'}
  </body></html>`;
}

async function buildVideoReviewPdf(videos, { title, generatedBy } = {}) {
  const html = buildHtml(videos, { title: title || 'أغلاط مراجعة الفيديوهات', generatedBy });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

// `buildVideoReviewHtml` مصدّر عشان تقدر تعاين الشكل من غير ما تطبع PDF — الفحص
// البصري للنص العربي المخلوط بالإنجليزي مايتعملش غير بالعين، وقراءة PDF على الويندوز
// محتاجة أدوات مش متثبّتة
module.exports = { buildVideoReviewPdf, buildVideoReviewHtml: buildHtml, formatTimecode, toSeconds };
