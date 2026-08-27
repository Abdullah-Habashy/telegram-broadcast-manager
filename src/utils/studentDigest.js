const pool = require('../config/db');

// ===================== ملخّص الطالب لنفسه =====================
// تقرير ولي الأمر بيعرض أرقام؛ التقرير ده بيقول للطالب **يعمل إيه دلوقتي**. فالملف ده
// بيحوّل نفس الأرقام لـ: جملة تحفيزية، شارة، نقاط قوة، ونقاط محتاجة مراجعة.
//
// **قاعدة الصياغة:** مفيش جملة سلبية عن الطالب نفسه. الضعف بيتقال كخطوة ناقصة ("فاضلك ٤
// اختبارات") مش كحكم ("مستواك ضعيف"). الفرق ده هو كل الفرق بين تقرير بيشحّن وتقرير بيقفّل.

// ---------- الترتيب بين الزمايل ----------
// **ليه عتبات مش ترتيب مباشر:** الوسيط الفعلي بين ٢٦٥٣ طالب = ٨٦٪. يعني لو عرضنا الترتيب
// للكل، أكتر من نص الطلاب هيشوفوا إنهم "تحت المتوسط" — وده عكس هدف الصفحة بالظبط.
// فالترتيب بيظهر **بس لو مشرّف** (أعلى ٢٥٪)، وغير كده الطالب بيشوف شارة على إنجازه هو.
//
// والحساب متكاش ١٠ دقايق لأنه بيمسح كل درجات المنصة (٢٤٠ مللي) — رقم مابيتغيرش من دقيقة للتانية
const PEER_CACHE_MS = 10 * 60 * 1000;
let peerCache = { at: 0, value: null };

const PEER_SQL = `
  WITH per_student AS (
    SELECT tafra_student_id, AVG(percentage) AS avg_pct
    FROM tafra_exam_marks
    WHERE percentage IS NOT NULL
    GROUP BY tafra_student_id
    -- أقل من ٣ اختبارات مش عيّنة كفاية: طالب دخل اختبار واحد وجاب ١٠٠ مايزحّمش القمة
    HAVING COUNT(*) >= 3
  )
  SELECT
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY avg_pct) AS p75,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY avg_pct) AS p90,
    COUNT(*)::int AS peers
  FROM per_student`;

async function peerThresholds() {
  if (peerCache.value && Date.now() - peerCache.at < PEER_CACHE_MS) return peerCache.value;
  try {
    const { rows } = await pool.query(PEER_SQL);
    peerCache = { at: Date.now(), value: rows[0] || null };
  } catch (error) {
    // فشل الحساب مايوقّفش الصفحة — الطالب يشوف تقريره من غير ترتيب
    console.error('❌ Failed to compute peer thresholds:', error.message);
    peerCache = { at: Date.now(), value: null };
  }
  return peerCache.value;
}

// ---------- الجملة الافتتاحية ----------
// بتتبني على حاجتين مع بعض: مستوى الدرجات، ونسبة الاختبارات اللي دخلها. طالب متوسطه ٩٥ بس
// داخل ٢ من ١٢ محتاج جملة مختلفة تمامًا عن طالب متوسطه ٩٥ وخلّص كل حاجة
function headlineFor({ average, taken, available, firstName }) {
  const name = firstName ? `${firstName}، ` : '';
  const coverage = available ? taken / available : 0;

  if (!taken) {
    return {
      tone: 'start',
      headline: `${name}لسه ما دخلتش أول اختبار`,
      subline: available
        ? `فيه ${available} اختبار مستنيينك. ابدأ بواحد النهارده وهتلاقي تقريرك اتغيّر.`
        : 'أول ما تبدأ، هتلاقي تقدّمك كله هنا.',
    };
  }
  if (average === null) {
    return { tone: 'start', headline: `${name}اختباراتك لسه بتتصحّح`, subline: 'أول ما تنزل الدرجات هتلاقيها هنا.' };
  }
  if (average >= 85 && coverage >= 0.8) {
    return { tone: 'great', headline: `${name}مستواك ممتاز 🔥`, subline: `متوسطك ${average}% وخلّصت اللي عليك. كمّل بنفس الإيقاع.` };
  }
  if (average >= 85) {
    return { tone: 'great', headline: `${name}درجاتك ممتازة`, subline: `متوسطك ${average}% — فاضلك ${available - taken} اختبار عشان الصورة تكمل.` };
  }
  if (average >= 70) {
    return { tone: 'good', headline: `${name}شغلك كويس، وفيه مساحة تكبر`, subline: `متوسطك ${average}%. لو ركّزت في اللي تحت، ٨٥ في متناولك.` };
  }
  if (average >= 50) {
    return { tone: 'push', headline: `${name}محتاج تركيز أكتر في الحل`, subline: `متوسطك ${average}%. المراجعة تحت هي أقصر طريق يرفعه.` };
  }
  return {
    tone: 'push',
    headline: `${name}البداية دايمًا أصعب جزء`,
    subline: 'ركّز في الدروس اللي تحت واحد واحد — الفرق بيبان بسرعة.',
  };
}

