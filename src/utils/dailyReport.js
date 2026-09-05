const pool = require('../config/db');
const { REACHED_CONDITION_SQL } = require('./callOutcomes');
const { getTeam } = require('./teams');

// ---------- التقرير اليومي للأدمن على تيليجرام ----------
//
// بيتبني هنا مش في الهاندلر عشان يتجرّب بـ `node -e` من غير بوت ولا webhook (مفيش تستات في
// المشروع، والتجريب المباشر هو الفحص الوحيد المتاح).
//
// القاعدة شغالة UTC والتقرير بيتقري بتوقيت القاهرة، فبداية اليوم لازم تعدّي على AT TIME ZONE
// صراحةً — من غيرها التقرير اللي بيتطلب الساعة ١ بالليل بيرجّع شغل اليوم اللي فات. نفس قاعدة
// `performance.controller.js` بالظبط
const TZ = 'Africa/Cairo';
const DAY_START_SQL = `(((NOW() AT TIME ZONE '${TZ}')::date)::timestamp AT TIME ZONE '${TZ}')`;

// حد رسالة تيليجرام ٤٠٩٦ حرف. بنقسم قبلها بهامش عشان الرسالة ماترجعش خطأ لو الفريق كبر أو
// اتضافت أبواب جديدة — التقسيم بيحصل على حدود السطور مش نص السطر
const MAX_MESSAGE_LENGTH = 3800;

// الأبواب التجريبية والإدارية موجودة فعلًا في المنصة ("تجربة دفع"، "خاص بمسئولي إدارة المنصة")
// وبتطلع باشتراك أو اتنين. مابنفلترهاش عن قصد — الرقم الإجمالي لازم يطابق المنصة، والباب اللي
// فيه اشتراك واحد بيبان في آخر القايمة ومابيزعجش
async function collectDailyReport() {
  const [staff, newEnrollments, bootcampTotals, syncStatus] = await Promise.all([
    // الأدمن مستثنى من قايمة الأداء: التقرير ده **بيتبعتله هو** عن الموظفين، فسطر باسمه
    // بصفر نشاط ضوضا مالهاش معنى
    pool.query(`
      WITH replies AS (
        SELECT sm.sent_by AS user_id, COUNT(*)::int AS replies,
               COUNT(DISTINCT sm.ticket_id)::int AS conversations
        FROM support_messages sm
        WHERE sm.deleted_at IS NULL AND sm.sent_by IS NOT NULL
          AND sm.broadcast_recipient_id IS NULL
          AND sm.sent_at >= ${DAY_START_SQL}
        GROUP BY sm.sent_by
      ),
      calls AS (
        SELECT cl.called_by AS user_id, COUNT(*)::int AS calls,
               COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS reached
        FROM call_logs cl
        LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
        WHERE cl.called_by IS NOT NULL AND cl.called_at >= ${DAY_START_SQL}
        GROUP BY cl.called_by
      ),
      ideas AS (
        SELECT ipl.changed_by AS user_id, COUNT(*)::int AS idea_moves
        FROM idea_progress_log ipl
        WHERE ipl.changed_by IS NOT NULL AND ipl.changed_at >= ${DAY_START_SQL}
        GROUP BY ipl.changed_by
      )
      SELECT u.id, u.name, u.team,
             COALESCE(r.replies, 0) AS replies,
             COALESCE(r.conversations, 0) AS conversations,
             COALESCE(c.calls, 0) AS calls,
             COALESCE(c.reached, 0) AS reached,
             COALESCE(i.idea_moves, 0) AS idea_moves
      FROM users u
      LEFT JOIN replies r ON r.user_id = u.id
      LEFT JOIN calls c ON c.user_id = u.id
      LEFT JOIN ideas i ON i.user_id = u.id
      WHERE u.is_active AND u.role <> 'admin'
      ORDER BY (COALESCE(r.replies, 0) + COALESCE(c.calls, 0) + COALESCE(i.idea_moves, 0)) DESC, u.name
    `),

    // `enroll` بس: `renew` تجديد لاشتراك موجود مش طالب جديد، و`locked` اشتراك متوقف —
    // ضمّهم كان هيخلّي رقم "اشتراكات النهاردة" أكبر من الحقيقة
    pool.query(`
      SELECT b.name, COUNT(*)::int AS count
      FROM tafra_enrollments e
      JOIN tafra_bootcamps b ON b.tafra_bootcamp_id = e.tafra_bootcamp_id
      WHERE e.enrollment_type = 'enroll' AND e.enrolled_at >= ${DAY_START_SQL}
      GROUP BY b.name
      ORDER BY count DESC, b.name
    `),

    pool.query(`
      SELECT b.name, COUNT(*)::int AS count
      FROM tafra_enrollments e
      JOIN tafra_bootcamps b ON b.tafra_bootcamp_id = e.tafra_bootcamp_id
      WHERE e.enrollment_type = 'enroll'
      GROUP BY b.name
      ORDER BY count DESC, b.name
    `),

    pool.query("SELECT status, completed_at FROM tafra_enrollment_sync_status WHERE id = 1"),
  ]);

  return {
    generatedAt: new Date(),
    staff: staff.rows.map((row) => ({
      name: (row.name || '').trim(),
      team: row.team || null,
      replies: Number(row.replies) || 0,
      conversations: Number(row.conversations) || 0,
      calls: Number(row.calls) || 0,
      reached: Number(row.reached) || 0,
      ideaMoves: Number(row.idea_moves) || 0,
    })),
    newEnrollments: newEnrollments.rows.map((row) => ({ name: row.name, count: Number(row.count) })),
    bootcampTotals: bootcampTotals.rows.map((row) => ({ name: row.name, count: Number(row.count) })),
    sync: syncStatus.rows[0] || null,
  };
}

