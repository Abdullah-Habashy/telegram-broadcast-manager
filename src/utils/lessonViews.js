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

async function fetchStudentLessonViews(credentials, studentId) {
  const client = new TafraReadOnlyClient(credentials.identifier, credentials.password);
  const { rows, total, truncated } = await client.getStudentLessonViews(studentId);

  const videos = rows.filter((row) => row.is_video !== false);
  const completed = videos.filter(isCompletedByProgress).length;
  const percentages = videos
    .map((row) => Number(row.progress_percentage))
    .filter((value) => Number.isFinite(value));

  return {
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
  };
}

module.exports = { fetchStudentLessonViews, isCompletedByProgress, COMPLETED_PROGRESS_THRESHOLD };
