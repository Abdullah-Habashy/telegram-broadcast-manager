const pool = require('../config/db');
const { encrypt, decrypt } = require('../utils/crypto');
const { TafraReadOnlyClient, BASE_URL } = require('../integrations/tafraClient');
const reportExport = require('../utils/reportExport');
const { BOOTCAMP_MARKS_SELECT_SQL } = require('../utils/bootcampMarks');
const { inferGenderFromName } = require('../utils/genderInference');

// نفس علامة الباب المستخدمة في صندوق الدعم — بس هنا بنجيبها مباشرة عن طريق s.tafra_student_id
// من غير ما نحتاج نلف على جدول contacts، لأن استعلامات الطلاب أصلاً بتبدأ من tafra_students
const BOOTCAMP_MARKS_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT ${BOOTCAMP_MARKS_SELECT_SQL}
    FROM tafra_enrollments en
    JOIN tafra_bootcamps tb ON tb.tafra_bootcamp_id = en.tafra_bootcamp_id
    WHERE en.tafra_student_id = s.tafra_student_id AND en.enrollment_type = 'enroll'
  ) bootcamp_marks ON true
`;

// آخر تاريخ إرسال رسالة جماعية ناجحة للطالب وآخر رسالة استقبلناها منه — بيظهروا كعمودين في صفحة
// طلاب المنصة لمساعدة الموظف يتفادى إعادة إرسال رسالة جماعية لنفس الطالب مرتين في نفس اليوم
const MESSAGE_TIMELINE_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT MAX(br.sent_at) AS last_sent_at
    FROM broadcast_recipients br WHERE br.contact_id = c.id AND br.status = 'sent'
  ) last_sent ON true
  LEFT JOIN LATERAL (
    SELECT MAX(im.received_at) AS last_received_at
    FROM incoming_messages im WHERE im.contact_id = c.id
  ) last_received ON true
`;

let syncRunning = false;
let enrollmentSyncRunning = false;
let examSyncRunning = false;
let selectiveSyncRunning = false;
let reachabilitySyncRunning = false;

const MARK_RANGE_OPERATORS = {
  under_50: '< 50', over_50: '>= 50',
  under_75: '< 75', over_75: '>= 75',
  over_90: '>= 90',
};

function buildMarkRangeSql(range) {
  const operator = MARK_RANGE_OPERATORS[String(range || '')];
  return operator ? ` AND tem.percentage ${operator}` : '';
}

async function getCredentials() {
  const result = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('tafra_identifier_encrypted', 'tafra_password_encrypted')"
  );
  const values = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  if (!values.tafra_identifier_encrypted || !values.tafra_password_encrypted) return null;
  return {
    identifier: decrypt(values.tafra_identifier_encrypted),
    password: decrypt(values.tafra_password_encrypted),
  };
}

