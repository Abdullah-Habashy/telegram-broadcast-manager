// توليد تقارير طلاب منصة طفرة بصيغتي Excel وPDF من نفس صفوف البيانات المفلترة
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer');

const REPORT_COLUMNS = [
  { key: 'name', header: 'الاسم', width: 28 },
  { key: 'bootcamp_mark_label', header: 'الباب', width: 10 },
  { key: 'phone', header: 'الهاتف', width: 16 },
  { key: 'parent_phone', header: 'هاتف ولي الأمر', width: 16 },
  { key: 'educational_level', header: 'الصف', width: 18 },
  { key: 'education_type_label', header: 'نوع التعليم', width: 12 },
  { key: 'status_label', header: 'الحالة', width: 12 },
  { key: 'idea_label', header: 'رقم الفكرة', width: 12 },
  { key: 'exam_label', header: 'درجة الاختبار', width: 18 },
  { key: 'telegram_label', header: 'حالة تيليجرام', width: 20 },
  { key: 'last_sent_label', header: 'آخر إرسال', width: 16 },
  { key: 'last_received_label', header: 'آخر استقبال', width: 16 },
];

// نفس علامة الباب البسيطة المستخدمة في كل الشاشات — "1" للباب الأول، "***" للمنهج كاملا، مع بعض لو مشترك في الاتنين
function bootcampMarkLabel(student) {
  const marks = [];
  if (student.in_chapter_one) marks.push('1');
  if (student.in_full_curriculum) marks.push('***');
  return marks.join(' ') || '—';
}

function reportColumns(includeExamColumn) {
  return REPORT_COLUMNS.filter((column) => includeExamColumn || column.key !== 'exam_label');
}

// التقارير محلية بالكامل، فبنشيل مفتاح مصر (+20) ونرجّع الصفر المحلي بدالها — أسهل في القراءة والاتصال
function stripEgyptCountryCode(phone) {
  if (!phone) return phone;
  const trimmed = String(phone).trim();
  if (trimmed.startsWith('+20')) return `0${trimmed.slice(3)}`;
  if (/^20\d{10}$/.test(trimmed)) return `0${trimmed.slice(2)}`;
  return trimmed;
}

function formatReportDate(value) {
  return value ? new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function normalizeStudentRow(student) {
  const telegramLabel = student.can_message
    ? 'بدأ محادثة'
    : (student.telegram_chat_id ? 'لم يبدأ محادثة' : 'غير مرتبط');
  const examLabel = student.exam_mark === undefined
    ? ''
    : (student.exam_mark !== null
      ? `${student.exam_mark}${student.exam_percentage != null ? ` (${student.exam_percentage}%)` : ''}`
      : 'لم يدخل');

  return {
    name: student.name || 'بدون اسم',
    bootcamp_mark_label: bootcampMarkLabel(student),
    phone: stripEgyptCountryCode(student.phone) || '—',
    parent_phone: stripEgyptCountryCode(student.parent_phone) || '—',
    educational_level: student.educational_level || 'غير محدد',
    education_type_label: student.education_type === 'azhar' ? 'أزهري' : 'عام',
    status_label: student.status === 'active' ? 'نشط' : (student.status || 'غير محدد'),
    idea_label: student.current_idea_number ? `فكرة ${student.current_idea_number}` : '—',
    exam_label: examLabel,
    telegram_label: telegramLabel,
    last_sent_label: formatReportDate(student.last_sent_at),
    last_received_label: formatReportDate(student.last_received_at),
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

async function buildStudentsWorkbook(students, { includeExamColumn }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('التقرير', { views: [{ rightToLeft: true }] });
  const columns = reportColumns(includeExamColumn);
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  students.forEach((student) => sheet.addRow(normalizeStudentRow(student)));
  sheet.eachRow((row) => row.eachCell((cell) => {
    cell.alignment = { horizontal: 'right', vertical: 'middle' };
  }));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildStudentsHtml(students, { includeExamColumn, title }) {
  const columns = reportColumns(includeExamColumn);
  const headerRow = columns.map((column) => `<th>${escapeHtml(column.header)}</th>`).join('');
  const bodyRows = students.map((student) => {
    const values = normalizeStudentRow(student);
    return `<tr>${columns.map((column) => `<td>${escapeHtml(values[column.key])}</td>`).join('')}</tr>`;
  }).join('');

  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; padding: 24px; color: #171b2b; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .meta { color: #5b6178; font-size: 12px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #e2e5ee; padding: 6px 8px; text-align: right; }
    th { background: #eaecfb; color: #3648d1; }
    tr { page-break-inside: avoid; }
  </style></head><body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">عدد النتائج: ${students.length} — تاريخ التصدير: ${new Date().toLocaleString('ar-EG')}</div>
    <table><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>
  </body></html>`;
}

async function buildStudentsPdf(students, { includeExamColumn, title }) {
  const html = buildStudentsHtml(students, { includeExamColumn, title });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '10mm', right: '10mm' },
    });
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

module.exports = { buildStudentsWorkbook, buildStudentsPdf };