function formatDateTime(value) {
  return new Date(value).toLocaleString('ar-EG', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: TZ,
  });
}

function staffLine(member) {
  const team = member.team ? getTeam(member.team) : null;
  const label = team ? `${member.name} (${team.label})` : member.name;
  const parts = [];
  if (member.replies) parts.push(`${member.replies} رد على ${member.conversations} محادثة`);
  if (member.calls) {
    parts.push(`${member.calls} مكالمة (وصل لـ ${member.reached})`);
  }
  if (member.ideaMoves) parts.push(`${member.ideaMoves} تحديث فكرة`);
  return `• ${label}: ${parts.join(' — ')}`;
}

function formatDailyReport(data) {
  const day = new Date(data.generatedAt).toLocaleDateString('ar-EG', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ,
  });
  const clock = new Date(data.generatedAt).toLocaleTimeString('ar-EG', {
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  });

  const lines = [`📊 التقرير اليومي — ${day}`, `من أول النهار لحد ${clock} بتوقيت القاهرة`, ''];

  // ---------- أداء الموظفين ----------
  const active = data.staff.filter((member) => member.replies || member.calls || member.ideaMoves);
  const idle = data.staff.filter((member) => !member.replies && !member.calls && !member.ideaMoves);

  lines.push(`👥 أداء الموظفين (${active.length} من ${data.staff.length} اشتغلوا النهاردة)`);
  if (active.length) {
    active.forEach((member) => lines.push(staffLine(member)));
  } else {
    lines.push('• مفيش أي نشاط مسجّل النهاردة');
  }
  if (idle.length) {
    lines.push(`⚪️ من غير نشاط (${idle.length}): ${idle.map((member) => member.name).join('، ')}`);
  }

  // ---------- اشتراكات النهاردة ----------
  const newTotal = data.newEnrollments.reduce((sum, row) => sum + row.count, 0);
  lines.push('', `🆕 اشتراكات جديدة النهاردة: ${newTotal}`);
  if (data.newEnrollments.length) {
    data.newEnrollments.forEach((row) => lines.push(`• ${row.name}: ${row.count}`));
  } else {
    lines.push('• لسه مفيش اشتراك جديد لحد دلوقتي');
  }

  // ---------- إجمالي كل باب ----------
  const grandTotal = data.bootcampTotals.reduce((sum, row) => sum + row.count, 0);
  lines.push('', `📚 إجمالي الاشتراكات لكل باب (${grandTotal})`);
  data.bootcampTotals.forEach((row) => lines.push(`• ${row.name}: ${row.count}`));

  // ---------- مصدر الأرقام ----------
  // أرقام الاشتراكات بتيجي من مزامنة طفرة كل ٦ ساعات، مش لحظية. من غير السطر ده الأدمن ممكن
  // يفتكر إن اشتراك اتعمل من نص ساعة ناقص، والحقيقة إنه لسه ماتزامنش
  if (data.sync?.completed_at) {
    lines.push('', `🔄 آخر مزامنة اشتراكات: ${formatDateTime(data.sync.completed_at)}`);
    lines.push('الاشتراكات بتتزامن من المنصة كل ٦ ساعات، فاللي اتعمل بعد المزامنة دي هيبان في التقرير الجاي.');
  } else {
    lines.push('', '⚠️ مزامنة الاشتراكات لسه ماتمّتش، والأرقام فوق ممكن تكون ناقصة.');
  }

  // تقسيم على حدود السطور — سطر واحد عمره ما هيعدّي الحد، فمفيش حالة سطر مايتحطش
  const chunks = [];
  let current = '';
  lines.forEach((line) => {
    if (current && current.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  });
  if (current) chunks.push(current);
  return chunks;
}

async function buildDailyReport() {
  return formatDailyReport(await collectDailyReport());
}

module.exports = { buildDailyReport, collectDailyReport, formatDailyReport };