async function saveCredentials(req, res) {
  const identifier = String(req.body.identifier || '').trim();
  const password = String(req.body.password || '');
  if (!identifier || !password) return res.status(400).json({ error: 'رقم الهاتف أو البريد وكلمة المرور مطلوبان' });

  try {
    const client = new TafraReadOnlyClient(identifier, password);
    await client.login();
    await pool.query(
      `INSERT INTO settings (key, value) VALUES
        ('tafra_identifier_encrypted', $1), ('tafra_password_encrypted', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [encrypt(identifier), encrypt(password)]
    );
    res.json({ ok: true, message: 'تم التحقق من الحساب وحفظ بيانات الربط مشفّرة' });
  } catch (error) {
    console.error('Failed to verify Tafra credentials:', error.message);
    res.status(400).json({ error: 'فشل تسجيل الدخول إلى منصة طفرة. راجع بيانات الحساب' });
  }
}

async function getStatus(req, res) {
  try {
    const [statusResult, credentials] = await Promise.all([
      pool.query('SELECT * FROM tafra_sync_status WHERE id = 1'),
      getCredentials(),
    ]);
    res.json({
      configured: Boolean(credentials),
      read_only: true,
      base_url: BASE_URL,
      sync: statusResult.rows[0],
    });
  } catch (error) {
    console.error('Failed to load Tafra status:', error.message);
    res.status(500).json({ error: 'تعذر قراءة حالة ربط منصة طفرة' });
  }
}

// قيم مفصولة بفاصلة (زي ?query=a,b,c) لأي فلتر بيسمح باختيار أكتر من قيمة مرة واحدة
function parseFilterList(raw) {
  return String(raw || '').split(',').map((value) => value.trim()).filter(Boolean);
}

// فلاتر طلاب طفرة — مشتركة بين قائمة العرض (listStudents)، تصدير التقارير (exportStudentsReport)،
// وشاشة المتابعة التليفونية. أي فلتر يتضاف هنا يفضل شغال في التلاتة أماكن من غير تكرار.
// includeEnrollmentDates اختياري (افتراضيًا false) — بس اللي بيستخدمه فعليًا (listStudents/exportStudentsReport)
// لازم يفعّله صراحة، عشان الباراميتر الإضافي بتاعه ميتضافش لمستخدمين تانيين (زي شاشة المتابعة التليفونية)
// من غير ما يرجّعوه في نص استعلامهم — وإلا هيبوظ الـ COUNT بسبب باراميترز زيادة مش متعرّف عليها.
function buildTafraStudentFilters(query, { includeEnrollmentDates = false } = {}) {
  const params = [];
  const conditions = [];
  const addCondition = (value, sql) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  const addArrayCondition = (values, sql, castType) => {
    params.push(values);
    conditions.push(sql.replace('?', `$${params.length}::${castType}[]`));
  };

  const search = String(query.search || '').trim();
  if (search) addCondition(`%${search}%`, `(s.name ILIKE ? OR s.phone ILIKE ? OR s.parent_phone ILIKE ? OR s.student_code ILIKE ? OR s.telegram_username ILIKE ? OR s.telegram_chat_id::text ILIKE ?)`);
  if (search) {
    const placeholder = `$${params.length}`;
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replaceAll('?', placeholder);
  }
  const levels = parseFilterList(query.level);
  if (levels.length) addArrayCondition(levels, 's.grade_level = ANY(?)', 'text');
  const statuses = parseFilterList(query.status);
  if (statuses.length) addArrayCondition(statuses, 's.status = ANY(?)', 'text');
  // نوع الطالب متخمّن من اسمه على المنصة (src/utils/genderInference.js) — تخمين وليس بيانات مؤكدة
  if (query.gender === 'male' || query.gender === 'female') {
    addCondition(query.gender, 's.gender = ?');
  } else if (query.gender === 'unknown') {
    conditions.push('s.gender IS NULL');
  }
  // تيليجرام مايسمحش نبعت لطالب لسه ما تفاعلش مع البوت ولو مرة (حتى لو دوس Start بس)، حتى لو ربط حسابه
  // على منصة طفرة — last_contacted_at بيتحدّث عند /start أو أي رسالة، وده أدق من اشتراط رسالة كاملة
  if (query.telegram === 'started') {
    conditions.push('c.last_contacted_at IS NOT NULL');
  } else if (query.telegram === 'linked_not_started') {
    conditions.push('s.telegram_chat_id IS NOT NULL AND c.last_contacted_at IS NULL');
  } else if (query.telegram === 'linked') {
    conditions.push('s.telegram_chat_id IS NOT NULL');
  } else if (query.telegram === 'unlinked') {
    conditions.push('s.telegram_chat_id IS NULL');
  }
  // حالة التواصل الفعلي — أدق من فلتر تيليجرام لأنه بيفرّق بين "دوس Start بس" و"فعلاً اتكلم معاه"،
  // وكمان بيربطها بموعد المتابعة المحدد للتذكرة (لو موجودة)
  if (query.conversation_status === 'start_only') {
    conditions.push(`c.last_contacted_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id
    )`);
  } else if (query.conversation_status === 'chatted') {
    conditions.push(`EXISTS (SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id) AND t.next_follow_up_at IS NULL`);
  } else if (query.conversation_status === 'chatted_with_follow_up') {
    conditions.push(`EXISTS (SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id) AND t.next_follow_up_at IS NOT NULL`);
  }
  // فلتر حالة المراسلة الجماعية — بيفرّق بين "بدأ محادثة بس لسه ما اتبعتلوش رسالة جماعية" و"اتبعتله
  // رسالة جماعية قبل كده ولسه ما ردش"، عشان يسهّل استبعاد الطلاب اللي اتبعتلهم رسالة أصلًا وقت تجميع
  // جمهور جديد من فلاتر مختلفة (تفادي تكرار الإرسال لنفس الطالب مرتين في نفس اليوم)
  if (query.broadcast_status === 'never_sent') {
    conditions.push(`c.last_contacted_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM broadcast_recipients br WHERE br.contact_id = c.id AND br.status = 'sent'
    )`);
  } else if (query.broadcast_status === 'sent_no_reply') {
    conditions.push(`c.last_contacted_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM broadcast_recipients br WHERE br.contact_id = c.id AND br.status = 'sent')
      AND NOT EXISTS (SELECT 1 FROM incoming_messages im WHERE im.contact_id = c.id)`);
  }
  // استبعاد سريع لمن اتبعتله رسالة جماعية ناجحة اليوم بالفعل — أسرع طريقة لتفادي تكرار الإرسال لنفس
  // الطالب مرتين في نفس اليوم لما يتم تجميع جمهور جديد من فلاتر مختلفة
  if (query.exclude_sent_today === 'true') {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM broadcast_recipients br
      WHERE br.contact_id = c.id AND br.status = 'sent' AND br.sent_at >= CURRENT_DATE
    )`);
  }
  // فلتر تاريخ آخر إرسال/استقبال — نطاق شامل (من/إلى)، بيتحقق من أحدث رسالة مُرسلة/مُستقبلة للطالب
  if (query.last_sent_from && /^\d{4}-\d{2}-\d{2}$/.test(String(query.last_sent_from))) {
    addCondition(query.last_sent_from,
      `(SELECT MAX(br.sent_at) FROM broadcast_recipients br WHERE br.contact_id = c.id AND br.status = 'sent') >= ?::date`);
  }
  if (query.last_sent_to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.last_sent_to))) {
    addCondition(query.last_sent_to,
      `(SELECT MAX(br.sent_at) FROM broadcast_recipients br WHERE br.contact_id = c.id AND br.status = 'sent') < (?::date + INTERVAL '1 day')`);
  }
  if (query.last_received_from && /^\d{4}-\d{2}-\d{2}$/.test(String(query.last_received_from))) {
    addCondition(query.last_received_from,
      `(SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id) >= ?::date`);
  }
  if (query.last_received_to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.last_received_to))) {
    addCondition(query.last_received_to,
      `(SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = c.id) < (?::date + INTERVAL '1 day')`);
  }
  if (query.education_type === 'azhar') conditions.push("s.educational_level #>> '{}' ILIKE '%ازهر%'");
  if (query.education_type === 'general') conditions.push("COALESCE(s.educational_level #>> '{}', '') NOT ILIKE '%ازهر%'");
  // فلتر تاريخ الاشتراك بيشتغل لوحده (أي كورس) أو مع فلتر باب/أكتر — مش لازم الاتنين مع بعض
  const bootcampIds = parseFilterList(query.bootcamp).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (bootcampIds.length || query.enrolled_from || query.enrolled_to) {
    const enrollmentCondition = [`e.tafra_student_id = s.tafra_student_id`, `e.enrollment_type = 'enroll'`];
    if (bootcampIds.length) {
      params.push(bootcampIds);
      enrollmentCondition.push(`e.tafra_bootcamp_id = ANY($${params.length}::bigint[])`);
    }
    if (query.enrolled_from && /^\d{4}-\d{2}-\d{2}$/.test(String(query.enrolled_from))) {
      params.push(query.enrolled_from);
      enrollmentCondition.push(`e.enrolled_at >= $${params.length}::date`);
    }
    if (query.enrolled_to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.enrolled_to))) {
      params.push(query.enrolled_to);
      enrollmentCondition.push(`e.enrolled_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    conditions.push(`EXISTS (SELECT 1 FROM tafra_enrollments e WHERE ${enrollmentCondition.join(' AND ')})`);
  }
  if (query.idea_number && /^\d+$/.test(String(query.idea_number))) {
    if (String(query.idea_number) === '0') {
      conditions.push('(t.current_idea_number IS NULL)');
    } else {
      addCondition(Number(query.idea_number), 't.current_idea_number = ?');
    }
  }
  // فلتر "دخل الاختبار / لم يدخل" + فلتر نسبة الدرجة — بيتطبق على أي اختبار من الاختبارات المحددة (OR بينهم)،
  // وبيتحد مع باقي الفلاتر (AND) من غير ما يأثر عليها
  const examMatches = parseFilterList(query.exam)
    .map((token) => /^(online|offline)-(\d+)$/.exec(token))
    .filter(Boolean);
  if (examMatches.length) {
    const notEntered = query.attendance === 'not_entered';
    const markRangeSql = !notEntered ? buildMarkRangeSql(query.mark_range) : '';
    const examOrConditions = examMatches.map(([, examType, examId]) => {
      params.push(examType);
      const typeParam = `$${params.length}`;
      params.push(Number(examId));
      const idParam = `$${params.length}`;
      return `(tem.exam_type = ${typeParam} AND tem.tafra_exam_id = ${idParam}${markRangeSql})`;
    });
    const existsClause = `EXISTS (
      SELECT 1 FROM tafra_exam_marks tem
      WHERE tem.tafra_student_id = s.tafra_student_id AND (${examOrConditions.join(' OR ')})
    )`;
    conditions.push(notEntered ? `NOT ${existsClause}` : existsClause);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // من هنا وبعدين: باراميترز بتتضاف بس لعرض بيانات إضافية (JOIN) مش لشرط WHERE — استعلامات العدّ (COUNT) اللي
  // بتستخدم whereParams بس لازم توقف هنا، عشان مايتبعتلهاش باراميترز مش متعرّف عليها في نص الاستعلام بتاعها
  const whereParams = [...params];

  // عمود الدرجة في نتيجة العرض بيتضاف بس لو اختبار واحد محدد — لو أكتر من اختبار، القيمة تبقى غامضة فبنسيبها
  let examJoinSql = '';
  let examSelectSql = '';
  if (examMatches.length === 1) {
    const [, examType, examId] = examMatches[0];
    params.push(examType);
    const typeParam = `$${params.length}`;
    params.push(Number(examId));
    const idParam = `$${params.length}`;
    examJoinSql = `LEFT JOIN tafra_exam_marks tem_display
       ON tem_display.tafra_student_id = s.tafra_student_id
      AND tem_display.exam_type = ${typeParam} AND tem_display.tafra_exam_id = ${idParam}`;
    examSelectSql = ', tem_display.mark AS exam_mark, tem_display.percentage AS exam_percentage';
  }

  // تواريخ اشتراك الطالب في الأبواب المحددة بالفلتر بالظبط (وبس هي) — بتتعرض كعمود "تاريخ الاشتراك" في الجدول
  let enrollmentDatesJoinSql = '';
  let enrollmentDatesSelectSql = '';
  if (includeEnrollmentDates && bootcampIds.length) {
    params.push(bootcampIds);
    const idsParam = `$${params.length}`;
    enrollmentDatesJoinSql = `
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'bootcamp_id', se.tafra_bootcamp_id, 'bootcamp_name', setb.name, 'enrolled_at', se.enrolled_at
        ) ORDER BY setb.name) AS dates,
        MIN(se.enrolled_at) AS earliest_enrolled_at
        FROM tafra_enrollments se
        JOIN tafra_bootcamps setb ON setb.tafra_bootcamp_id = se.tafra_bootcamp_id
        WHERE se.tafra_student_id = s.tafra_student_id
          AND se.enrollment_type = 'enroll'
          AND se.tafra_bootcamp_id = ANY(${idsParam}::bigint[])
      ) selected_enrollments ON true`;
    enrollmentDatesSelectSql = ', selected_enrollments.dates AS enrollment_dates, selected_enrollments.earliest_enrolled_at';
  }

  return { where, params, whereParams, examJoinSql, examSelectSql, enrollmentDatesJoinSql, enrollmentDatesSelectSql };
}

async function listStudents(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
  const { where, params, whereParams, examJoinSql, examSelectSql, enrollmentDatesJoinSql, enrollmentDatesSelectSql } =
    buildTafraStudentFilters(req.query, { includeEnrollmentDates: true });
  // ترتيب شامل عبر كل الصفحات (مش بس المعروضة حاليًا) — العمود الوحيد المدعوم دلوقتي هو تاريخ الاشتراك،
  // وبيشتغل بس لو فيه باب/أكتر محدد بالفلتر (هو أصلًا اللي بيظهر معاه عمود التاريخ في الجدول)
  const sortDir = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const orderBySql = req.query.sort === 'enrollment' && enrollmentDatesJoinSql
    ? `selected_enrollments.earliest_enrolled_at ${sortDir} NULLS LAST, s.tafra_student_id DESC`
    : req.query.sort === 'last_sent'
      ? `last_sent.last_sent_at ${sortDir} NULLS LAST, s.tafra_student_id DESC`
      : req.query.sort === 'last_received'
        ? `last_received.last_received_at ${sortDir} NULLS LAST, s.tafra_student_id DESC`
        : 's.tafra_student_id DESC';

  try {
    // استعلام العدّ بياخد where فقط، فلازم يستقبل whereParams بس (مش params الكاملة اللي فيها كمان
    // باراميترز خاصة بأعمدة العرض زي درجة الاختبار وتاريخ الاشتراك، مش موجودة في نص الاستعلام ده)
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       ${where}`,
      whereParams
    );
    const listParams = [...params, limit, (page - 1) * limit];
    const result = await pool.query(
      `SELECT s.tafra_student_id, s.name, s.phone, s.parent_phone, s.status, s.rate,
        s.student_code, s.educational_level #>> '{}' AS educational_level, s.grade_level, s.gender,
        CASE WHEN s.educational_level #>> '{}' ILIKE '%ازهر%' THEN 'azhar' ELSE 'general' END AS education_type,
        s.telegram_linked, s.telegram_username, s.telegram_chat_id,
        s.registration_review_status, s.last_seen_at,
        c.id AS contact_id, t.current_idea_number,
        -- تيليجرام مايسمحش للبوت يبعت لطالب لسه ما بدأش معاه محادثة، حتى لو ربط حسابه على منصة طفرة
        (c.last_contacted_at IS NOT NULL) AS can_message,
        last_sent.last_sent_at, last_received.last_received_at,
        bootcamp_marks.in_chapter_one, bootcamp_marks.in_full_curriculum${examSelectSql}${enrollmentDatesSelectSql}
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       ${BOOTCAMP_MARKS_JOIN_SQL}
       ${MESSAGE_TIMELINE_JOIN_SQL}
       ${examJoinSql}
       ${enrollmentDatesJoinSql}
       ${where}
       ORDER BY ${orderBySql}
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const total = countResult.rows[0].count;
    res.json({ students: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('Failed to list Tafra students:', error.message);
    res.status(500).json({ error: 'تعذر عرض طلاب منصة طفرة' });
  }
}

// معلومات البوتين (يوزر كل واحد بس دلوقتي) — مستخدمة لتجهيز رابط الزرار تلقائيًا في أي اتجاه
// (توجيه لغير البدأ بعد، أو توجيه العكس من بوت طفرة لبوت المتابعة)، بدل ما الموظف يكتب اليوزر يدوي
async function getNewBotInfo(req, res) {
  const newBotManager = require('../bot/newBotManager');
  const botManager = require('../bot/botManager');
  const newUsername = newBotManager.getBotUsername();
  const mainUsername = botManager.getBotUsername();
  if (!newUsername) return res.status(503).json({ error: 'بوت طفرة لسه مش متصل' });

  const lastSendResult = await pool.query(
    `SELECT key, value FROM settings
     WHERE key IN ('newbot_last_message', 'newbot_last_button_text', 'newbot_last_button_url')`
  );
  const lastSend = Object.fromEntries(lastSendResult.rows.map((row) => [row.key, row.value]));

  res.json({
    username: newUsername,
    link: `https://t.me/${newUsername}`,
    main_bot_username: mainUsername || null,
    main_bot_link: mainUsername ? `https://t.me/${mainUsername}` : null,
    last_message: lastSend.newbot_last_message || null,
    last_button_text: lastSend.newbot_last_button_text || null,
    last_button_url: lastSend.newbot_last_button_url || null,
  });
}

