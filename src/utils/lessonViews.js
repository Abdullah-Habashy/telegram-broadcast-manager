const { TafraReadOnlyClient } = require('../integrations/tafraClient');

// مشاهدات فيديوهات الطالب — مصدر واحد بتقرا منه شاشة المتابعة التليفونية وصندوق الدعم، عشان
// الرقم اللي الموظف بيشوفه في المحادثة يبقى هو هو اللي في بروفايل المتابعة بالظبط.
//
// البيانات **مش** متخزنة عندنا: مفيش جدول ولا مزامنة، والنداء لحظي لمنصة طفرة في كل مرة.
// ده متعمّد — الأرقام بتبقى محدّثة دايمًا، وبيتفادى مشكلة زي مزامنة الاختبارات اللي وقفت ٨ أيام
// وخلّت اللوحة تعرض أصفار. الثمن إن الكارت بطيء شوية وممكن يفشل لو المنصة وقعت، فبيتنادى
// كسول (عند فتح الكارت) ومعزول عن باقي بيانات الشاشة.
//
// ملحوظة على القدرات: نقطة النهاية دي بتشتغل كمان من غير filter[user_id] وبترجّع كل المشاهدات،
// لكن الاستجابة مافيهاش معرّف طالب — الاسم بس. فأي تجميع لكل الطلاب لازم يمشي طالب-بطالب،
// لأن المطابقة بالاسم مش موثوقة (فيه أسماء متكررة على أكتر من طالب)
// علامة is_completed اللي بترجّعها المنصة **مش** معناها إن الطالب خلّص الفيديو — قسناها على
// بيانات حقيقية ولقينا ٨٧ فيديو متعلّم عليهم "مكتمل" منهم ٢٩ نسبة مشاهدتهم صفر بالظبط. يعني
// الأقرب إنها بتعني "الفيديو متاح/مفتوح له" مش "اتفرج عليه". فبنحسب الاكتمال من نسبة المشاهدة
// نفسها، وده الرقم اللي بيتعرض للموظف ولولي الأمر — عشان محدش يتفرج على رقم مش حقيقي
const COMPLETED_PROGRESS_THRESHOLD = 90;

const isCompletedByProgress = (row) => Number(row.progress_percentage) >= COMPLETED_PROGRESS_THRESHOLD;

// بيحسب الملخص من أي قايمة مشاهدات — مفصولة عن الجلب عشان تقرير الكورس الواحد يقدر يفلتر
// القايمة الأول وبعدين يلخّصها من جديد، فالنِسَب تطلع للكورس ده لوحده مش للكل
// درس بمدة صفر مش فيديو: دي مذكرات وملفات PDF ومحتوى مالوش مدة، والمنصة بتعلّم بعضها
// is_video=true بالغلط. بتتشال من التقرير كله — من الجدول ومن العدد ومن حساب النسبة — لأن
// وجودها في المقام بينزّل النسبة من غير سبب حقيقي
const isRealVideo = (row) => row.is_video !== false && Number(row.lesson_duration_seconds) > 0;

function summariseLessonViews(allRows, meta = {}) {
  // نفس الدرس ممكن يرجع مرتين لو موجود في أكتر من كورس الطالب مشترك فيهم (٥٥ درس عندنا كده)،
  // فبنسيب أعلى نسخة مشاهدة بس — وإلا وقته المتفرَّج بيتضاعف والنسبة تعدّي ١٠٠%
  const bestByLesson = new Map();
  allRows.filter(isRealVideo).forEach((row) => {
    const key = String(row.lesson_name || '').trim() || `#${row.id}`;
    const current = bestByLesson.get(key);
    const watched = Number(row.watch_progress_seconds) || 0;
    if (!current || watched > (Number(current.watch_progress_seconds) || 0)) bestByLesson.set(key, row);
  });
  const rows = [...bestByLesson.values()];
  const total = meta.total === undefined ? rows.length : meta.total;
  const truncated = Boolean(meta.truncated);

  const videos = rows;
  const completed = videos.filter(isCompletedByProgress).length;
  const percentages = videos
    .map((row) => Number(row.progress_percentage))
    .filter((value) => Number.isFinite(value));

  // نسبة المشاهدة الحقيقية = الدقايق اللي اتفرّجها فعلًا ÷ دقايق كل الفيديوهات المتاحة له.
  // مختلفة عن متوسط النسب: طالب فتح فيديو قصير وخلّصه وساب محاضرة ساعتين متوسطه بيطلع ٥٠%،
  // لكنه فعليًا شاف جزء صغير من المحتوى. الوقت بيقيس اللي اتشاف فعلًا مش عدد المرات
  const sumSeconds = (key) => videos.reduce((total, row) => {
    const value = Number(row[key]);
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  // المشاهدة ممكن تتعدّى مدة الفيديو (إعادة مشاهدة)، فبنقصّها على المدة عشان النسبة ما تعديش ١٠٠%
  const watchedSeconds = videos.reduce((total, row) => {
    const watched = Number(row.watch_progress_seconds);
    const duration = Number(row.lesson_duration_seconds);
    if (!Number.isFinite(watched) || watched <= 0) return total;
    return total + (Number.isFinite(duration) && duration > 0 ? Math.min(watched, duration) : watched);
  }, 0);
  const totalSeconds = sumSeconds('lesson_duration_seconds');

  return {
    views: rows,
    summary: {
      total,
      shown: rows.length,
      truncated,
      video_count: videos.length,
      completed_count: completed,
      opened_count: videos.filter((row) => Number(row.progress_percentage) > 0).length,
      average_progress: percentages.length
        ? Math.round((percentages.reduce((sum, value) => sum + value, 0) / percentages.length) * 10) / 10
        : null,
      watched_seconds: watchedSeconds,
      total_seconds: totalSeconds,
      time_percentage: totalSeconds ? Math.round((watchedSeconds / totalSeconds) * 1000) / 10 : null,
    },
  };
}

async function fetchStudentLessonViews(credentials, studentId) {
  const client = new TafraReadOnlyClient(credentials.identifier, credentials.password);
  const { rows, total, truncated } = await client.getStudentLessonViews(studentId);
  return summariseLessonViews(rows, { total, truncated });
}

module.exports = {
  fetchStudentLessonViews, summariseLessonViews, isCompletedByProgress, isRealVideo,
  COMPLETED_PROGRESS_THRESHOLD,
};
