const crypto = require('crypto');
const pool = require('../config/db');
const { getCredentials: getTafraCredentials } = require('./tafra.controller');
const { fetchStudentLessonViews, isCompletedByProgress } = require('../utils/lessonViews');
const { UNREACHED_NAMES_SQL, INVALID_NUMBER_SQL, REACHED_CONDITION_SQL } = require('../utils/callOutcomes');

// ===================== تقرير الطالب المشترَك =====================
// صفحة عامة يفتحها ولي الأمر أو الطالب برابط فيه توكن، من غير تسجيل دخول.
//
// **قاعدة الخصوصية:** الصفحة دي بتخرج من نطاق الفريق، فأي حد الرابط يوصله هيشوف اللي فيها.
// عشان كده بتعرض إنجاز الطالب ومتابعتنا ليه بس — ومابتعرضش أبدًا:
//   • ملاحظات المكالمات (call_logs.notes) — كلام داخلي بين الموظفين عن الطالب وأهله
//   • رقم الفكرة الحالية — تصنيف داخلي لسير الشغل، مالوش معنى برّه الفريق
//   • نص المحادثات (support_messages.content / incoming_messages.content)
//   • أي بيانات عن الموظفين (مين رد، مين اتصل)
// أي إضافة للتقرير لازم تعدّي على القاعدة دي الأول.
//
// التوكن عشوائي ٣٢ بايت (٦٤ حرف hex) فمافيش تخمين، وقابل للتجديد: التجديد بيكتب توكن جديد
// فالرابط القديم بيموت فورًا. الإلغاء بيصفّره فالصفحة تبقى ٤٠٤

const TZ = 'Africa/Cairo';

const dateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: true,
});
const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric',
});

function formatDateTime(value) {
  if (!value) return '—';
  return dateTimeFormatter.format(new Date(value));
}

function formatDate(value) {
  if (!value) return '—';
  return dateFormatter.format(new Date(value));
}

// مدة بالثواني → أوضح وحدة تعبّر عنها بالعربي
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const value = Math.max(0, Math.round(Number(seconds)));
  if (value < 60) return `${value} ثانية`;
  if (value < 3600) return `${Math.round(value / 60)} دقيقة`;
  if (value < 86400) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.round((value % 3600) / 60);
    return minutes ? `${hours} ساعة و${minutes} دقيقة` : `${hours} ساعة`;
  }
  const days = Math.floor(value / 86400);
  const hours = Math.round((value % 86400) / 3600);
  return hours ? `${days} يوم و${hours} ساعة` : `${days} يوم`;
}

// دائرة نسبة صغيرة — نصف القطر ١٥.٩١٥٥ بيخلي محيط الدايرة = ١٠٠ بالظبط، فالـ dasharray
// بيتكتب بالنسبة المئوية مباشرة من غير أي حساب. ولي الأمر بيقرا الشكل قبل ما يقرا الرقم
function donutSvg(percent, tone) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return `<svg viewBox="0 0 42 42" class="report-donut ${tone || ''}" role="img" aria-label="${value}%">
    <circle class="report-donut-bg" cx="21" cy="21" r="15.9155" fill="none" stroke-width="4"></circle>
    <circle class="report-donut-fg" cx="21" cy="21" r="15.9155" fill="none" stroke-width="4"
      stroke-dasharray="${value} ${100 - value}" stroke-dashoffset="25" stroke-linecap="round"></circle>
    <text x="21" y="21" class="report-donut-text">${value}%</text>
  </svg>`;
}

// اللون بيتبع المعنى: أخضر كويس، أصفر متوسط، أحمر محتاج انتباه
const donutTone = (percent) => (percent >= 70 ? 'good' : percent >= 40 ? 'mid' : 'low');

const toIntOrNull = (value) => (value === null || value === undefined ? null : Number(value));
const round1 = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);