// قايمة الطلاب اللي بدأوا "بوت طفرة" بالفعل (اشتركوا فيه) — عشان نقدر نبعتلهم رسالة منه هو
// نفسه (مش من بوت المتابعة)، زي مثلًا رسالة فيها رابط بوت المتابعة لو محتاجين يرجعوله.
// بنعمل LEFT JOIN بـ tafra_students وcontacts (عن طريق chat_id) عشان نقدر نستخدم نفس فلاتر
// الباب/النوع/حالة بوت المتابعة المستخدمة في تاب التوجيه، ونعرض نفس أسلوب العرض (اسم + كود + هاتف)
// مشتركة بين قائمة العرض (listNewBotContacts) وقائمة كل المعرّفات المطابقة (listNewBotContactIds)
function buildNewBotContactFilters(query) {
  const search = String(query.search || '').trim();
  const params = [];
  const conditions = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(nbc.first_name ILIKE $${params.length} OR nbc.last_name ILIKE $${params.length} OR nbc.telegram_username ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
  }
  if (query.gender === 'male' || query.gender === 'female') {
    params.push(query.gender);
    conditions.push(`s.gender = $${params.length}`);
  } else if (query.gender === 'unknown') {
    conditions.push('s.gender IS NULL');
  }
  if (query.telegram === 'started') {
    conditions.push('c.last_contacted_at IS NOT NULL');
  } else if (query.telegram === 'linked_not_started') {
    conditions.push('c.last_contacted_at IS NULL');
  }
  const bootcampIds = parseFilterList(query.bootcamp).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (bootcampIds.length) {
    params.push(bootcampIds);
    conditions.push(`EXISTS (
      SELECT 1 FROM tafra_enrollments e
      WHERE e.tafra_student_id = s.tafra_student_id AND e.enrollment_type = 'enroll'
        AND e.tafra_bootcamp_id = ANY($${params.length}::bigint[])
    )`);
  }
  // استبعاد من اتبعتله رسالة عن طريق بوت طفرة نفسه اليوم بالفعل — لتفادي تكرار الإرسال لنفس المشترك مرتين
  if (query.exclude_sent_today === 'true') {
    conditions.push('(nbc.last_broadcast_at IS NULL OR nbc.last_broadcast_at < CURRENT_DATE)');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const joins = `
    LEFT JOIN tafra_students s ON s.telegram_chat_id = nbc.chat_id
    LEFT JOIN contacts c ON c.chat_id = nbc.chat_id
  `;
  return { where, params, joins };
}

async function listNewBotContacts(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const { where, params, joins } = buildNewBotContactFilters(req.query);
  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM new_bot_contacts nbc ${joins} ${where}`, params
    );
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT nbc.id, nbc.chat_id, nbc.telegram_username, nbc.first_name, nbc.last_name,
        nbc.started_at, nbc.source, s.name AS tafra_name, s.phone, s.student_code,
        (c.last_contacted_at IS NOT NULL) AS followup_started
       FROM new_bot_contacts nbc ${joins}
       ${where}
       ORDER BY nbc.started_at DESC NULLS LAST
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const total = countResult.rows[0].count;
    res.json({ contacts: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('Failed to list new-bot contacts:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة مشتركي بوت طفرة' });
  }
}

// كل chat_id بتاع المشتركين المطابقين لنفس فلاتر listNewBotContacts بالظبط، بدون تقسيم صفحات —
// عشان زرار "تحديد كل النتائج" يقدر يحدد كل المشتركين المطابقين مش بس الصفحة المعروضة
async function listNewBotContactIds(req, res) {
  const { where, params, joins } = buildNewBotContactFilters(req.query);
  try {
    const result = await pool.query(
      `SELECT nbc.chat_id FROM new_bot_contacts nbc ${joins} ${where} ORDER BY nbc.started_at DESC NULLS LAST`,
      params
    );
    res.json({ chat_ids: result.rows.map((row) => Number(row.chat_id)) });
  } catch (error) {
    console.error('Failed to list new-bot contact ids:', error.message);
    res.status(500).json({ error: 'تعذر تحميل معرّفات المشتركين' });
  }
}

// إرسال رسالة جماعية عن طريق "بوت طفرة" نفسه لمشتركين فيه بالفعل (المخاطبين المحددين لازم يكونوا
// موجودين في new_bot_contacts أصلًا — تليجرام مايسمحش نبعت لحد لسه ما بدأش نفس البوت ده)
async function sendNewBotBroadcast(req, res) {
  const newBotManager = require('../bot/newBotManager');
  const bot = newBotManager.getBot();
  if (!bot) return res.status(503).json({ error: 'بوت طفرة غير متصل حاليًا' });

  const chatIds = Array.isArray(req.body.chat_ids)
    ? [...new Set(req.body.chat_ids.map(Number).filter((id) => Number.isInteger(id)))]
    : [];
  const message = String(req.body.message || '').trim();
  const buttonText = String(req.body.button_text || '').trim() || null;
  const buttonUrl = String(req.body.button_url || '').trim() || null;

  if (!chatIds.length) return res.status(400).json({ error: 'اختر مشترك واحد على الأقل' });
  if (!message) return res.status(400).json({ error: 'اكتب نص الرسالة' });
  if (buttonText && !buttonUrl) return res.status(400).json({ error: 'حطيت نص للزرار من غير رابط' });
  if (buttonUrl && !/^https?:\/\//i.test(buttonUrl)) return res.status(400).json({ error: 'رابط الزرار لازم يبدأ بـ http:// أو https://' });

  const replyMarkup = buttonText && buttonUrl
    ? { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
    : undefined;

  const contactsResult = await pool.query(
    'SELECT chat_id, first_name FROM new_bot_contacts WHERE chat_id = ANY($1::bigint[])',
    [chatIds]
  );

  let sent = 0;
  let failed = 0;
  const sentChatIds = [];
  for (const contact of contactsResult.rows) {
    try {
      const personalized = message.replaceAll('الاسم', contact.first_name || 'صديقنا');
      await bot.telegram.sendMessage(contact.chat_id, personalized, { reply_markup: replyMarkup });
      sent += 1;
      sentChatIds.push(contact.chat_id);
    } catch (error) {
      failed += 1;
      console.error(`❌ Failed to send new-bot broadcast to chat ${contact.chat_id}:`, error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (sentChatIds.length) {
    await pool.query(
      'UPDATE new_bot_contacts SET last_broadcast_at = NOW() WHERE chat_id = ANY($1::bigint[])',
      [sentChatIds]
    );
    // بنحفظ آخر رسالة وزرار اتبعتوا فعليًا كقيم افتراضية جاهزة لأي إرسال جديد — بيوفّر على الموظف
    // إعادة كتابة نفس الرسالة تاني لو محتاج يبعتها لمجموعة تانية بعدين
    await pool.query(
      `INSERT INTO settings (key, value) VALUES
        ('newbot_last_message', $1), ('newbot_last_button_text', $2), ('newbot_last_button_url', $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [message, buttonText || '', buttonUrl || '']
    );
  }
  res.json({ sent, failed, total: contactsResult.rows.length });
}