// ---------- الشارة ----------
// **على إنجاز الطالب نفسه، مش على مقارنته بحد.** فأي طالب بيقدر يوصل لأعلى شارة لو خلّص
// اللي عليه، ومحدش بياخد شارة أقل عشان زميله أشطر
function badgeFor({ average, taken, available, watchedPercent }) {
  const coverage = available ? taken / available : 0;
  const watch = Number.isFinite(watchedPercent) ? watchedPercent : null;

  if (!taken) return { emoji: '🌱', label: 'البداية', hint: 'أول اختبار بيفتح الباب' };
  if (average >= 90 && coverage >= 0.9) return { emoji: '🏆', label: 'متمكّن', hint: 'درجات عالية والتزام كامل' };
  if (average >= 85 && coverage >= 0.6) return { emoji: '⭐', label: 'متفوّق', hint: 'مستواك عالي ومستمر' };
  if (coverage >= 0.8) return { emoji: '🎯', label: 'ملتزم', hint: 'بتدخل كل اختبار متاح' };
  if (watch !== null && watch >= 60) return { emoji: '📺', label: 'متابع', hint: 'بتشوف المحتوى أولًا بأول' };
  if (average >= 70) return { emoji: '💪', label: 'في الطريق', hint: 'درجاتك كويسة، كمّل' };
  return { emoji: '🚀', label: 'بتبني نفسك', hint: 'كل خطوة بتتحسب' };
}

// الترتيب بيتقال بصيغة "ضمن أفضل ×" مش برقم — الرقم بيخلي الطالب يقارن نفسه بواحد بعينه،
// والشريحة بتديله نفس الإحساس من غير المقارنة الشخصية
function rankFor(average, thresholds) {
  if (average === null || !thresholds || !thresholds.peers) return null;
  if (average >= Number(thresholds.p90)) return { label: 'ضمن أفضل 10% من زمايلك', tone: 'gold' };
  if (average >= Number(thresholds.p75)) return { label: 'ضمن أفضل 25% من زمايلك', tone: 'silver' };
  return null;
}

// ---------- نقاط القوة والمراجعة (من الاختبارات) ----------
// أعلى ٣ وأقل ٣، وكل واحدة بجملة تقول تعمل إيه. **الأقل مش بيتسمّى "ضعف"** — بيتسمّى
// "محتاجة مراجعة"، وده اللي بيخلي الطالب يفتحها بدل ما يقفل الصفحة
function examHighlights(examRows) {
  const graded = examRows
    .filter((row) => row.percentage !== null && row.name)
    .sort((a, b) => b.percentage - a.percentage);
  if (!graded.length) return { strengths: [], focus: [] };

  const strengths = graded.filter((row) => row.percentage >= 75).slice(0, 3)
    .map((row) => ({ title: row.name, value: `${Math.round(row.percentage)}%`, note: row.percentage >= 95 ? 'إتقان كامل' : 'مستوى قوي' }));

  // العتبة ٦٥ مش ٥٠: الهدف يلفت نظره للي ممكن يترفع بسهولة، مش يعرض ليستة رسوب
  const focus = graded.filter((row) => row.percentage < 65).slice(-3).reverse()
    .map((row) => ({ title: row.name, value: `${Math.round(row.percentage)}%`, note: 'راجع أسئلتها الغلط' }));

  return { strengths, focus };
}

async function buildDigest({ report }) {
  const { exams, student } = report;
  const firstName = (student.name || '').trim().split(/\s+/)[0] || '';
  // **رقم صحيح مش كسور.** "متوسطك ٥٨.٩%" بيتقري كتقييم إداري، و"٥٩%" بيتقري كنتيجة.
  // الكسر مالوش أي معنى للطالب، وبيضيف دقة كاذبة على رقم أصلًا بيتغيّر مع كل اختبار
  const average = exams.average === null ? null : Math.round(exams.average);
  const thresholds = await peerThresholds();

  return {
    ...headlineFor({ average, taken: exams.total, available: exams.available, firstName }),
    badge: badgeFor({ average, taken: exams.total, available: exams.available, watchedPercent: null }),
    rank: rankFor(average, thresholds),
    ...examHighlights(exams.rows),
  };
}

module.exports = { buildDigest, peerThresholds, headlineFor, badgeFor, rankFor, examHighlights };
