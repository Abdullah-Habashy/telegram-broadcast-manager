const crypto = require('crypto');
const pool = require('../config/db');
const { buildTafraStudentFilters, BOOTCAMP_MARKS_JOIN_SQL } = require('./tafra.controller');
const { toEgyptianMobileE164 } = require('../utils/phone');
const { getFirstName } = require('../utils/messagePersonalization');
const { setUrgentFlag, setUrgentFlagBulk } = require('../utils/urgentFlag');
const { getCredentials: getTafraCredentials } = require('./tafra.controller');

// ---------- نتائج المكالمات ----------
async function listOutcomes(req, res) {
  try {
    const result = await pool.query('SELECT id, name FROM call_outcomes ORDER BY sort_order, id');
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Failed to load call outcomes:', error.message);
    res.status(500).json({ error: 'تعذر تحميل نتائج المكالمات' });
  }
}

async function createOutcome(req, res) {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم النتيجة مطلوب' });

  try {
    const result = await pool.query(
      `INSERT INTO call_outcomes (name, sort_order, created_by)
       VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM call_outcomes), $2)
       RETURNING id, name`,
      [name, req.session.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'النتيجة دي موجودة بالفعل' });
    console.error('❌ Failed to create call outcome:', error.message);
    res.status(500).json({ error: 'تعذر إضافة النتيجة' });
  }
}

// ---------- الموظفين المتاحين للإسناد ----------
async function listAssignees(req, res) {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name,
         (SELECT COUNT(*)::int FROM student_call_assignments sca WHERE sca.assigned_to = u.id) AS assigned_count
       FROM users u
       WHERE u.is_active = TRUE
       ORDER BY u.name`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Failed to load assignees:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة الموظفين' });
  }
}

// ---------- إسناد الطلاب (فردي أو جماعي) ----------
function parseStudentIds(body) {
  const raw = Array.isArray(body.tafra_student_ids) ? body.tafra_student_ids : [];
  return [...new Set(raw.map(Number).filter(Number.isInteger))];
}

// بيسجّل كل عملية إسناد/إلغاء إسناد في call_assignment_log — batchId واحد لكل عملية (فردية أو جماعية)
// عشان تفضل قابلة للمراجعة والرجوع إليها لاحقًا، مع نسخة من الفلاتر اللي كانت مفعّلة وقتها
async function logAssignmentBatch(client, { action, studentIds, assignedTo, previousMap, assignedBy, filters }) {
  const batchId = crypto.randomUUID();
  const rows = studentIds.map((id) => ({
    student_id: id,
    previous_assigned_to: previousMap.get(id) || null,
  }));
  await client.query(
    `INSERT INTO call_assignment_log
      (batch_id, tafra_student_id, action, assigned_to, previous_assigned_to, assigned_by, filters)
     SELECT $1, x.student_id, $2, $3, x.previous_assigned_to, $4, $5
     FROM jsonb_to_recordset($6::jsonb) AS x(student_id bigint, previous_assigned_to int)`,
    [batchId, action, assignedTo, assignedBy, filters ? JSON.stringify(filters) : null, JSON.stringify(rows)]
  );
  return batchId;
}

function sanitizeFilters(rawFilters) {
  if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) return null;
  const entries = Object.entries(rawFilters).filter(([, value]) => value !== '' && value !== null && value !== undefined);
  return entries.length ? Object.fromEntries(entries) : null;
}

async function assignStudents(req, res) {
  const studentIds = parseStudentIds(req.body);
  const userId = Number(req.body.user_id);
  const confirmed = req.body.confirm === true;
  const filters = sanitizeFilters(req.body.filters);
  if (!studentIds.length) return res.status(400).json({ error: 'اختر طالب واحد على الأقل' });
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'اختر الموظف المسؤول' });

  try {
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [userId]);
    if (!userCheck.rows[0]) return res.status(400).json({ error: 'الموظف غير موجود أو غير مفعّل' });

    const currentResult = await pool.query(
      `SELECT sca.tafra_student_id, sca.assigned_to, u.name AS assigned_name
       FROM student_call_assignments sca
       JOIN users u ON u.id = sca.assigned_to
       WHERE sca.tafra_student_id = ANY($1::bigint[])`,
      [studentIds]
    );
    const previousMap = new Map(currentResult.rows.map((row) => [Number(row.tafra_student_id), row.assigned_to]));

    // ضمان عدم إسناد أي طالب لأكتر من موظف بالغلط — لو فيه طلاب مسندين بالفعل لموظف تاني (غير الهدف)،
    // لازم تأكيد صريح قبل ما ننقلهم، وبنوضح مين هيتأثر بالظبط
    const willReassign = currentResult.rows.filter((row) => Number(row.assigned_to) !== userId);
    if (!confirmed && willReassign.length) {
      const byEmployee = {};
      willReassign.forEach((row) => { byEmployee[row.assigned_name] = (byEmployee[row.assigned_name] || 0) + 1; });
      return res.status(409).json({
        needs_confirmation: true,
        reassign_count: willReassign.length,
        by_employee: byEmployee,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO student_call_assignments (tafra_student_id, assigned_to, assigned_by, assigned_at)
         SELECT s.tafra_student_id, $2, $3, NOW()
         FROM tafra_students s
         WHERE s.tafra_student_id = ANY($1::bigint[])
         ON CONFLICT (tafra_student_id) DO UPDATE SET
           assigned_to = EXCLUDED.assigned_to, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()`,
        [studentIds, userId, req.session.userId]
      );
      const batchId = await logAssignmentBatch(client, {
        action: 'assign', studentIds, assignedTo: userId, previousMap, assignedBy: req.session.userId, filters,
      });
      await client.query('COMMIT');
      res.json({ assigned: result.rowCount, reassigned: willReassign.length, batch_id: batchId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Failed to assign students:', error.message);
    res.status(500).json({ error: 'تعذر إسناد الطلاب' });
  }
}

