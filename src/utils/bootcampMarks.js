// علامة الباب البسيطة اللي بتتحط جنب اسم الطالب في أي مكان يعرض بياناته (تذاكر/طلاب/تقارير/جهات اتصال)
// مطابقة بالاسم عشان تفضل شغّالة حتى لو اتغيّر رقم الباب على منصة طفرة. lo alias المستخدم لجدول
// tafra_bootcamps لازم يبقى "tb" في أي استعلام بيستخدم الثابتين دول.
const CHAPTER_ONE_MATCH_SQL = "(tb.name ILIKE '%الباب الأول%' AND tb.name ILIKE '%العناصر الانتقالية%')";
const FULL_CURRICULUM_MATCH_SQL = "(tb.name ILIKE '%المنهج%' AND tb.name ILIKE '%كامل%')";

// SELECT جاهز يتحط جوه أي LATERAL JOIN بيلف على تسجيلات tafra_enrollments/tafra_bootcamps بنفس alias الـ tb
const BOOTCAMP_MARKS_SELECT_SQL = `
  BOOL_OR(${CHAPTER_ONE_MATCH_SQL}) AS in_chapter_one,
  BOOL_OR(${FULL_CURRICULUM_MATCH_SQL}) AS in_full_curriculum
`;

module.exports = { CHAPTER_ONE_MATCH_SQL, FULL_CURRICULUM_MATCH_SQL, BOOTCAMP_MARKS_SELECT_SQL };
