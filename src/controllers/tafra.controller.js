const pool = require('../config/db');
const { encrypt, decrypt } = require('../utils/crypto');
const { TafraReadOnlyClient, BASE_URL } = require('../integrations/tafraClient');

let syncRunning = false;
let enrollmentSyncRunning = false;

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

async function listStudents(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
  const params = [];
  const conditions = [];
  const addCondition = (value, sql) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  const search = String(req.query.search || '').trim();
  if (search) addCondition(`%${search}%`, `(s.name ILIKE ? OR s.phone ILIKE ? OR s.parent_phone ILIKE ? OR s.student_code ILIKE ? OR s.telegram_username ILIKE ? OR s.telegram_chat_id::text ILIKE ?)`);
  if (search) {
    const placeholder = `$${params.length}`;
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replaceAll('?', placeholder);
  }
  if (req.query.level) addCondition(String(req.query.level), 's.educational_level #>> \'{}\' = ?');
  if (req.query.status) addCondition(String(req.query.status), 's.status = ?');
  if (req.query.telegram === 'linked') conditions.push('s.telegram_chat_id IS NOT NULL');
  if (req.query.telegram === 'unlinked') conditions.push('s.telegram_chat_id IS NULL');
  if (req.query.education_type === 'azhar') conditions.push("s.educational_level #>> '{}' ILIKE '%ازهر%'");
  if (req.query.education_type === 'general') conditions.push("COALESCE(s.educational_level #>> '{}', '') NOT ILIKE '%ازهر%'");
  if (req.query.bootcamp && /^\d+$/.test(String(req.query.bootcamp))) {
    params.push(Number(req.query.bootcamp));
    let enrollmentCondition = `e.tafra_bootcamp_id = $${params.length} AND e.enrollment_type = 'enroll'`;
    if (req.query.enrolled_from && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.enrolled_from))) {
      params.push(req.query.enrolled_from);
      enrollmentCondition += ` AND e.enrolled_at >= $${params.length}::date`;
    }
    if (req.query.enrolled_to && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.enrolled_to))) {
      params.push(req.query.enrolled_to);
      enrollmentCondition += ` AND e.enrolled_at < ($${params.length}::date + INTERVAL '1 day')`;
    }
    conditions.push(`EXISTS (SELECT 1 FROM tafra_enrollments e WHERE e.tafra_student_id = s.tafra_student_id AND ${enrollmentCondition})`);
  }
  if (req.query.idea_number && /^\d+$/.test(String(req.query.idea_number))) {
    if (String(req.query.idea_number) === '0') {
      conditions.push('(t.current_idea_number IS NULL)');
    } else {
      addCondition(Number(req.query.idea_number), 't.current_idea_number = ?');
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       ${where}`,
      params
    );
    params.push(limit, (page - 1) * limit);
    const result = await pool.query(
      `SELECT s.tafra_student_id, s.name, s.phone, s.parent_phone, s.status, s.rate,
        s.student_code, s.educational_level #>> '{}' AS educational_level,
        CASE WHEN s.educational_level #>> '{}' ILIKE '%ازهر%' THEN 'azhar' ELSE 'general' END AS education_type,
        s.telegram_linked, s.telegram_username, s.telegram_chat_id,
        s.registration_review_status, s.last_seen_at,
        c.id AS contact_id, t.current_idea_number
       FROM tafra_students s
       LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
       LEFT JOIN tickets t ON t.contact_id = c.id
       ${where}
       ORDER BY s.tafra_student_id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = countResult.rows[0].count;
    res.json({ students: result.rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('Failed to list Tafra students:', error.message);
    res.status(500).json({ error: 'تعذر عرض طلاب منصة طفرة' });
  }
}

async function getStudentFilters(req, res) {
  try {
    const [levels, statuses, bootcamps, enrollmentStatus, maxIdeaResult] = await Promise.all([
      pool.query("SELECT DISTINCT educational_level #>> '{}' AS value FROM tafra_students WHERE educational_level IS NOT NULL ORDER BY value"),
      pool.query('SELECT DISTINCT status AS value FROM tafra_students WHERE status IS NOT NULL ORDER BY value'),
      pool.query('SELECT tafra_bootcamp_id AS id, name FROM tafra_bootcamps WHERE is_available = TRUE ORDER BY name'),
      pool.query('SELECT * FROM tafra_enrollment_sync_status WHERE id = 1'),
      pool.query("SELECT value FROM settings WHERE key = 'max_idea_number'"),
    ]);
    const maxIdea = Number(maxIdeaResult.rows[0]?.value) || 20;
    res.json({
      levels: levels.rows.map((row) => row.value),
      statuses: statuses.rows.map((row) => row.value),
      bootcamps: bootcamps.rows,
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
  const normalizedRows = [...latestByStudent.values()].map((row) => ({ ...row, raw_data: row }));
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
      (tafra_student_id, name, phone, parent_phone, raw_data, last_seen_at, updated_at)
     SELECT x.student_id, x.student_name, x.phone, x.parent_phone, x.raw_data, NOW(), NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(
       student_id bigint, student_name text, phone text, parent_phone text, raw_data jsonb
     )
     WHERE x.student_id IS NOT NULL
     ON CONFLICT (tafra_student_id) DO UPDATE SET
       name = COALESCE(tafra_students.name, EXCLUDED.name),
       phone = COALESCE(tafra_students.phone, EXCLUDED.phone),
       parent_phone = COALESCE(tafra_students.parent_phone, EXCLUDED.parent_phone),
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

async function upsertPage(client, students) {
  const payload = JSON.stringify(students);
  await client.query(
    `INSERT INTO tafra_students
      (tafra_student_id, name, phone, parent_phone, status, rate, student_code,
       educational_level, telegram_linked, telegram_username, telegram_chat_id,
       registration_review_status, raw_data, last_seen_at, updated_at)
     SELECT
       x.id, x.name, x.phone, x.parent_phone, x.status, x.rate, x.code,
       x.educational_level, COALESCE(x.telegram_linked, FALSE), x.telegram_username,
       NULLIF(x.telegram_chat_id, '')::bigint, x.registration_review_status,
       x.raw_data, NOW(), NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(
       id bigint, name text, phone text, parent_phone text, status text, rate text,
       code text, educational_level jsonb, telegram_linked boolean,
       telegram_username text, telegram_chat_id text,
       registration_review_status text, raw_data jsonb
     )
     ON CONFLICT (tafra_student_id) DO UPDATE SET
       name = EXCLUDED.name, phone = EXCLUDED.phone, parent_phone = EXCLUDED.parent_phone,
       status = EXCLUDED.status, rate = EXCLUDED.rate, student_code = EXCLUDED.student_code,
       educational_level = EXCLUDED.educational_level,
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
      const normalized = students.map((student) => ({ ...student, raw_data: student }));

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

module.exports = { getStatus, saveCredentials, syncStudents, syncEnrollments, syncBootcampNames, listStudents, getStudentFilters };