// لوج زمني لكل طالب دخل بوت المتابعة فعليًا لأول مرة — tickets.created_at بيتسجّل مرة واحدة بس بالظبط
// وقت أول /start حقيقي لأي جهة اتصال (شوف start.js: التذكرة بتتنشأ بس لو isNewContact)، فهو أدق مصدر
// لتاريخ "الدخول" المتاح عندنا، بغض النظر هل جهة الاتصال جاية من مزامنة طفرة أو من بدء عضوي على البوت
async function getFollowUpBotStartLog(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const search = String(req.query.search || '').trim();
  const params = [];
  const conditions = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length}
      OR c.telegram_username ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM contacts c JOIN tickets t ON t.contact_id = c.id ${where}`,
      params
    );
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT c.id AS contact_id, c.chat_id, c.telegram_username, c.first_name, c.last_name, c.phone,
        t.created_at AS started_at
       FROM contacts c JOIN tickets t ON t.contact_id = c.id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    const total = countResult.rows[0].count;
    res.json({ entries: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('Failed to load follow-up bot start log:', error.message);
    res.status(500).json({ error: 'تعذر تحميل لوج دخول بوت المتابعة' });
  }
}

// بوت طفرة هو نفس بوت منصة طفرة الرسمي (اللي بتستخدمه المنصة نفسها في ربط حساب الطالب) — يعني كتير
// من الطلاب أصلاً ضغطوا Start عليه قبل ما نضيف الهاندلر بتاعنا إحنا، فمش هيظهروا في new_bot_contacts
// غير كده. الفحص ده بيتأكد فعليًا (getChat، من غير إرسال أي رسالة) مين من الطلاب المرتبطين (عندهم
// telegram_chat_id) قابل للمراسلة بالفعل، ويسجّله بـ source='platform_link' (بدون started_at حقيقي
// لأننا مش عارفين متى فعلًا بدأ). عملية طويلة نسبيًا (آلاف الطلاب) فبتشتغل في الخلفية زي باقي المزامنات.
async function performReachabilitySync() {
  reachabilitySyncRunning = true;
  const newBotManager = require('../bot/newBotManager');
  const bot = newBotManager.getBot();
  let checked = 0;
  let found = 0;
  try {
    const candidates = await pool.query(
      `SELECT s.telegram_chat_id, s.telegram_username, s.name
       FROM tafra_students s
       WHERE s.telegram_chat_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM new_bot_contacts nbc WHERE nbc.chat_id = s.telegram_chat_id)`
    );
    const rows = candidates.rows;
    await pool.query(
      `UPDATE new_bot_reachability_sync_status SET status='running', checked_count=0,
       total_count=$1, found_reachable=0, started_at=NOW(), completed_at=NULL,
       error_message=NULL, updated_at=NOW() WHERE id=1`,
      [rows.length]
    );

    for (const row of rows) {
      try {
        const chat = await bot.telegram.getChat(row.telegram_chat_id);
        await pool.query(
          `INSERT INTO new_bot_contacts (chat_id, telegram_username, first_name, started_at, source)
           VALUES ($1, $2, $3, NULL, 'platform_link')
           ON CONFLICT (chat_id) DO NOTHING`,
          [row.telegram_chat_id, chat.username || row.telegram_username || null, chat.first_name || row.name || null]
        );
        found += 1;
      } catch (error) {
        // مش قابل للمراسلة فعليًا (لسه ما ضغطش Start، أو بلوك البوت) — متوقّع لجزء من الطلاب، نتجاهله ونكمل
      }
      checked += 1;
      if (checked % 20 === 0) {
        await pool.query(
          `UPDATE new_bot_reachability_sync_status SET checked_count=$1, found_reachable=$2, updated_at=NOW() WHERE id=1`,
          [checked, found]
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    await pool.query(
      `UPDATE new_bot_reachability_sync_status SET status='completed', checked_count=$1,
       found_reachable=$2, completed_at=NOW(), updated_at=NOW() WHERE id=1`,
      [checked, found]
    );
  } catch (error) {
    console.error('Failed to sync new-bot reachability:', error.message);
    await pool.query(
      `UPDATE new_bot_reachability_sync_status SET status='failed', error_message=$1,
       completed_at=NOW(), updated_at=NOW() WHERE id=1`,
      [String(error.message).slice(0, 1000)]
    ).catch(() => {});
  } finally {
    reachabilitySyncRunning = false;
  }
}

async function syncNewBotReachability(req, res) {
  if (reachabilitySyncRunning) return res.status(409).json({ error: 'فحص الوصول جارٍ بالفعل' });
  const newBotManager = require('../bot/newBotManager');
  if (!newBotManager.getBot()) return res.status(503).json({ error: 'بوت طفرة غير متصل حاليًا' });
  performReachabilitySync().catch((error) => console.error('Unexpected reachability sync failure:', error.message));
  res.status(202).json({ ok: true, message: 'بدأ فحص حالة الوصول الفعلية في الخلفية' });
}

async function getNewBotReachabilitySyncStatus(req, res) {
  try {
    const result = await pool.query('SELECT * FROM new_bot_reachability_sync_status WHERE id = 1');
    res.json({ sync: result.rows[0] });
  } catch (error) {
    console.error('Failed to load reachability sync status:', error.message);
    res.status(500).json({ error: 'تعذر تحميل حالة فحص الوصول' });
  }
}

// كل معرّفات جهات الاتصال (contact_id) للطلاب المطابقين لنفس فلاتر صفحة "طلاب المنصة" بالظبط،
// بدون تقسيم صفحات — عشان زرار "تحديد كل الصفحات" يقدر يحدد كل الطلاب المطابقين مش بس صفحة واحدة.
// بيرجّع بس اللي ممكن نراسلهم فعليًا (بدأوا محادثة مع البوت قبل كده) بنفس شرط canMessageStudent بالفرونت
async function listStudentContactIds(req, res) {
  const { where, whereParams } = buildTafraStudentFilters(req.query);
  try {
    const result = await pool.query(
      `SELECT c.id AS contact_id
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       ${where ? `${where} AND` : 'WHERE'} c.id IS NOT NULL AND c.last_contacted_at IS NOT NULL
       ORDER BY s.tafra_student_id DESC`,
      whereParams
    );
    res.json({ ids: result.rows.map((row) => Number(row.contact_id)) });
  } catch (error) {
    console.error('Failed to list Tafra student contact ids:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة معرّفات الطلاب' });
  }
}

// تصدير تقرير Excel/PDF بنفس فلاتر صفحة الطلاب بالظبط — بدون تقسيم صفحات، كل النتائج المطابقة
async function exportStudentsReport(req, res) {
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) {
    return res.status(400).json({ error: 'صيغة التقرير غير مدعومة' });
  }

  const { where, params, examJoinSql, examSelectSql, enrollmentDatesJoinSql, enrollmentDatesSelectSql } =
    buildTafraStudentFilters(req.query, { includeEnrollmentDates: true });
  const includeExamColumn = Boolean(examSelectSql);

  try {
    const result = await pool.query(
      `SELECT s.name, s.phone, s.parent_phone, s.status,
        s.educational_level #>> '{}' AS educational_level, s.grade_level, s.gender,
        CASE WHEN s.educational_level #>> '{}' ILIKE '%ازهر%' THEN 'azhar' ELSE 'general' END AS education_type,
        s.telegram_chat_id, t.current_idea_number,
        (c.last_contacted_at IS NOT NULL) AS can_message,
        last_sent.last_sent_at, last_received.last_received_at,
        bootcamp_marks.in_chapter_one, bootcamp_marks.in_full_curriculum${examSelectSql}${enrollmentDatesSelectSql}
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       ${BOOTCAMP_MARKS_JOIN_SQL}
       ${MESSAGE_TIMELINE_JOIN_SQL}
       ${examJoinSql}
       ${enrollmentDatesJoinSql}
       ${where}
       ORDER BY s.tafra_student_id DESC`,
      params
    );

    const title = 'تقرير طلاب منصة طفرة';
    const filenameBase = `tafra-students-report-${new Date().toISOString().slice(0, 10)}`;

    if (format === 'xlsx') {
      const buffer = await reportExport.buildStudentsWorkbook(result.rows, { includeExamColumn });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
      res.send(buffer);
    } else {
      const buffer = await reportExport.buildStudentsPdf(result.rows, { includeExamColumn, title });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
      res.send(buffer);
    }
  } catch (error) {
    console.error('Failed to export Tafra students report:', error.message);
    res.status(500).json({ error: 'تعذر إنشاء التقرير' });
  }
}

const EXAM_TYPE_LABELS = { online: 'أونلاين', offline: 'ورقي' };

async function getStudentFilters(req, res) {
  try {
    const [levels, statuses, bootcamps, exams, enrollmentStatus, maxIdeaResult] = await Promise.all([
      pool.query('SELECT DISTINCT grade_level AS value FROM tafra_students WHERE grade_level IS NOT NULL ORDER BY value'),
      pool.query('SELECT DISTINCT status AS value FROM tafra_students WHERE status IS NOT NULL ORDER BY value'),
      pool.query('SELECT tafra_bootcamp_id AS id, name FROM tafra_bootcamps WHERE is_available = TRUE ORDER BY name'),
      pool.query('SELECT exam_type, tafra_exam_id, name FROM tafra_exams WHERE is_available = TRUE ORDER BY name'),
      pool.query('SELECT * FROM tafra_enrollment_sync_status WHERE id = 1'),
      pool.query("SELECT value FROM settings WHERE key = 'max_idea_number'"),
    ]);
    const maxIdea = Number(maxIdeaResult.rows[0]?.value) || 20;
    res.json({
      levels: levels.rows.map((row) => row.value),
      statuses: statuses.rows.map((row) => row.value),
      bootcamps: bootcamps.rows,
      exams: exams.rows.map((row) => ({
        id: `${row.exam_type}-${row.tafra_exam_id}`,
        name: `${row.name} — ${EXAM_TYPE_LABELS[row.exam_type] || row.exam_type}`,
      })),
      enrollment_sync: enrollmentStatus.rows[0],
      max_idea_number: maxIdea,
    });
  } catch (error) {
    console.error('Failed to load Tafra filters:', error.message);
    res.status(500).json({ error: 'تعذر تحميل فلاتر الطلاب' });
  }
}

async function syncBootcampNames(req, res) {
  const credentials = await getCredentials();
  if (!credentials) return res.status(400).json({ error: 'احفظ بيانات ربط منصة طفرة أولًا' });
  const dbClient = await pool.connect();
  try {
    const tafra = new TafraReadOnlyClient(credentials.identifier, credentials.password);
    const response = await tafra.getBootcamps();
    const bootcamps = Array.isArray(response.data) ? response.data : [];
    if (!bootcamps.length) return res.status(502).json({ error: 'لم تُرجع المنصة أي أبواب؛ لم يتم تغيير القائمة المحلية' });

    await dbClient.query('BEGIN');
    await dbClient.query('UPDATE tafra_bootcamps SET is_available = FALSE');
    for (const bootcamp of bootcamps) {
      await dbClient.query(
        `INSERT INTO tafra_bootcamps (tafra_bootcamp_id,name,is_available,updated_at)
         VALUES ($1,$2,TRUE,NOW())
         ON CONFLICT (tafra_bootcamp_id) DO UPDATE SET
           name=EXCLUDED.name,is_available=TRUE,updated_at=NOW()`,
        [bootcamp.id, bootcamp.name]
      );
    }
    await dbClient.query('COMMIT');
    res.json({ ok: true, count: bootcamps.length, message: `تم تحديث أسماء ${bootcamps.length} أبواب وكورسات` });
  } catch (error) {
    await dbClient.query('ROLLBACK').catch(() => {});
    console.error('Failed to sync Tafra bootcamp names:', error.message);
    res.status(500).json({ error: 'تعذر تحديث أسماء الأبواب من المنصة' });
  } finally {
    dbClient.release();
  }
}

async function saveEnrollmentPage(dbClient, bootcampId, rows) {
  if (!rows.length) return;
  const latestByStudent = new Map();
  for (const row of rows) {
    if (!row.student_id) continue;
    const previous = latestByStudent.get(String(row.student_id));
    const rowTime = new Date(row.created_at || 0).getTime();
    const previousTime = new Date(previous?.created_at || 0).getTime();
    if (!previous || rowTime > previousTime || (rowTime === previousTime && Number(row.id) > Number(previous.id))) {
      latestByStudent.set(String(row.student_id), row);
    }
  }
  const normalizedRows = [...latestByStudent.values()].map((row) => ({
    ...row, raw_data: row, gender: inferGenderFromName(row.student_name),
  }));
  await dbClient.query(
    `INSERT INTO tafra_enrollments
      (tafra_bootcamp_id, tafra_student_id, tafra_enrollment_id, enrollment_type,
       enrolled_at, is_locked, raw_data, updated_at)
     SELECT $1, x.student_id, x.id, COALESCE(x.type, 'enroll'), x.created_at,
       COALESCE(x.is_locked, FALSE), x.raw_data, NOW()
     FROM jsonb_to_recordset($2::jsonb) AS x(
       id bigint, student_id bigint, type text, created_at timestamptz,
       is_locked boolean, raw_data jsonb
     )
     WHERE x.student_id IS NOT NULL
     ON CONFLICT (tafra_bootcamp_id, tafra_student_id) DO UPDATE SET
       tafra_enrollment_id = EXCLUDED.tafra_enrollment_id,
       enrollment_type = EXCLUDED.enrollment_type,
       enrolled_at = EXCLUDED.enrolled_at,
       is_locked = EXCLUDED.is_locked,
       raw_data = EXCLUDED.raw_data,
       updated_at = NOW()
     WHERE tafra_enrollments.enrolled_at IS NULL
        OR EXCLUDED.enrolled_at >= tafra_enrollments.enrolled_at`,
    [bootcampId, JSON.stringify(normalizedRows)]
  );

  // بيانات الاشتراك تحتوي الحد الأدنى اللازم لعرض الطالب حتى لو لم تصل
  // صفحته بعد ضمن مزامنة قائمة الطلاب العامة.
  await dbClient.query(
    `INSERT INTO tafra_students
      (tafra_student_id, name, phone, parent_phone, raw_data, gender, last_seen_at, updated_at)
     SELECT x.student_id, x.student_name, x.phone, x.parent_phone, x.raw_data, x.gender, NOW(), NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(
       student_id bigint, student_name text, phone text, parent_phone text, raw_data jsonb, gender text
     )
     WHERE x.student_id IS NOT NULL
     ON CONFLICT (tafra_student_id) DO UPDATE SET
       name = COALESCE(tafra_students.name, EXCLUDED.name),
       phone = COALESCE(tafra_students.phone, EXCLUDED.phone),
       parent_phone = COALESCE(tafra_students.parent_phone, EXCLUDED.parent_phone),
       gender = COALESCE(tafra_students.gender, EXCLUDED.gender),
       updated_at = NOW()`,
    [JSON.stringify(normalizedRows)]
  );
}

async function performEnrollmentSync(credentials) {
  enrollmentSyncRunning = true;
  let synced = 0;
  try {
    await pool.query(
      `UPDATE tafra_enrollment_sync_status SET status='running', current_bootcamp=0,
       total_bootcamps=0, synced_enrollments=0, started_at=NOW(), completed_at=NULL,
       error_message=NULL, updated_at=NOW() WHERE id=1`
    );
    const tafra = new TafraReadOnlyClient(credentials.identifier, credentials.password);
    const bootcampResponse = await tafra.getBootcamps();
    const bootcamps = Array.isArray(bootcampResponse.data) ? bootcampResponse.data : [];
    for (const bootcamp of bootcamps) {
      await pool.query(
        `INSERT INTO tafra_bootcamps (tafra_bootcamp_id,name,updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (tafra_bootcamp_id) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW()`,
        [bootcamp.id, bootcamp.name]
      );
    }
    await pool.query('UPDATE tafra_enrollment_sync_status SET total_bootcamps=$1,updated_at=NOW() WHERE id=1', [bootcamps.length]);

    for (let index = 0; index < bootcamps.length; index += 1) {
      const bootcamp = bootcamps[index];
      const first = await tafra.getBootcampEnrollmentsPage(bootcamp.id, 1);
      const totalPages = Number(first.data?.meta?.last_page || 1);
      for (let page = 1; page <= totalPages; page += 1) {
        const response = page === 1 ? first : await tafra.getBootcampEnrollmentsPage(bootcamp.id, page);
        const rows = Array.isArray(response.data?.data) ? response.data.data : [];
        await saveEnrollmentPage(pool, bootcamp.id, rows);
        synced += rows.length;
        await pool.query(
          `UPDATE tafra_enrollment_sync_status SET current_bootcamp=$1,
           synced_enrollments=$2,updated_at=NOW() WHERE id=1`,
          [index + 1, synced]
        );
        if (page < totalPages) await tafra.waitForRateLimit();
      }
    }
    await pool.query(
      `UPDATE tafra_enrollment_sync_status SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=1`
    );
  } catch (error) {
    console.error('Failed to sync Tafra enrollments:', error.message);
    await pool.query(
      `UPDATE tafra_enrollment_sync_status SET status='failed',error_message=$1,
       completed_at=NOW(),updated_at=NOW() WHERE id=1`,
      [String(error.message).slice(0, 1000)]
    ).catch(() => {});
  } finally {
    enrollmentSyncRunning = false;
  }
}

async function syncEnrollments(req, res) {
  if (enrollmentSyncRunning) return res.status(409).json({ error: 'تحديث اشتراكات الأبواب جارٍ بالفعل' });
  const credentials = await getCredentials();
  if (!credentials) return res.status(400).json({ error: 'احفظ بيانات ربط منصة طفرة أولًا' });
  performEnrollmentSync(credentials).catch((error) => console.error('Unexpected enrollment sync failure:', error.message));
  res.status(202).json({ ok: true, message: 'بدأ تحديث اشتراكات الأبواب في الخلفية' });
}

// تحديث بيانات طلاب أبواب/كورسات مختارة بس (مش كل بيانات المنصة ومش كل الأبواب) — نفس منطق
// تحديث الاشتراكات الشامل لكنه بيلف بس على القايمة اللي المستخدم اختارها
async function performSelectiveSync(credentials, bootcamps) {
  selectiveSyncRunning = true;
  let synced = 0;
  try {
    await pool.query(
      `UPDATE tafra_selective_sync_status SET status='running', current_bootcamp=0,
       total_bootcamps=$1, synced_enrollments=0, bootcamp_names=$2, started_at=NOW(), completed_at=NULL,
       error_message=NULL, updated_at=NOW() WHERE id=1`,
      [bootcamps.length, bootcamps.map((b) => b.name).join('، ')]
    );
    const tafra = new TafraReadOnlyClient(credentials.identifier, credentials.password);

    for (let index = 0; index < bootcamps.length; index += 1) {
      const bootcamp = bootcamps[index];
      const first = await tafra.getBootcampEnrollmentsPage(bootcamp.id, 1);
      const totalPages = Number(first.data?.meta?.last_page || 1);
      for (let page = 1; page <= totalPages; page += 1) {
        const response = page === 1 ? first : await tafra.getBootcampEnrollmentsPage(bootcamp.id, page);
        const rows = Array.isArray(response.data?.data) ? response.data.data : [];
        await saveEnrollmentPage(pool, bootcamp.id, rows);
        synced += rows.length;
        await pool.query(
          `UPDATE tafra_selective_sync_status SET current_bootcamp=$1,
           synced_enrollments=$2,updated_at=NOW() WHERE id=1`,
          [index + 1, synced]
        );
        if (page < totalPages) await tafra.waitForRateLimit();
      }
    }
    await pool.query(
      `UPDATE tafra_selective_sync_status SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=1`
    );
  } catch (error) {
    console.error('Failed to sync selected Tafra bootcamps:', error.message);
    await pool.query(
      `UPDATE tafra_selective_sync_status SET status='failed',error_message=$1,
       completed_at=NOW(),updated_at=NOW() WHERE id=1`,
      [String(error.message).slice(0, 1000)]
    ).catch(() => {});
  } finally {
    selectiveSyncRunning = false;
  }
}

async function syncSelectedBootcamps(req, res) {
  if (selectiveSyncRunning) return res.status(409).json({ error: 'تحديث الأبواب المختارة جارٍ بالفعل' });
  const bootcampIds = Array.isArray(req.body.bootcamp_ids)
    ? [...new Set(req.body.bootcamp_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  if (!bootcampIds.length) return res.status(400).json({ error: 'اختر بابًا واحدًا على الأقل' });

  const credentials = await getCredentials();
  if (!credentials) return res.status(400).json({ error: 'احفظ بيانات ربط منصة طفرة أولًا' });

  const bootcampsResult = await pool.query(
    'SELECT tafra_bootcamp_id AS id, name FROM tafra_bootcamps WHERE tafra_bootcamp_id = ANY($1::bigint[]) ORDER BY name',
    [bootcampIds]
  );
  if (!bootcampsResult.rows.length) return res.status(400).json({ error: 'الأبواب المختارة غير موجودة' });

  performSelectiveSync(credentials, bootcampsResult.rows)
    .catch((error) => console.error('Unexpected selective sync failure:', error.message));
  res.status(202).json({ ok: true, message: `بدأ تحديث بيانات ${bootcampsResult.rows.length} باب في الخلفية` });
}

async function getSelectiveSyncStatus(req, res) {
  try {
    const result = await pool.query('SELECT * FROM tafra_selective_sync_status WHERE id = 1');
    res.json({ sync: result.rows[0] });
  } catch (error) {
    console.error('Failed to load selective sync status:', error.message);
    res.status(500).json({ error: 'تعذر تحميل حالة تحديث الأبواب المختارة' });
  }
}

async function upsertPage(client, students) {
  const payload = JSON.stringify(students);
  await client.query(
    `INSERT INTO tafra_students
      (tafra_student_id, name, phone, parent_phone, status, rate, student_code,
       educational_level, telegram_linked, telegram_username, telegram_chat_id,
       registration_review_status, raw_data, grade_level, gender, last_seen_at, updated_at)
     SELECT
       x.id, x.name, x.phone, x.parent_phone, x.status, x.rate, x.code,
       x.educational_level, COALESCE(x.telegram_linked, FALSE), x.telegram_username,
       NULLIF(x.telegram_chat_id, '')::bigint, x.registration_review_status,
       x.raw_data, tafra_derive_grade_level(x.educational_level #>> '{}'), x.gender, NOW(), NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(
       id bigint, name text, phone text, parent_phone text, status text, rate text,
       code text, educational_level jsonb, telegram_linked boolean,
       telegram_username text, telegram_chat_id text,
       registration_review_status text, raw_data jsonb, gender text
     )
     ON CONFLICT (tafra_student_id) DO UPDATE SET
       name = EXCLUDED.name, phone = EXCLUDED.phone, parent_phone = EXCLUDED.parent_phone,
       status = EXCLUDED.status, rate = EXCLUDED.rate, student_code = EXCLUDED.student_code,
       educational_level = EXCLUDED.educational_level,
       -- بنفضّل أي صف اتحدد يدويًا أو استُنتج قبل كده، ومانكتبش فوقه إلا لو لسه NULL
       grade_level = COALESCE(tafra_students.grade_level, EXCLUDED.grade_level),
       gender = EXCLUDED.gender,
       telegram_linked = EXCLUDED.telegram_linked,
       telegram_username = EXCLUDED.telegram_username,
       telegram_chat_id = EXCLUDED.telegram_chat_id,
       registration_review_status = EXCLUDED.registration_review_status,
       raw_data = EXCLUDED.raw_data, last_seen_at = NOW(), updated_at = NOW()`,
    [payload]
  );

  await client.query(
    `INSERT INTO contacts (chat_id, telegram_username, first_name, phone, source)
     SELECT NULLIF(x.telegram_chat_id, '')::bigint, NULLIF(x.telegram_username, ''),
            NULLIF(x.name, ''), NULLIF(x.phone, ''), 'tafra'
     FROM jsonb_to_recordset($1::jsonb) AS x(
       telegram_chat_id text, telegram_username text, name text, phone text
     )
     WHERE NULLIF(x.telegram_chat_id, '') IS NOT NULL
     ON CONFLICT (chat_id) DO UPDATE SET
       telegram_username = COALESCE(contacts.telegram_username, EXCLUDED.telegram_username),
       first_name = COALESCE(contacts.first_name, EXCLUDED.first_name),
       phone = COALESCE(contacts.phone, EXCLUDED.phone)`,
    [payload]
  );
}

async function performSync(credentials) {
  syncRunning = true;
  try {
    const previousResult = await pool.query('SELECT * FROM tafra_sync_status WHERE id = 1');
    const previous = previousResult.rows[0] || {};
    const resume = previous.status === 'failed' && Number(previous.current_page) > 0;
    let synced = resume ? Number(previous.synced_students || 0) : 0;
    let telegramCount = resume ? Number(previous.telegram_students || 0) : 0;
    let startPage = resume ? Number(previous.current_page) + 1 : 1;

    await pool.query(
      `UPDATE tafra_sync_status SET status = 'running',
       total_students = CASE WHEN $1 THEN total_students ELSE 0 END,
       synced_students = CASE WHEN $1 THEN synced_students ELSE 0 END,
       telegram_students = CASE WHEN $1 THEN telegram_students ELSE 0 END,
       current_page = CASE WHEN $1 THEN current_page ELSE 0 END,
       total_pages = CASE WHEN $1 THEN total_pages ELSE 0 END,
       started_at = NOW(), completed_at = NULL,
       error_message = NULL, updated_at = NOW() WHERE id = 1`
      , [resume]
    );

    const tafra = new TafraReadOnlyClient(credentials.identifier, credentials.password);
    const firstResponse = await tafra.getStudentsPage(startPage, 100);
    const firstMeta = firstResponse.data?.meta || {};
    const totalPages = Number(firstMeta.last_page || previous.total_pages || 1);
    const totalStudents = Number(firstMeta.total || previous.total_students || 0);
    let highestCompletedPage = startPage - 1;
    const completedPages = new Set();

    async function processPage(page, suppliedResponse = null) {
      const response = suppliedResponse || await tafra.getStudentsPage(page, 100);
      const pageData = response.data || {};
      const students = Array.isArray(pageData.data) ? pageData.data : [];
      const normalized = students.map((student) => ({
        ...student, raw_data: student, gender: inferGenderFromName(student.name),
      }));

      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        await upsertPage(dbClient, normalized);
        synced += students.length;
        telegramCount += students.filter((student) => student.telegram_chat_id).length;
        completedPages.add(page);
        while (completedPages.has(highestCompletedPage + 1)) {
          completedPages.delete(highestCompletedPage + 1);
          highestCompletedPage += 1;
        }
        await dbClient.query(
          `UPDATE tafra_sync_status SET total_students = $1, synced_students = $2,
           telegram_students = $3, current_page = $4, total_pages = $5,
           updated_at = NOW() WHERE id = 1`,
          [totalStudents, synced, telegramCount, highestCompletedPage, totalPages]
        );
        await dbClient.query('COMMIT');
      } catch (error) {
        await dbClient.query('ROLLBACK');
        throw error;
      } finally {
        dbClient.release();
      }
    }

    await processPage(startPage, firstResponse);
    const concurrency = 4;
    for (let page = startPage + 1; page <= totalPages; page += concurrency) {
      const pages = Array.from({ length: Math.min(concurrency, totalPages - page + 1) }, (_, index) => page + index);
      await Promise.all(pages.map((pageNumber) => processPage(pageNumber)));
      await tafra.waitForRateLimit();
    }

    const finalCounts = await pool.query(
      `SELECT COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE telegram_chat_id IS NOT NULL)::int AS telegram
       FROM tafra_students`
    );

    await pool.query(
      `UPDATE tafra_sync_status SET status = 'completed', synced_students = $1,
       telegram_students = $2, current_page = total_pages, completed_at = NOW(),
       updated_at = NOW() WHERE id = 1`,
      [finalCounts.rows[0].total, finalCounts.rows[0].telegram]
    );

    const events = require('../utils/events');
    const newStudents = Math.max(0, finalCounts.rows[0].total - Number(previous.total_students || 0));
    events.notifyTafraSyncCompleted({ total_students: finalCounts.rows[0].total, new_students: newStudents });
  } catch (error) {
    console.error('Failed to sync Tafra students:', error.message);
    await pool.query(
      `UPDATE tafra_sync_status SET status = 'failed', error_message = $1,
       completed_at = NOW(), updated_at = NOW() WHERE id = 1`,
      [String(error.message).slice(0, 1000)]
    ).catch(() => {});
  } finally {
    syncRunning = false;
  }
}

async function syncStudents(req, res) {
  if (syncRunning) return res.status(409).json({ error: 'توجد مزامنة جارية بالفعل' });
  const credentials = await getCredentials();
  if (!credentials) return res.status(400).json({ error: 'احفظ بيانات ربط منصة طفرة أولًا' });

  performSync(credentials).catch((error) => console.error('Unexpected Tafra sync failure:', error.message));
  res.status(202).json({ ok: true, message: 'بدأ تحديث الطلاب في الخلفية' });
}

// بيتنادى من جدولة دورية — بيبدأ مزامنة تلقائية بس لو فات على آخر مزامنة ناجحة مدة الفاصل الزمني
// المحدد في الإعدادات (tafra_auto_sync_interval_hours)، ومفيش مزامنة تانية شغالة أصلًا
async function triggerAutoSyncIfDue() {
  if (syncRunning) return;
  try {
    const [credentials, settingsResult, statusResult] = await Promise.all([
      getCredentials(),
      pool.query("SELECT value FROM settings WHERE key = 'tafra_auto_sync_interval_hours'"),
      pool.query('SELECT completed_at, status FROM tafra_sync_status WHERE id = 1'),
    ]);
    if (!credentials) return;

    const intervalHours = Math.max(1, Number(settingsResult.rows[0]?.value) || 12);
    const status = statusResult.rows[0];
    const dueTime = status?.completed_at
      ? new Date(status.completed_at).getTime() + intervalHours * 60 * 60 * 1000
      : 0;
    if (Date.now() < dueTime) return;

    console.log(`⏰ Auto-sync interval reached (${intervalHours}h); starting background Tafra student sync.`);
    await performSync(credentials);
  } catch (error) {
    console.error('❌ Failed to run automatic Tafra sync:', error.message);
  }
}

// حفظ صفحة درجات (أونلاين أو ورقي) — الحقول المشتركة موحّدة، والباقي محفوظ كامل في raw_data
async function saveExamMarksPage(examType, examId, rows) {
  if (!rows.length) return;
  const normalized = rows
    .map((row) => ({
      student_id: row.user_id,
      mark: examType === 'online' ? row.student_total_mark : row.mark,
      percentage: examType === 'online' ? row.student_percentage : null,
      finished: examType === 'online' ? Boolean(row.finished) : null,
      attempt_number: examType === 'online' ? row.current_student_chance : null,
      taken_at: examType === 'online' ? row.start_at : null,
      raw_data: row,
    }))
    .filter((row) => row.student_id);
  if (!normalized.length) return;

  await pool.query(
    `INSERT INTO tafra_exam_marks
      (exam_type, tafra_exam_id, tafra_student_id, mark, percentage, finished, attempt_number, taken_at, raw_data, updated_at)
     SELECT $1, $2, x.student_id, x.mark, x.percentage, x.finished, x.attempt_number, x.taken_at, x.raw_data, NOW()
     FROM jsonb_to_recordset($3::jsonb) AS x(
       student_id bigint, mark numeric, percentage numeric, finished boolean,
       attempt_number integer, taken_at timestamptz, raw_data jsonb
     )
     ON CONFLICT (exam_type, tafra_exam_id, tafra_student_id) DO UPDATE SET
       mark = EXCLUDED.mark, percentage = EXCLUDED.percentage, finished = EXCLUDED.finished,
       attempt_number = EXCLUDED.attempt_number, taken_at = EXCLUDED.taken_at,
       raw_data = EXCLUDED.raw_data, updated_at = NOW()`,
    [examType, examId, JSON.stringify(normalized)]
  );
}

// filterData/*-exams بدون فلتر بيرجّع أحدث 10 بس، فبنمسح بالمعرّف (filter[id]) رقمًا رقمًا.
// المدرّسين بيحذفوا اختبارات تجريبية بكثرة، وده ممكن يعمل فجوة متتالية كبيرة (شفنا فجوة من
// 57 رقم فعليًا) — فبنمسح من غير أي توقف لحد آخر رقم شفناه في أي مزامنة سابقة (مهما كانت
// النتيجة مؤقتًا "محذوفة")، وبعده بس بنستخدم قاعدة "وقف بعد فجوة كبيرة" لاستكشاف أرقام جديدة.
async function discoverExamsByType(tafra, examType, onProgress, previousMaxId) {
  const found = [];
  let id = 1;
  const knownCeiling = Number(previousMaxId) || 0;
  for (; id <= knownCeiling; id += 1) {
    const exam = await tafra.findExamById(examType, id);
    if (exam) found.push({ ...exam, exam_type: examType });
    await onProgress(found.length);
    await tafra.waitForRateLimit();
  }

  let consecutiveMisses = 0;
  const maxConsecutiveMisses = 30;
  while (consecutiveMisses < maxConsecutiveMisses) {
    const exam = await tafra.findExamById(examType, id);
    if (exam) {
      found.push({ ...exam, exam_type: examType });
      consecutiveMisses = 0;
    } else {
      consecutiveMisses += 1;
    }
    id += 1;
    await onProgress(found.length);
    await tafra.waitForRateLimit();
  }
  return found;
}

async function performExamSync(credentials) {
  examSyncRunning = true;
  let syncedMarks = 0;
  let idsScanned = 0;
  try {
    await pool.query(
      `UPDATE tafra_exam_sync_status SET status='discovering', current_exam=0, total_exams=0,
       synced_marks=0, started_at=NOW(), completed_at=NULL, error_message=NULL, updated_at=NOW() WHERE id=1`
    );
    const tafra = new TafraReadOnlyClient(credentials.identifier, credentials.password);

    const reportDiscoveryProgress = async (foundSoFar) => {
      idsScanned += 1;
      await pool.query(
        'UPDATE tafra_exam_sync_status SET current_exam=$1, total_exams=$2, updated_at=NOW() WHERE id=1',
        [idsScanned, foundSoFar]
      );
    };

    // آخر رقم اختبار شفناه في أي مزامنة سابقة (حتى لو اتحذف بعدين) — بنمسح لحده من غير توقف
    const previousMaxIds = await pool.query(
      `SELECT exam_type, MAX(tafra_exam_id) AS max_id FROM tafra_exams GROUP BY exam_type`
    );
    const previousMaxIdByType = Object.fromEntries(
      previousMaxIds.rows.map((row) => [row.exam_type, Number(row.max_id)])
    );

    const onlineExams = await discoverExamsByType(tafra, 'online', reportDiscoveryProgress, previousMaxIdByType.online);
    const offlineExams = await discoverExamsByType(tafra, 'offline', reportDiscoveryProgress, previousMaxIdByType.offline);
    const allExams = [...onlineExams, ...offlineExams];

    await pool.query(
      `UPDATE tafra_exam_sync_status SET status='running', current_exam=0, total_exams=$1, updated_at=NOW() WHERE id=1`,
      [allExams.length]
    );
    await pool.query('UPDATE tafra_exams SET is_available = FALSE');
    for (const exam of allExams) {
      await pool.query(
        `INSERT INTO tafra_exams (exam_type, tafra_exam_id, name, is_available, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         ON CONFLICT (exam_type, tafra_exam_id) DO UPDATE SET
           name = EXCLUDED.name, is_available = TRUE, updated_at = NOW()`,
        [exam.exam_type, exam.id, exam.name]
      );
    }

    for (let index = 0; index < allExams.length; index += 1) {
      const exam = allExams[index];
      const getPage = (page) => (exam.exam_type === 'online'
        ? tafra.getOnlineExamStudentsPage(exam.id, page)
        : tafra.getOfflineExamMarksPage(exam.id, page));

      // بعض الاختبارات القديمة عندها بيانات مكسورة على المنصة نفسها وبترجّع خطأ —
      // بنسجّل الخطأ ونكمل على باقي الاختبارات بدل ما نوقّف المزامنة كلها
      try {
        const first = await getPage(1);
        const totalPages = Number(first.data?.meta?.last_page || 1);
        // بنجمّع كذا مرشّح لاسم الطالب — بعض الطلاب سجل محاولتهم مش ظاهر في marksHistory بتاعهم
        // لأسباب على مستوى المنصة نفسها، فمحتاجين أكتر من محاولة قبل ما نستسلم
        const sampleStudentIds = new Set();
        const MAX_BOOTCAMP_SAMPLES = 3;
        for (let page = 1; page <= totalPages; page += 1) {
          const response = page === 1 ? first : await getPage(page);
          const rows = Array.isArray(response.data?.data) ? response.data.data : [];
          if (sampleStudentIds.size < MAX_BOOTCAMP_SAMPLES) {
            rows.forEach((row) => { if (row.user_id) sampleStudentIds.add(row.user_id); });
          }
          await saveExamMarksPage(exam.exam_type, exam.id, rows);
          syncedMarks += rows.length;
          if (page < totalPages) await tafra.waitForRateLimit();
        }

        // اسم الكورس التابع له الاختبار متاح بس للأونلاين — بنجرّب كذا طالب لحد ما نلاقي واحد راجع بيانات
        if (exam.exam_type === 'online' && sampleStudentIds.size) {
          for (const candidateId of sampleStudentIds) {
            await tafra.waitForRateLimit();
            try {
              const history = await tafra.getStudentExamMarksHistory(candidateId, exam.id);
              const bootcampName = history.data?.data?.[0]?.bootcamp_name || null;
              if (bootcampName) {
                await pool.query(
                  'UPDATE tafra_exams SET bootcamp_name = $3 WHERE exam_type = $1 AND tafra_exam_id = $2',
                  [exam.exam_type, exam.id, bootcampName.trim()]
                );
                break;
              }
            } catch (bootcampError) {
              console.error(`⚠️ Failed to resolve bootcamp for exam online#${exam.id} via student ${candidateId}:`, bootcampError.message);
            }
          }
        }
      } catch (examError) {
        console.error(`⚠️ Failed to sync marks for exam ${exam.exam_type}#${exam.id} (${exam.name}):`, examError.message);
      }

      await pool.query(
        `UPDATE tafra_exam_sync_status SET current_exam=$1, synced_marks=$2, updated_at=NOW() WHERE id=1`,
        [index + 1, syncedMarks]
      );
      if (index < allExams.length - 1) await tafra.waitForRateLimit();
    }

    await pool.query(
      `UPDATE tafra_exam_sync_status SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=1`
    );
  } catch (error) {
    console.error('Failed to sync Tafra exam data:', error.message);
    await pool.query(
      `UPDATE tafra_exam_sync_status SET status='failed', error_message=$1,
       completed_at=NOW(), updated_at=NOW() WHERE id=1`,
      [String(error.message).slice(0, 1000)]
    ).catch(() => {});
  } finally {
    examSyncRunning = false;
  }
}