// ---------- بناء بيانات التقرير ----------
// كل ده من قاعدتنا (سريع). مشاهدات الفيديوهات لوحدها نداء لحظي لمنصة طفرة، فبتتجاب على حدة
// من الصفحة بعد ما تفتح — عشان بطء أو وقوع المنصة مايمنعش باقي التقرير من الظهور
async function buildStudentReport(student) {
  const studentId = Number(student.tafra_student_id);
  const contactId = student.contact_id ? Number(student.contact_id) : null;

  const [exams, examsAvailable, bootcamps, calls, callSummary, engagement, platformActivity] = await Promise.all([
    // النهاية العظمى مش راجعة من المنصة، لكنها مستنتجة بدقة من أي درجة: الدرجة ÷ النسبة × ١٠٠.
    // بتتحسب من **كل** درجات الاختبار مش من درجة الطالب لوحده، عشان اللي جاب صفر (نسبته صفر
    // فمش ممكن نقسم عليها) يبان له كمان "٠ من ١٥". MODE بتاخد أشهر قيمة فالتقريب مايأثرش
    pool.query(`
      WITH exam_totals AS (
        SELECT exam_type, tafra_exam_id,
          MODE() WITHIN GROUP (ORDER BY ROUND(mark / NULLIF(percentage, 0) * 100))::int AS max_mark
        FROM tafra_exam_marks
        WHERE percentage > 0 AND mark IS NOT NULL
        GROUP BY exam_type, tafra_exam_id
      )
      SELECT te.name AS exam_name, te.bootcamp_name, tem.mark, tem.percentage,
        et.max_mark, COALESCE(tem.taken_at, tem.updated_at) AS occurred_at
      FROM tafra_exam_marks tem
      JOIN tafra_exams te ON te.exam_type = tem.exam_type AND te.tafra_exam_id = tem.tafra_exam_id
      LEFT JOIN exam_totals et ON et.exam_type = tem.exam_type AND et.tafra_exam_id = tem.tafra_exam_id
      WHERE tem.tafra_student_id = $1
      ORDER BY occurred_at DESC NULLS LAST`, [studentId]),

    // الاختبارات المتاحة للطالب = اختبارات الأبواب اللي مشترك فيها، زائد أي اختبار عنده فيه
    // درجة فعلًا. الشق التاني مهم لأن المنصة مابترجعش اسم الكورس لكل اختبار، فاختبار دخله
    // الطالب ومالوش اسم كورس كان هيختفي من المقام ويطلع "دخل ٢٥ من ١٢"
    pool.query(`
      SELECT COUNT(*)::int AS available
      FROM tafra_exams te
      WHERE (te.bootcamp_name IS NOT NULL AND EXISTS (
               SELECT 1 FROM tafra_enrollments e
               JOIN tafra_bootcamps tb ON tb.tafra_bootcamp_id = e.tafra_bootcamp_id
               WHERE e.tafra_student_id = $1 AND e.enrollment_type = 'enroll'
                 AND TRIM(tb.name) = TRIM(te.bootcamp_name)))
         OR EXISTS (SELECT 1 FROM tafra_exam_marks m
               WHERE m.exam_type = te.exam_type AND m.tafra_exam_id = te.tafra_exam_id
                 AND m.tafra_student_id = $1)`, [studentId]),

    pool.query(`
      SELECT tb.name, e.enrolled_at
      FROM tafra_enrollments e
      JOIN tafra_bootcamps tb ON tb.tafra_bootcamp_id = e.tafra_bootcamp_id
      WHERE e.tafra_student_id = $1 AND e.enrollment_type = 'enroll'
      ORDER BY e.enrolled_at DESC NULLS LAST`, [studentId]),

    // سجل المكالمات بالتاريخ والوقت والنتيجة — **من غير الملاحظات** (داخلية)
    pool.query(`
      SELECT cl.called_at, COALESCE(co.name, 'بدون نتيجة مسجّلة') AS outcome,
        ${REACHED_CONDITION_SQL} AS reached
      FROM call_logs cl
      LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
      WHERE cl.tafra_student_id = $1
      ORDER BY cl.called_at DESC`, [studentId]),

    pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS answered,
        COUNT(*) FILTER (WHERE co.name IN ${UNREACHED_NAMES_SQL})::int AS no_answer,
        COUNT(*) FILTER (WHERE co.name = ${INVALID_NUMBER_SQL})::int AS wrong_number,
        MIN(cl.called_at) AS first_call_at,
        MAX(cl.called_at) AS last_call_at
      FROM call_logs cl
      LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
      WHERE cl.tafra_student_id = $1`, [studentId]),

    // التفاعل مع رسايلنا: الرسايل المتتالية من غير رد بينها بتتحسب "موجة" واحدة، عشان رسالة
    // مردّش عليها متتحسبش مرتين. نفس منطق قياس سرعة الرد في اللوحة بس بالعكس (إحنا اللي بنبعت)
    contactId ? pool.query(`
      WITH events AS (
        SELECT im.received_at AS at, 1 AS from_student
        FROM incoming_messages im WHERE im.contact_id = $1
        UNION ALL
        SELECT sm.sent_at AS at, 0 AS from_student
        FROM support_messages sm JOIN tickets t ON t.id = sm.ticket_id
        WHERE t.contact_id = $1 AND sm.deleted_at IS NULL
      ),
      numbered AS (
        SELECT at, from_student,
          SUM(from_student) OVER (ORDER BY at, from_student
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS reply_seq
        FROM events
      ),
      our_waves AS (
        SELECT reply_seq, MIN(at) AS sent_at FROM numbered WHERE from_student = 0 GROUP BY reply_seq
      ),
      his_replies AS (
        SELECT reply_seq, MIN(at) AS replied_at FROM numbered WHERE from_student = 1 GROUP BY reply_seq
      )
      SELECT COUNT(*)::int AS messages_sent,
        COUNT(r.replied_at)::int AS replied_to,
        ROUND(AVG(EXTRACT(EPOCH FROM (r.replied_at - w.sent_at))))::int AS avg_reply_seconds,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.replied_at - w.sent_at)))) ::int AS median_reply_seconds
      FROM our_waves w
      LEFT JOIN his_replies r ON r.reply_seq = w.reply_seq + 1
    `, [contactId]) : Promise.resolve({ rows: [{}] }),

    contactId ? pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM incoming_messages im WHERE im.contact_id = $1) AS messages_from_student,
        (SELECT MIN(im.received_at) FROM incoming_messages im WHERE im.contact_id = $1) AS first_message_at,
        (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = $1) AS last_message_at,
        (SELECT COUNT(*)::int FROM support_messages sm JOIN tickets t ON t.id = sm.ticket_id
          WHERE t.contact_id = $1 AND sm.deleted_at IS NULL) AS messages_to_student
    `, [contactId]) : Promise.resolve({ rows: [{}] }),
  ]);

  const examRows = exams.rows.map((row) => ({
    name: (row.exam_name || '').trim(),
    bootcamp: row.bootcamp_name ? row.bootcamp_name.trim() : null,
    mark: row.mark === null ? null : Number(row.mark),
    max_mark: row.max_mark === null || row.max_mark === undefined ? null : Number(row.max_mark),
    percentage: round1(row.percentage),
    occurred_at: row.occurred_at,
    occurred_text: formatDateTime(row.occurred_at),
  }));
  const gradedExams = examRows.filter((row) => row.percentage !== null);
  const examAverage = gradedExams.length
    ? round1(gradedExams.reduce((sum, row) => sum + row.percentage, 0) / gradedExams.length)
    : null;

  const callRows = calls.rows.map((row) => ({
    called_at: row.called_at,
    called_text: formatDateTime(row.called_at),
    outcome: row.outcome,
    reached: Boolean(row.reached),
  }));

  const engagementRow = engagement.rows[0] || {};
  const activityRow = platformActivity.rows[0] || {};
  const messagesSent = Number(engagementRow.messages_sent) || 0;
  const repliedTo = Number(engagementRow.replied_to) || 0;

  return {
    student: {
      name: (student.name || '').trim() || 'الطالب',
      grade_level: student.grade_level || null,
      student_code: student.student_code || null,
      status: student.status || null,
    },
    generated_at_text: formatDateTime(new Date().toISOString()),
    bootcamps: bootcamps.rows.map((row) => ({
      name: (row.name || '').trim(),
      enrolled_text: row.enrolled_at ? formatDate(row.enrolled_at) : null,
    })),
    exams: {
      rows: examRows,
      total: examRows.length,
      // المتاح مايقلّش عن اللي دخله فعلًا مهما حصل — أي فرق كده معناه نقص في بيانات المنصة مش تقدّم
      available: Math.max(examRows.length, Number((examsAvailable.rows[0] || {}).available) || 0),
      graded: gradedExams.length,
      average: examAverage,
      best: gradedExams.length ? Math.max(...gradedExams.map((row) => row.percentage)) : null,
    },
    calls: {
      rows: callRows,
      total: Number((callSummary.rows[0] || {}).total) || 0,
      answered: Number((callSummary.rows[0] || {}).answered) || 0,
      no_answer: Number((callSummary.rows[0] || {}).no_answer) || 0,
      wrong_number: Number((callSummary.rows[0] || {}).wrong_number) || 0,
      first_call_text: formatDateTime((callSummary.rows[0] || {}).first_call_at),
      last_call_text: formatDateTime((callSummary.rows[0] || {}).last_call_at),
    },
    engagement: {
      messages_sent: messagesSent,
      replied_to: repliedTo,
      reply_rate: messagesSent ? Math.round((repliedTo / messagesSent) * 1000) / 10 : null,
      avg_reply_text: formatDuration(toIntOrNull(engagementRow.avg_reply_seconds)),
      median_reply_text: formatDuration(toIntOrNull(engagementRow.median_reply_seconds)),
    },
    activity: {
      messages_from_student: Number(activityRow.messages_from_student) || 0,
      messages_to_student: Number(activityRow.messages_to_student) || 0,
      first_message_text: formatDateTime(activityRow.first_message_at),
      last_message_text: formatDateTime(activityRow.last_message_at),
    },
  };
}