async function unassignStudents(req, res) {
  const studentIds = parseStudentIds(req.body);
  const filters = sanitizeFilters(req.body.filters);
  if (!studentIds.length) return res.status(400).json({ error: 'اختر طالب واحد على الأقل' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      'SELECT tafra_student_id, assigned_to FROM student_call_assignments WHERE tafra_student_id = ANY($1::bigint[])',
      [studentIds]
    );
    const previousMap = new Map(currentResult.rows.map((row) => [Number(row.tafra_student_id), row.assigned_to]));
    const result = await client.query(
      'DELETE FROM student_call_assignments WHERE tafra_student_id = ANY($1::bigint[])',
      [studentIds]
    );
    const batchId = await logAssignmentBatch(client, {
      action: 'unassign', studentIds, assignedTo: null, previousMap, assignedBy: req.session.userId, filters,
    });
    await client.query('COMMIT');
    res.json({ unassigned: result.rowCount, batch_id: batchId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to unassign students:', error.message);
    res.status(500).json({ error: 'تعذر إلغاء إسناد الطلاب' });
  } finally {
    client.release();
  }
}

// ---------- سجل عمليات الإسناد — مجمّع حسب كل عملية (batch) عشان يبقى قابل للمراجعة ----------
async function getAssignmentLog(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;

  try {
    if (req.query.batch_id) {
      const studentsResult = await pool.query(
        `SELECT cal.tafra_student_id, s.name, s.phone, u_prev.name AS previous_assigned_name
         FROM call_assignment_log cal
         JOIN tafra_students s ON s.tafra_student_id = cal.tafra_student_id
         LEFT JOIN users u_prev ON u_prev.id = cal.previous_assigned_to
         WHERE cal.batch_id = $1
         ORDER BY s.name`,
        [req.query.batch_id]
      );
      return res.json({ students: studentsResult.rows });
    }

    const countResult = await pool.query('SELECT COUNT(DISTINCT batch_id)::int AS count FROM call_assignment_log');
    const result = await pool.query(
      `SELECT batch_id, action, assigned_to, assigned_by, filters,
         COUNT(*)::int AS student_count, MIN(cal.created_at) AS created_at,
         u_to.name AS assigned_to_name, u_by.name AS assigned_by_name
       FROM call_assignment_log cal
       LEFT JOIN users u_to ON u_to.id = cal.assigned_to
       LEFT JOIN users u_by ON u_by.id = cal.assigned_by
       GROUP BY batch_id, action, assigned_to, assigned_by, filters, u_to.name, u_by.name
       ORDER BY MIN(cal.created_at) DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = countResult.rows[0].count;
    res.json({ batches: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('❌ Failed to load assignment log:', error.message);
    res.status(500).json({ error: 'تعذر تحميل سجل الإسناد' });
  }
}

// ---------- تصفح الطلاب للإسناد — بنفس فلاتر "طلاب المنصة" بالظبط، زائد فلتر الإسناد ----------
// بيبني على buildTafraStudentFilters المشتركة عشان أي فلتر جديد يتضاف هناك يفضل شغال هنا من غير تكرار
function buildCallStudentFilters(query) {
  const base = buildTafraStudentFilters(query);
  const conditions = base.where ? [base.where.replace(/^WHERE /, '')] : [];
  const { params } = base;
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.assigned === 'unassigned') {
    conditions.push('sca.assigned_to IS NULL');
  } else if (query.assigned && /^\d+$/.test(query.assigned)) {
    conditions.push(`sca.assigned_to = ${add(Number(query.assigned))}`);
  }
  // مين اللي فعليًا اتصل بالطالب وسجّله (تاريخيًا) — مختلف عن "مين مسند له دلوقتي"، بيفضل صحيح حتى لو الطالب
  // اتحول لموظف تاني أو اتلغى إسناده بعد كده
  if (query.called_by && /^\d+$/.test(query.called_by)) {
    conditions.push(`EXISTS (
      SELECT 1 FROM call_logs cl WHERE cl.tafra_student_id = s.tafra_student_id AND cl.called_by = ${add(Number(query.called_by))}
    )`);
  }
  // نتيجة **آخر** مكالمة (مش أي مكالمة في التاريخ) — عشان يطابق عمود النتيجة الظاهر في القائمة نفسه.
  // طالب اتصلنا بيه تلات مرات وما ردش وفي الرابعة رد، حالته الحالية "تم الرد" ومش منطقي يطلع في
  // فلتر "لم يرد". بيعتمد على last_call اللاتيرال الموجودة في CALL_ASSIGNMENT_JOIN_SQL، وهي متضمّنة
  // في كل الاستعلامات اللي بتستخدم الباني ده. الفلترة بالـ id مش بالاسم عشان تفضل صح لو الاسم اتعدّل
  if (query.call_outcome && /^\d+$/.test(query.call_outcome)) {
    conditions.push(`last_call.outcome_id = ${add(Number(query.call_outcome))}`);
  }
  // عدد المحاولات المتتالية اللي "معرفناش نوصله" فيها — يعني آخر كام مكالمة ورا بعض ماوصلناهوش.
  // "معرفناش نوصله" = 'لم يرد' أو 'الخط مشغول'؛ الاتنين نتيجتهم واحدة عمليًا (مكلمناهوش) فمفيش
  // معنى نفرّق بينهم في المتابعة. أي نتيجة تانية بتكسر السلسلة، بما فيها 'هيرجع يتصل لاحقًا'
  // لأننا اتكلمنا معاه فعلًا، و'رقم غير صحيح' لأنها مشكلة مختلفة (الرقم غلط، مش إنه مش بيرد).
  //
  // الحساب: بنعدّ محاولات عدم الوصول اللي حصلت **بعد** آخر مكالمة وصلناه فيها فعلًا. لو عمرنا
  // ما وصلناه، بنعدّ الكل. ده بيطلّع طول السلسلة الأخيرة بالظبط من غير window functions.
  // مهم: السلسلة لازم تنتهي عند آخر مكالمة — اللي رد في آخر مكالمة سلسلته صفر ومايظهرش في الفلتر.
  const UNREACHED_NAMES = `('لم يرد', 'الخط مشغول')`;
  const UNREACHED_STREAK_SQL = `(
    SELECT COUNT(*) FROM call_logs cl_un
    JOIN call_outcomes co_un ON co_un.id = cl_un.outcome_id
    WHERE cl_un.tafra_student_id = s.tafra_student_id
      AND co_un.name IN ${UNREACHED_NAMES}
      AND cl_un.called_at > COALESCE((
        SELECT MAX(cl_ok.called_at) FROM call_logs cl_ok
        JOIN call_outcomes co_ok ON co_ok.id = cl_ok.outcome_id
        WHERE cl_ok.tafra_student_id = s.tafra_student_id
          AND co_ok.name NOT IN ${UNREACHED_NAMES}
      ), '-infinity'::timestamptz)
  )`;
  if (query.unreached_streak === '1' || query.unreached_streak === '2') {
    conditions.push(`${UNREACHED_STREAK_SQL} = ${add(Number(query.unreached_streak))}`);
  } else if (query.unreached_streak === '3plus') {
    conditions.push(`${UNREACHED_STREAK_SQL} >= 3`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    examJoinSql: base.examJoinSql,
    examSelectSql: base.examSelectSql,
  };
}

// حالة موعد المتابعة/الاتصال — 'called' بتعتمد على وجود last_call.called_at (نفس عمود last_call
// المستخدم في STUDENT_BASE_FROM)، فمحتاجة اللاتيرال ده يكون متضمّن في fromSql اللي بتتطبق عليه
function buildFollowUpCondition(followUp) {
  if (followUp === 'due') return 'last_call.next_follow_up_at <= NOW()';
  if (followUp === 'none') return 'last_call.called_at IS NULL';
  if (followUp === 'called') return 'last_call.called_at IS NOT NULL';
  return null;
}

const CALL_ASSIGNMENT_JOIN_SQL = `
  LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
  LEFT JOIN users au ON au.id = sca.assigned_to
  LEFT JOIN LATERAL (
    SELECT co.name AS outcome_name, cl.outcome_id, cl.called_at, cl.next_follow_up_at
    FROM call_logs cl
    LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
    WHERE cl.tafra_student_id = s.tafra_student_id
    ORDER BY cl.called_at DESC
    LIMIT 1
  ) last_call ON true
`;
// نفس الجوينز المستخدمة في تصفح طلاب المنصة (contacts/tickets للفكرة الحالية وفلتر تيليجرام، وباب الاشتراك للدرجات)
const STUDENT_BASE_FROM = `
  FROM tafra_students s
  LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
  LEFT JOIN tickets t ON t.contact_id = c.id
  ${CALL_ASSIGNMENT_JOIN_SQL}
  ${BOOTCAMP_MARKS_JOIN_SQL}
`;

function buildStudentSelectSql(examSelectSql) {
  return `SELECT s.tafra_student_id, s.name, s.phone, s.parent_phone, s.status,
    s.student_code, s.educational_level #>> '{}' AS educational_level, s.grade_level, s.gender,
    CASE WHEN s.educational_level #>> '{}' ILIKE '%ازهر%' THEN 'azhar' ELSE 'general' END AS education_type,
    t.current_idea_number, t.id AS ticket_id,
    (COALESCE(s.is_urgent, FALSE) OR COALESCE(c.is_urgent, FALSE)) AS is_urgent,
    bootcamp_marks.in_chapter_one, bootcamp_marks.in_full_curriculum${examSelectSql || ''},
    sca.assigned_to, au.name AS assigned_name,
    last_call.outcome_name AS last_outcome_name, last_call.called_at AS last_called_at,
    last_call.next_follow_up_at AS next_follow_up_at,
    -- تيليجرام مايسمحش نبعت لطالب لسه ما تفاعلش مع البوت ولو مرة (زي دوس Start)، حتى لو ربط حسابه على منصة طفرة
    (c.last_contacted_at IS NOT NULL) AS can_message`;
}

async function listStudentsForAssignment(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const { where, params, examJoinSql, examSelectSql } = buildCallStudentFilters(req.query);
  const followUpCondition = buildFollowUpCondition(req.query.follow_up);
  const finalWhere = followUpCondition ? `${where ? `${where} AND ` : 'WHERE '}${followUpCondition}` : where;
  const fromSql = `${STUDENT_BASE_FROM} ${examJoinSql || ''}`;

  try {
    const countResult = await pool.query(`SELECT COUNT(*)::int AS count ${fromSql} ${finalWhere}`, params);
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `${buildStudentSelectSql(examSelectSql)} ${fromSql} ${finalWhere}
       ORDER BY s.tafra_student_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );
    const buildSms = await buildSmsFactory();
    const students = await decorateWithSms(result.rows, buildSms);
    const total = countResult.rows[0].count;
    res.json({ students, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('❌ Failed to list students for call assignment:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة الطلاب' });
  }
}

// كل معرّفات الطلاب المطابقين لنفس فلاتر شاشة الإسناد — بدون تقسيم صفحات — عشان زرار
// "تحديد كل النتائج" يقدر يحدد كل الطلاب المطابقين مش بس اللي ظاهرين في الصفحة الحالية
async function listStudentIdsForAssignment(req, res) {
  const { where, params, examJoinSql } = buildCallStudentFilters(req.query);
  const followUpCondition = buildFollowUpCondition(req.query.follow_up);
  const finalWhere = followUpCondition ? `${where ? `${where} AND ` : 'WHERE '}${followUpCondition}` : where;
  const fromSql = `${STUDENT_BASE_FROM} ${examJoinSql || ''}`;
  try {
    const result = await pool.query(
      `SELECT s.tafra_student_id ${fromSql} ${finalWhere} ORDER BY s.tafra_student_id DESC`,
      params
    );
    res.json({ ids: result.rows.map((row) => Number(row.tafra_student_id)) });
  } catch (error) {
    console.error('❌ Failed to list student ids for call assignment:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة معرّفات الطلاب' });
  }
}

// ---------- قايمتي (الموظف يشوف الطلاب المسندين له) ----------
async function listMyStudents(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const targetUserId = req.session.userRole === 'admin' && /^\d+$/.test(req.query.user_id || '')
    ? Number(req.query.user_id)
    : Number(req.session.userId);

  const { where, params, examJoinSql, examSelectSql } = buildCallStudentFilters({ ...req.query, assigned: String(targetUserId) });
  const followUpCondition = buildFollowUpCondition(req.query.follow_up);
  const finalWhere = followUpCondition ? `${where} AND ${followUpCondition}` : where;
  const fromSql = `${STUDENT_BASE_FROM} ${examJoinSql || ''}`;

  try {
    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `${buildStudentSelectSql(examSelectSql)} ${fromSql} ${finalWhere}
       ORDER BY (last_call.next_follow_up_at IS NULL), last_call.next_follow_up_at, s.tafra_student_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );
    const countResult = await pool.query(`SELECT COUNT(*)::int AS count ${fromSql} ${finalWhere}`, params);
    const buildSms = await buildSmsFactory();
    const students = await decorateWithSms(result.rows, buildSms);
    const total = countResult.rows[0].count;
    res.json({ students, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('❌ Failed to list my call students:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمتك' });
  }
}

// ---------- بروفايل الطالب ----------
async function getStudentProfile(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });

  try {
    const studentResult = await pool.query(
      `SELECT s.tafra_student_id, s.name, s.phone, s.parent_phone, s.status, s.rate, s.student_code,
         s.educational_level #>> '{}' AS educational_level, s.grade_level, s.gender, s.telegram_username, s.telegram_chat_id,
         t.id AS ticket_id,
         sca.assigned_to, au.name AS assigned_name,
         (c.last_contacted_at IS NOT NULL) AS can_message,
         (COALESCE(s.is_urgent, FALSE) OR COALESCE(c.is_urgent, FALSE)) AS is_urgent
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
       LEFT JOIN users au ON au.id = sca.assigned_to
       WHERE s.tafra_student_id = $1`,
      [studentId]
    );
    const student = studentResult.rows[0];
    if (!student) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (req.session.userRole !== 'admin' && Number(student.assigned_to) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'الطالب ده مش مسند لك' });
    }

    const logsResult = await pool.query(
      `SELECT cl.id, cl.notes, cl.called_at, cl.next_follow_up_at, cl.outcome_id, cl.called_by,
         co.name AS outcome_name, u.name AS called_by_name
       FROM call_logs cl
       LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
       LEFT JOIN users u ON u.id = cl.called_by
       WHERE cl.tafra_student_id = $1
       ORDER BY cl.called_at DESC`,
      [studentId]
    );

    // الـ SMS بتتحسب هنا وترجع جاهزة مع البروفايل، مش في الواجهة — لأن /api/settings محجوز
    // للأدمن والموظف مش بيقدر يقراه، وكمان عشان الاستبدال يفضل في مكان واحد زي باقي الرسايل
    const buildSms = await buildSmsFactory();
    const smsLogsResult = await pool.query(
      `SELECT sl.id, sl.phone, sl.body, sl.sent_at, u.name AS sent_by_name
       FROM sms_logs sl LEFT JOIN users u ON u.id = sl.sent_by
       WHERE sl.tafra_student_id = $1 ORDER BY sl.sent_at DESC`,
      [studentId]
    );

    res.json({
      student,
      calls: logsResult.rows,
      sms: buildSms(student),
      sms_logs: smsLogsResult.rows,
    });
  } catch (error) {
    console.error('❌ Failed to load call student profile:', error.message);
    res.status(500).json({ error: 'تعذر تحميل بيانات الطالب' });
  }
}

// ---------- رسالة SMS ----------
// القالب واحد لكل الطلاب، فبنقراه مرة واحدة للطلب كله وبنستبدل الاسم لكل طالب. بيرجع دالة
// عشان القائمة (50 طالب) ماتعملش 50 استعلام إعدادات
async function buildSmsFactory() {
  const result = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('sms_template_enabled', 'sms_template_text')"
  );
  const settings = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  if (settings.sms_template_enabled !== 'true' || !settings.sms_template_text) return () => null;
  const template = settings.sms_template_text;
  return (student) => {
    const phone = toEgyptianMobileE164(student.phone);
    if (!phone) return null;
    return {
      phone,
      body: template.replaceAll('الاسم', getFirstName({
        tafra_name: student.name,
        first_name: student.name,
        telegram_username: student.telegram_username,
      })),
    };
  };
}

// بتزوّد صفوف القائمة بالـ SMS الجاهزة وبآخر مرة اتبعتت للطالب. آخر مرة بتتجاب باستعلام واحد
// لكل الصفحة (مش استعلام لكل طالب) — بتظهر جنب الزرار عشان الموظف مايبعتش لنفس الطالب مرتين
async function decorateWithSms(rows, buildSms) {
  if (!rows.length) return rows;
  const ids = rows.map((row) => Number(row.tafra_student_id));
  const lastSent = await pool.query(
    `SELECT tafra_student_id, MAX(sent_at) AS last_sms_at, COUNT(*)::int AS sms_count
     FROM sms_logs WHERE tafra_student_id = ANY($1::bigint[]) GROUP BY tafra_student_id`,
    [ids]
  );
  const byStudent = new Map(lastSent.rows.map((row) => [Number(row.tafra_student_id), row]));
  return rows.map((row) => {
    const history = byStudent.get(Number(row.tafra_student_id));
    return {
      ...row,
      sms: buildSms(row),
      last_sms_at: history ? history.last_sms_at : null,
      sms_count: history ? history.sms_count : 0,
    };
  });
}

// بيتنادى أول ما الموظف يضغط الزرار — قبل ما تطبيق الرسائل يفتح. النص بيتحسب في السيرفر مش
// بيتقبل من العميل، عشان السجل يبقى مطابق للقالب الفعلي ومحدش يقدر يسجّل نص من عنده
async function logSmsSend(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });

  try {
    const studentResult = await pool.query(
      `SELECT s.tafra_student_id, s.name, s.phone, s.telegram_username, sca.assigned_to
       FROM tafra_students s
       LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
       WHERE s.tafra_student_id = $1`,
      [studentId]
    );
    const student = studentResult.rows[0];
    if (!student) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (req.session.userRole !== 'admin' && Number(student.assigned_to) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'الطالب ده مش مسند لك' });
    }

    const buildSms = await buildSmsFactory();
    const sms = buildSms(student);
    if (!sms) return res.status(400).json({ error: 'رسالة الـ SMS غير مفعّلة أو رقم الطالب غير صالح' });

    const inserted = await pool.query(
      `INSERT INTO sms_logs (tafra_student_id, sent_by, phone, body)
       VALUES ($1, $2, $3, $4) RETURNING id, sent_at`,
      [studentId, req.session.userId, sms.phone, sms.body]
    );
    res.status(201).json({ ok: true, ...inserted.rows[0] });
  } catch (error) {
    console.error('❌ Failed to log an SMS send:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل إرسال الرسالة' });
  }
}

// ---------- مشاهدات فيديوهات الطالب ----------
// بتتجاب لحظيًا من منصة طفرة مش من قاعدتنا: مفيش جدول ولا مزامنة ليها، والاستدعاء بفلتر
// user_id سريع لطالب واحد. وده كمان بيضمن أرقام محدّثة — عكس مشكلة مزامنة الاختبارات اللي
// وقفت 8 أيام وخلّت اللوحة تعرض أصفار. endpoint منفصل عن الاختبارات عن قصد: لو API طفرة وقع،
// الدرجات (من قاعدتنا) تفضل ظاهرة والفيديوهات وحدها هي اللي تعرض خطأ
async function getStudentLessons(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });

  try {
    const accessResult = await pool.query(
      `SELECT sca.assigned_to FROM tafra_students s
       LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
       WHERE s.tafra_student_id = $1`,
      [studentId]
    );
    if (!accessResult.rows[0]) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (req.session.userRole !== 'admin' && Number(accessResult.rows[0].assigned_to) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'الطالب ده مش مسند لك' });
    }

    const credentials = await getTafraCredentials();
    if (!credentials) return res.status(400).json({ error: 'بيانات ربط منصة طفرة مش محفوظة' });

    const { TafraReadOnlyClient } = require('../integrations/tafraClient');
    const client = new TafraReadOnlyClient(credentials.identifier, credentials.password);
    const { rows, total, truncated } = await client.getStudentLessonViews(studentId);

    const videos = rows.filter((row) => row.is_video !== false);
    const completed = videos.filter((row) => row.is_completed).length;
    const percentages = videos
      .map((row) => Number(row.progress_percentage))
      .filter((value) => Number.isFinite(value));

    res.json({
      views: rows,
      summary: {
        total,
        shown: rows.length,
        truncated,
        video_count: videos.length,
        completed_count: completed,
        average_progress: percentages.length
          ? Math.round((percentages.reduce((sum, value) => sum + value, 0) / percentages.length) * 10) / 10
          : null,
      },
    });
  } catch (error) {
    console.error('❌ Failed to load student lesson views:', error.message);
    res.status(502).json({ error: 'تعذر جلب المشاهدات من منصة طفرة: ' + error.message });
  }
}

// تبديل علامة "عاجل" من شاشة المتابعة — بتتزامن مع صندوق الدعم تلقائيًا
async function toggleStudentUrgent(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });
  try {
    const result = await setUrgentFlag({ tafraStudentId: studentId, isUrgent: req.body.is_urgent });
    if (result === null) return res.status(404).json({ error: 'الطالب غير موجود' });
    res.json({ ok: true, is_urgent: result });
  } catch (error) {
    console.error('❌ Failed to toggle the urgent flag:', error.message);
    res.status(500).json({ error: 'تعذر تغيير علامة عاجل' });
  }
}

// وسم/إلغاء عاجل لمجموعة طلاب مرة واحدة — بيشتغل مع نفس التحديد المستخدم في الإسناد الجماعي
async function bulkToggleUrgent(req, res) {
  const studentIds = parseStudentIds(req.body);
  if (!studentIds.length) return res.status(400).json({ error: 'اختر طالب واحد على الأقل' });
  try {
    const count = await setUrgentFlagBulk(studentIds, req.body.is_urgent);
    res.json({ ok: true, updated: count, is_urgent: Boolean(req.body.is_urgent) });
  } catch (error) {
    console.error('❌ Failed to bulk-toggle the urgent flag:', error.message);
    res.status(500).json({ error: 'تعذر تغيير علامة عاجل للمحددين' });
  }
}

// ---------- اختبارات الطالب ودرجاته ----------
// بيتحمّل عند الطلب (لما الموظف يضغط الزرار) مش مع البروفايل، عشان فتح كل طالب مايجيبش
// عشرات الصفوف من غير حاجة. أهم حاجة هنا مش الدرجات اللي أخدها — دي ظاهرة على المنصة أصلًا —
// لكن **الاختبارات المتاحة اللي لسه ماخدهاش**، لأن دي بالظبط سبب المكالمة
async function getStudentExams(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });

  try {
    // نفس فحص الصلاحية بتاع البروفايل — الموظف يشوف الطلاب المسندين له بس
    const accessResult = await pool.query(
      `SELECT sca.assigned_to FROM tafra_students s
       LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
       WHERE s.tafra_student_id = $1`,
      [studentId]
    );
    if (!accessResult.rows[0]) return res.status(404).json({ error: 'الطالب غير موجود' });
    if (req.session.userRole !== 'admin' && Number(accessResult.rows[0].assigned_to) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'الطالب ده مش مسند لك' });
    }

    // time_taken_seconds مش عمود مستقل — بييجي من المنصة جوه raw_data، وبيتعرض للمكتمل بس:
    // للاختبارات غير المكتملة المنصة بتحسبه "الوقت المنقضي من البداية" فبيفضل يزيد للأبد (لقينا
    // قيم لحد 342 يوم)، وكل الصفوف غير المكتملة end_at بتاعها فاضي. أما المكتملة فأقصى قيمة فيها
    // 75 دقيقة ومنطقية تمامًا. وبنعمل cast لـ numeric مش int لأن القيمة بتيجي عشرية أحيانًا
    const takenResult = await pool.query(
      `SELECT e.name, e.bootcamp_name, e.exam_type, e.is_available,
         m.mark, m.percentage, m.finished, m.attempt_number, m.taken_at,
         CASE WHEN m.finished
           THEN FLOOR(NULLIF(m.raw_data ->> 'time_taken_seconds', '')::numeric)::int
         END AS time_taken_seconds
       FROM tafra_exam_marks m
       JOIN tafra_exams e ON e.exam_type = m.exam_type AND e.tafra_exam_id = m.tafra_exam_id
       WHERE m.tafra_student_id = $1
       ORDER BY m.taken_at DESC NULLS LAST, e.name`,
      [studentId]
    );

    // الاختبارات المتاحة حاليًا ومفيش لها درجة للطالب ده
    const missedResult = await pool.query(
      `SELECT e.name, e.bootcamp_name, e.exam_type
       FROM tafra_exams e
       WHERE e.is_available
         AND NOT EXISTS (
           SELECT 1 FROM tafra_exam_marks m
           WHERE m.exam_type = e.exam_type AND m.tafra_exam_id = e.tafra_exam_id
             AND m.tafra_student_id = $1
         )
       ORDER BY e.name`,
      [studentId]
    );

    const taken = takenResult.rows;
    const scored = taken.filter((row) => row.percentage !== null);
    res.json({
      taken,
      missed: missedResult.rows,
      summary: {
        taken_count: taken.length,
        finished_count: taken.filter((row) => row.finished).length,
        missed_count: missedResult.rows.length,
        average_percentage: scored.length
          ? Math.round((scored.reduce((sum, row) => sum + Number(row.percentage), 0) / scored.length) * 10) / 10
          : null,
      },
    });
  } catch (error) {
    console.error('❌ Failed to load student exams:', error.message);
    res.status(500).json({ error: 'تعذر تحميل اختبارات الطالب' });
  }
}

// ---------- تسجيل نتيجة مكالمة ----------
async function logCall(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });
  const outcomeId = /^\d+$/.test(req.body.outcome_id || '') ? Number(req.body.outcome_id) : null;
  if (!outcomeId) return res.status(400).json({ error: 'اختر نتيجة المكالمة' });
  const notes = req.body.notes ? String(req.body.notes).trim().slice(0, 2000) : null;
  const nextFollowUpAt = req.body.next_follow_up_at ? new Date(req.body.next_follow_up_at) : null;
  if (nextFollowUpAt && Number.isNaN(nextFollowUpAt.getTime())) {
    return res.status(400).json({ error: 'موعد المتابعة غير صالح' });
  }

  try {
    const assignmentResult = await pool.query(
      `SELECT s.tafra_student_id, sca.assigned_to
       FROM tafra_students s
       LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
       WHERE s.tafra_student_id = $1`,
      [studentId]
    );
    if (!assignmentResult.rows[0]) return res.status(404).json({ error: 'الطالب غير موجود' });
    const assignedTo = assignmentResult.rows[0].assigned_to;
    if (req.session.userRole !== 'admin' && Number(assignedTo) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'الطالب ده مش مسند لك' });
    }

    const outcomeCheck = await pool.query('SELECT id FROM call_outcomes WHERE id = $1', [outcomeId]);
    if (!outcomeCheck.rows[0]) return res.status(400).json({ error: 'نتيجة المكالمة غير صالحة' });

    const result = await pool.query(
      `INSERT INTO call_logs (tafra_student_id, called_by, outcome_id, notes, next_follow_up_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, called_at, next_follow_up_at`,
      [studentId, req.session.userId, outcomeId, notes, nextFollowUpAt]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to log call:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل نتيجة المكالمة' });
  }
}

// ---------- تعديل مكالمة مسجّلة — الأدمن يعدّل أي مكالمة، الموظف يعدّل مكالماته هو بس ----------
async function editCallLog(req, res) {
  const logId = Number(req.params.logId);
  if (!Number.isInteger(logId)) return res.status(400).json({ error: 'رقم المكالمة غير صالح' });
  const outcomeId = /^\d+$/.test(req.body.outcome_id || '') ? Number(req.body.outcome_id) : null;
  if (!outcomeId) return res.status(400).json({ error: 'اختر نتيجة المكالمة' });
  const notes = req.body.notes ? String(req.body.notes).trim().slice(0, 2000) : null;
  const nextFollowUpAt = req.body.next_follow_up_at ? new Date(req.body.next_follow_up_at) : null;
  if (nextFollowUpAt && Number.isNaN(nextFollowUpAt.getTime())) {
    return res.status(400).json({ error: 'موعد المتابعة غير صالح' });
  }

  try {
    const logResult = await pool.query('SELECT id, called_by FROM call_logs WHERE id = $1', [logId]);
    const log = logResult.rows[0];
    if (!log) return res.status(404).json({ error: 'المكالمة غير موجودة' });
    if (req.session.userRole !== 'admin' && Number(log.called_by) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'تقدر تعدّل مكالماتك أنت بس' });
    }

    const outcomeCheck = await pool.query('SELECT id FROM call_outcomes WHERE id = $1', [outcomeId]);
    if (!outcomeCheck.rows[0]) return res.status(400).json({ error: 'نتيجة المكالمة غير صالحة' });

    const result = await pool.query(
      `UPDATE call_logs SET outcome_id = $2, notes = $3, next_follow_up_at = $4
       WHERE id = $1
       RETURNING id, called_at, next_follow_up_at`,
      [logId, outcomeId, notes, nextFollowUpAt]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to edit call log:', error.message);
    res.status(500).json({ error: 'تعذر تعديل المكالمة' });
  }
}

// ---------- تعديل الصف الدراسي — تصحيح يدوي لبيانات المنصة الناقصة/غير الموحّدة ----------
const VALID_GRADE_LEVELS = ['1ث', '2ث', '3ث'];

async function updateStudentGrade(req, res) {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId)) return res.status(400).json({ error: 'الطالب غير صالح' });
  const gradeLevel = req.body.grade_level === null || req.body.grade_level === '' ? null : String(req.body.grade_level);
  if (gradeLevel !== null && !VALID_GRADE_LEVELS.includes(gradeLevel)) {
    return res.status(400).json({ error: 'الصف الدراسي غير صالح' });
  }

  try {
    const studentResult = await pool.query(
      `SELECT s.tafra_student_id, sca.assigned_to
       FROM tafra_students s
       LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
       WHERE s.tafra_student_id = $1`,
      [studentId]
    );
    if (!studentResult.rows[0]) return res.status(404).json({ error: 'الطالب غير موجود' });
    const assignedTo = studentResult.rows[0].assigned_to;
    if (req.session.userRole !== 'admin' && Number(assignedTo) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'الطالب ده مش مسند لك' });
    }

    await pool.query('UPDATE tafra_students SET grade_level = $2, updated_at = NOW() WHERE tafra_student_id = $1', [
      studentId,
      gradeLevel,
    ]);
    res.json({ tafra_student_id: studentId, grade_level: gradeLevel });
  } catch (error) {
    console.error('❌ Failed to update student grade level:', error.message);
    res.status(500).json({ error: 'تعذر تحديث الصف الدراسي' });
  }
}

// ---------- الإسناد التلقائي بالتبادل (كورس معيّن ← مجموعة موظفين) ----------
async function getAutoAssignConfig(req, res) {
  try {
    const result = await pool.query(
      `SELECT c.enabled, c.bootcamp_ids, c.employee_ids, c.updated_at,
         COALESCE((
           SELECT json_agg(json_build_object('id', tb.tafra_bootcamp_id, 'name', tb.name) ORDER BY tb.name)
           FROM tafra_bootcamps tb WHERE tb.tafra_bootcamp_id = ANY(c.bootcamp_ids)
         ), '[]') AS bootcamps
       FROM call_auto_assign_config c
       WHERE c.id = 1`
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('❌ Failed to load call auto-assign config:', error.message);
    res.status(500).json({ error: 'تعذر تحميل إعدادات الإسناد التلقائي' });
  }
}

// سجل تفصيلي (طالب طالب) لكل عمليات الإسناد التلقائي بالتبادل — مختلف عن getAssignmentLog اللي بيجمّع
// حسب batch_id (مفيد للإسناد اليدوي الجماعي)؛ هنا كل صف طالب لوحده مع الكورس اللي اشترك فيه وامتى
// اتسند تليفونيًا، عشان يبقى فيه سجل واضح قابل للمراجعة لكل حالة إسناد تلقائي حصلت
async function getAutoAssignLog(req, res) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 30;
  const offset = (page - 1) * limit;
  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM call_assignment_log WHERE filters->>'auto' = 'true'`
    );
    const result = await pool.query(
      `SELECT cal.tafra_student_id, s.name AS student_name, s.phone,
         tb.name AS bootcamp_name, en.enrolled_at,
         u.name AS assigned_to_name, cal.created_at AS assigned_at
       FROM call_assignment_log cal
       JOIN tafra_students s ON s.tafra_student_id = cal.tafra_student_id
       LEFT JOIN users u ON u.id = cal.assigned_to
       LEFT JOIN tafra_enrollments en ON en.tafra_student_id = cal.tafra_student_id
         AND en.tafra_bootcamp_id = (cal.filters->>'bootcamp_id')::bigint
       LEFT JOIN tafra_bootcamps tb ON tb.tafra_bootcamp_id = (cal.filters->>'bootcamp_id')::bigint
       WHERE cal.filters->>'auto' = 'true'
       ORDER BY cal.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const total = countResult.rows[0].count;
    res.json({ log: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('❌ Failed to load auto-assign log:', error.message);
    res.status(500).json({ error: 'تعذر تحميل سجل الإسناد التلقائي' });
  }
}

async function updateAutoAssignConfig(req, res) {
  const enabled = Boolean(req.body.enabled);
  const bootcampIds = Array.isArray(req.body.bootcamp_ids)
    ? [...new Set(req.body.bootcamp_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  const employeeIds = Array.isArray(req.body.employee_ids)
    ? [...new Set(req.body.employee_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];

  if (enabled && !bootcampIds.length) return res.status(400).json({ error: 'اختر كورس واحد على الأقل' });
  if (enabled && !employeeIds.length) return res.status(400).json({ error: 'اختر موظف واحد على الأقل للتوزيع بالتبادل' });

  try {
    await pool.query(
      `UPDATE call_auto_assign_config SET enabled = $1, bootcamp_ids = $2, employee_ids = $3, updated_at = NOW()
       WHERE id = 1`,
      [enabled, bootcampIds, employeeIds]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to update call auto-assign config:', error.message);
    res.status(500).json({ error: 'تعذر حفظ إعدادات الإسناد التلقائي' });
  }
}

module.exports = {
  listOutcomes,
  createOutcome,
  listAssignees,
  assignStudents,
  unassignStudents,
  listStudentsForAssignment,
  listStudentIdsForAssignment,
  getAssignmentLog,
  listMyStudents,
  getStudentProfile,
  getStudentExams,
  getStudentLessons,
  toggleStudentUrgent,
  bulkToggleUrgent,
  logSmsSend,
  logCall,
  editCallLog,
  updateStudentGrade,
  getAutoAssignConfig,
  updateAutoAssignConfig,
  getAutoAssignLog,
};
