const pool = require('../config/db');

// ===================== كتالوج دروس الكورسات =====================
// بيجاوب سؤال "الكورس ده فيه كام فيديو وبكام دقيقة؟" — وده مقام كل النِسَب في تقرير الطالب.
//
// المنصة مابتديش محتوى الكورس مباشرة (شوف التعليق فوق tafra_bootcamp_lessons في schema.sql).
// الربط الوحيد بين الدرس والكورس في سجل المشاهدات، فبنمسح مشاهدات الكورس **لكل الطلاب**
// ونجمع أسماء الدروس ومددها. الاتحاد بيستقر بدري: كورس الباب الأول وصل ٤٠ درس بعد ١٥ صفحة
// وفضل ثابت لحد ٦٠، فبنقف لما عدد صفحات متتالية ماتضيفش أي درس جديد بدل ما نمسح ١٠٢٥ صفحة.

// عدد الصفحات المتتالية من غير أي درس جديد اللي بعدها نعتبر الكتالوج اكتمل
const STABLE_PAGES_BEFORE_STOP = 12;
// سقف مطلق يحمي من كورس ضخم أو من درس نادر بيظهر كل شوية
const MAX_PAGES_PER_BOOTCAMP = 120;

async function buildBootcampCatalogue(client, bootcampId, { onProgress } = {}) {
  const lessons = new Map();
  let stablePages = 0;
  let pagesRead = 0;

  for (let page = 1; page <= MAX_PAGES_PER_BOOTCAMP; page += 1) {
    let response;
    try {
      response = await client.getBootcampLessonViewsPage(bootcampId, page);
    } catch (error) {
      // صفحة واحدة بتفشل مابتوقفش الكتالوج — بنكمّل ونسيبها
      continue;
    }
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];
    pagesRead += 1;
    const before = lessons.size;
    rows.forEach((row) => {
      const name = String(row.lesson_name || '').trim();
      if (!name || lessons.has(name)) return;
      const duration = Math.max(0, Math.round(Number(row.lesson_duration_seconds) || 0));
      // المدة صفر = مذكرة أو ملف مش فيديو، فمابتدخلش الكتالوج أصلًا
      if (row.is_video === false || !duration) return;
      lessons.set(name, { name, duration_seconds: duration, is_video: true });
    });
    stablePages = lessons.size === before ? stablePages + 1 : 0;
    if (onProgress) onProgress({ page, lessons: lessons.size, stablePages });

    const lastPage = Number(response.data?.meta?.last_page || 1);
    if (page >= lastPage || !rows.length || stablePages >= STABLE_PAGES_BEFORE_STOP) break;
    await new Promise((resolve) => setTimeout(resolve, 110));
  }

  return { lessons: [...lessons.values()], pagesRead };
}

// بيكتب الكتالوج بدل القديم. الحذف والكتابة في transaction عشان التقرير مايشوفش كتالوج نص
// مكتوب لو اتنادت المزامنة وهو بيتقرا
async function saveBootcampCatalogue(bootcampId, lessons) {
  if (!lessons.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tafra_bootcamp_lessons WHERE tafra_bootcamp_id = $1', [bootcampId]);
    await client.query(
      `INSERT INTO tafra_bootcamp_lessons (tafra_bootcamp_id, lesson_name, duration_seconds, is_video, updated_at)
       SELECT $1, x.lesson_name, x.duration_seconds, x.is_video, NOW()
       FROM jsonb_to_recordset($2::jsonb) AS x(lesson_name text, duration_seconds integer, is_video boolean)`,
      [bootcampId, JSON.stringify(lessons.map((lesson) => ({
        lesson_name: lesson.name, duration_seconds: lesson.duration_seconds, is_video: lesson.is_video,
      })))]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return lessons.length;
}

// إجمالي محتوى الكورسات المطلوبة — الصفر معناه إن الكتالوج لسه ما اتبناش لها.
//
// **التفريد بالاسم ضروري:** ٥٥ درس من ١٧٩ موجودين في أكتر من كورس (كورس "المنهج كاملا" فيه
// نفس دروس "الباب الأول")، و٦٤ طالب مشتركين في الاتنين. من غير DISTINCT كان مقامهم هيتحسب
// مرتين فنسبتهم تتنصّف من غير سبب
async function getCatalogueTotals(bootcampIds) {
  if (!bootcampIds.length) return { video_count: 0, total_seconds: 0, lesson_names: [] };
  const result = await pool.query(
    `SELECT COUNT(*)::int AS video_count,
       COALESCE(SUM(duration_seconds), 0)::int AS total_seconds,
       ARRAY_AGG(lesson_name) AS lesson_names
     FROM (
       SELECT DISTINCT ON (lesson_name) lesson_name, duration_seconds
       FROM tafra_bootcamp_lessons
       WHERE tafra_bootcamp_id = ANY($1::bigint[]) AND is_video AND duration_seconds > 0
       ORDER BY lesson_name, duration_seconds DESC
     ) unique_lessons`,
    [bootcampIds]
  );
  const row = result.rows[0] || {};
  return {
    video_count: Number(row.video_count) || 0,
    total_seconds: Number(row.total_seconds) || 0,
    lesson_names: row.lesson_names || [],
  };
}

module.exports = {
  buildBootcampCatalogue, saveBootcampCatalogue, getCatalogueTotals,
  STABLE_PAGES_BEFORE_STOP, MAX_PAGES_PER_BOOTCAMP,
};