// بيجيب الطالب بالتوكن — نفس الاستعلام مستخدم في صفحة التقرير وفي نداء الفيديوهات
async function findStudentByToken(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const result = await pool.query(`
    SELECT s.tafra_student_id, s.name, s.student_code, s.status, s.grade_level, c.id AS contact_id
    FROM tafra_students s
    LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
    WHERE s.report_token = $1`, [token]);
  return result.rows[0] || null;
}

// ---------- الصفحة العامة ----------

async function renderPublicReport(req, res) {
  try {
    const student = await findStudentByToken(req.params.token);
    // نفس الرد للتوكن الغلط والتوكن الملغي — عشان محدش يقدر يفرّق بينهم بالتجربة
    if (!student) return res.status(404).render('report-not-found');
    const report = await buildStudentReport(student);
    res.render('student-report', { report, token: req.params.token, donutSvg, donutTone });
  } catch (error) {
    console.error('❌ Failed to render student report:', error.message);
    res.status(500).send('تعذر تحميل التقرير، حاول تاني بعد شوية.');
  }
}

// مشاهدات الفيديوهات — نداء لحظي لمنصة طفرة، منفصل عن الصفحة عشان بطئه أو فشله مايأثرش عليها
async function getPublicReportVideos(req, res) {
  try {
    const student = await findStudentByToken(req.params.token);
    if (!student) return res.status(404).json({ error: 'الرابط ده مش صالح' });
    const credentials = await getTafraCredentials();
    if (!credentials) return res.status(503).json({ error: 'بيانات المنصة مش متاحة حاليًا' });
    const data = await fetchStudentLessonViews(credentials, Number(student.tafra_student_id));
    res.json({
      summary: data.summary,
      views: data.views.map((view) => ({
        lesson_name: view.lesson_name,
        bootcamp_name: view.bootcamp_name,
        is_video: view.is_video !== false,
        is_completed: isCompletedByProgress(view),
        progress_percentage: round1(view.progress_percentage),
        watch_progress_seconds: toIntOrNull(view.watch_progress_seconds),
        lesson_duration_seconds: toIntOrNull(view.lesson_duration_seconds),
        watched_text: formatDuration(toIntOrNull(view.watch_progress_seconds)),
        duration_text: formatDuration(toIntOrNull(view.lesson_duration_seconds)),
        viewed_text: formatDateTime(view.viewed_at),
      })),
    });
  } catch (error) {
    console.error('❌ Failed to load public report videos:', error.message);
    res.status(502).json({ error: 'تعذر جلب المشاهدات من المنصة دلوقتي' });
  }
}