async function syncExams(req, res) {
  if (examSyncRunning) return res.status(409).json({ error: 'تحديث الاختبارات جارٍ بالفعل' });
  const credentials = await getCredentials();
  if (!credentials) return res.status(400).json({ error: 'احفظ بيانات ربط منصة طفرة أولًا' });

  performExamSync(credentials).catch((error) => console.error('Unexpected Tafra exam sync failure:', error.message));
  res.status(202).json({ ok: true, message: 'بدأ تحديث الاختبارات وبياناتها في الخلفية' });
}

async function getExamSyncStatus(req, res) {
  try {
    const [statusResult, examCountResult, marksCountResult] = await Promise.all([
      pool.query('SELECT * FROM tafra_exam_sync_status WHERE id = 1'),
      pool.query('SELECT COUNT(*)::int AS count FROM tafra_exams WHERE is_available = TRUE'),
      pool.query('SELECT COUNT(*)::int AS count FROM tafra_exam_marks'),
    ]);
    res.json({
      sync: statusResult.rows[0],
      exam_count: examCountResult.rows[0].count,
      marks_count: marksCountResult.rows[0].count,
    });
  } catch (error) {
    console.error('Failed to load Tafra exam sync status:', error.message);
    res.status(500).json({ error: 'تعذر تحميل حالة تحديث الاختبارات' });
  }
}

module.exports = {
  getStatus, saveCredentials, syncStudents, syncEnrollments, syncBootcampNames, listStudents, getStudentFilters,
  syncExams, getExamSyncStatus, exportStudentsReport, listStudentContactIds, buildTafraStudentFilters, BOOTCAMP_MARKS_JOIN_SQL,
  triggerAutoSyncIfDue, syncSelectedBootcamps, getSelectiveSyncStatus,
  getCredentials, saveEnrollmentPage, getNewBotInfo, listNewBotContacts, listNewBotContactIds, sendNewBotBroadcast,
  syncNewBotReachability, getNewBotReachabilitySyncStatus, getFollowUpBotStartLog,
};