// ---------- إدارة الرابط من اللوحة ----------

function reportUrl(req, token) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`;
  return `${base}/r/${token}`;
}

async function getReportLink(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });
  try {
    const result = await pool.query(
      'SELECT name, report_token, report_token_created_at FROM tafra_students WHERE tafra_student_id = $1',
      [studentId]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json({
      student_name: (row.name || '').trim(),
      token: row.report_token,
      url: row.report_token ? reportUrl(req, row.report_token) : null,
      created_at: row.report_token_created_at,
    });
  } catch (error) {
    console.error('❌ Failed to load student report link:', error.message);
    res.status(500).json({ error: 'تعذر تحميل رابط التقرير' });
  }
}

// بيعمل رابط جديد أو بيجدّد الموجود. التجديد بيكتب توكن جديد فوق القديم، فالرابط اللي اتشارك
// قبل كده بيبطّل يشتغل فورًا — دي الطريقة الوحيدة لقفل رابط اتسرّب
async function createReportLink(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });
  try {
    const existing = await pool.query(
      'SELECT report_token FROM tafra_students WHERE tafra_student_id = $1', [studentId]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'الطالب غير موجود' });
    // من غير regenerate بنرجّع الرابط الموجود زي ما هو — عشان الضغط مرتين ما يكسرش رابط متشارك
    if (existing.rows[0].report_token && req.body?.regenerate !== true) {
      return res.json({ token: existing.rows[0].report_token, url: reportUrl(req, existing.rows[0].report_token), created: false });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE tafra_students SET report_token = $1, report_token_created_at = NOW() WHERE tafra_student_id = $2',
      [token, studentId]
    );
    res.json({ token, url: reportUrl(req, token), created: true });
  } catch (error) {
    console.error('❌ Failed to create student report link:', error.message);
    res.status(500).json({ error: 'تعذر إنشاء رابط التقرير' });
  }
}

async function revokeReportLink(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });
  try {
    const result = await pool.query(
      `UPDATE tafra_students SET report_token = NULL, report_token_created_at = NULL
       WHERE tafra_student_id = $1 RETURNING tafra_student_id`, [studentId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to revoke student report link:', error.message);
    res.status(500).json({ error: 'تعذر إلغاء رابط التقرير' });
  }
}

// الوصول من التذكرة: الموظف بيفتح التقرير من المحادثة، فبيحتاج يحوّل التذكرة لطالب الأول
async function resolveStudentIdFromTicket(req, res) {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });
  try {
    const result = await pool.query(`
      SELECT t.assigned_to, s.tafra_student_id
      FROM tickets t
      JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN LATERAL (
        SELECT tafra_student_id FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
      ) s ON true
      WHERE t.id = $1`, [ticketId]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'التذكرة غير موجودة' });
    if (req.session.userRole !== 'admin'
      && row.assigned_to !== null && row.assigned_to !== undefined
      && Number(row.assigned_to) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'التذكرة دي مسندة لموظف تاني' });
    }
    res.json({ tafra_student_id: row.tafra_student_id ? Number(row.tafra_student_id) : null });
  } catch (error) {
    console.error('❌ Failed to resolve student from ticket:', error.message);
    res.status(500).json({ error: 'تعذر تحديد الطالب' });
  }
}

module.exports = {
  renderPublicReport, getPublicReportVideos,
  getReportLink, createReportLink, revokeReportLink, resolveStudentIdFromTicket,
};
