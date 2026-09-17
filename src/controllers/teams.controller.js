const pool = require('../config/db');
const botManager = require('../bot/botManager');
const push = require('../utils/push');
const { getNextTeamAgent } = require('../utils/ticketAssignment');
const { getTeam } = require('../utils/teams');

// ---------- التيمات المتخصصة: الحضور والتحويل ----------
//
// التذكرة مابتنتقلش ملكيتها. assigned_to بيفضل موظف المتابعة طول الوقت وهو شايف كل الرسايل
// وعنده زراير التحويل دايمًا؛ transfer_agent_id بيزوّد موظف متخصص مؤقتًا جنبه. الطالب مش
// بيحس بأي حاجة — نفس البوت ونفس تسلسل الرسايل، ومحدش بيقوله "تم تحويلك".
//
// كل الدوال هنا بتشتغل على أي تيم بقيمة users.team — العلمي والفني بيستخدموا نفس الكود بالظبط

// حالة حضور الموظف الحالي + كام تذكرة في إيده
async function getAttendanceStatus(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT started_at, team FROM team_attendance WHERE user_id = $1 AND ended_at IS NULL LIMIT 1',
      [req.session.userId]
    );
    const holding = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tickets WHERE transfer_agent_id = $1',
      [req.session.userId]
    );
    res.json({
      present: Boolean(rows[0]),
      started_at: rows[0]?.started_at || null,
      holding: holding.rows[0].count,
    });
  } catch (error) {
    console.error('❌ Failed to read team attendance:', error.message);
    res.status(500).json({ error: 'تعذر قراءة حالة الحضور' });
  }
}

async function checkIn(req, res) {
  try {
    const me = await pool.query('SELECT team FROM users WHERE id = $1', [req.session.userId]);
    const team = getTeam(me.rows[0]?.team);
    if (!team) return res.status(403).json({ error: 'حسابك مش تابع لأي تيم متخصص' });

    // ON CONFLICT على الفهرس الجزئي الفريد: الضغط مرتين بسرعة أو من تبويبين مايعملش وردية تانية
    await pool.query(
      `INSERT INTO team_attendance (user_id, team) VALUES ($1, $2)
       ON CONFLICT (user_id) WHERE ended_at IS NULL DO NOTHING`,
      [req.session.userId, team.key]
    );
    const { rows } = await pool.query(
      'SELECT started_at FROM team_attendance WHERE user_id = $1 AND ended_at IS NULL LIMIT 1',
      [req.session.userId]
    );
    res.json({ present: true, started_at: rows[0]?.started_at || null });
  } catch (error) {
    console.error('❌ Failed to check in to the team shift:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل الحضور' });
  }
}

// الانصراف بيقفل الحضور بس. **مابيرجّعش أي تذكرة** — بقرار صاحب المشروع مافيش رجوع
// من غير ضغطة زرار من موظف.
//
// كان بيرجّع كل اللي في إيده لموظفي المتابعة، والمنطق كان "تذكرة عند موظف مشي معناها
// سؤال طالب واقف عند حد مش موجود". القرار اتغيّر، وde معناه إن التذكرة بتفضل معلّمة
// باسمه بعد ما يمشي لحد ما حد يرجّعها بإيده.
//
// **واللي بيخلي ده مقبول:** التحويل مشاركة مش نقل ملكية — `assigned_to` بيفضل موظف
// المتابعة، والتذكرة بتفضل ظاهرة في قايمته بلون التيم وعنده زرار الإرجاع. يعني مش
// بتختفي، بتفضل باينة ومحتاجة قرار.
//
// وجملة واحدة مش ترانزاكشن: مافيش بقى حاجتين لازم يحصلوا مع بعض
async function checkOut(req, res) {
  try {
    await pool.query(
      'UPDATE team_attendance SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL',
      [req.session.userId]
    );
    // العدد بيرجع عشان اللوحة تفكّره إن التذاكر لسه معاه — الرقم ده هو التنبيه الوحيد
    const holding = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tickets WHERE transfer_agent_id = $1',
      [req.session.userId]
    );
    res.json({ present: false, holding: holding.rows[0].count });
  } catch (error) {
    console.error('❌ Failed to check out of the team shift:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل الانصراف' });
  }
}

// ---------- سجل الحضور ----------
//
// الورديات كانت متسجّلة من ٢٥ أغسطس ومفيش مكان يشوفها فيه حد — الجدول بيتقري من التوزيع
// التلقائي بس. الشاشة دي بتعرضه.
//
// **الأدمن بيشوف الكل، والموظف بيشوف نفسه بس.** مش إعداد ولا خانة — الموظف مالوش دعوة
// بساعات زمايله، ونفس قاعدة تبويب «متابعة الأداء» بالظبط.
//
// **والساعات بتتعرض مع تحذيرها.** الموظف بينسى يدوس انصراف، فالوردية بتفضل مفتوحة
// لليوم اللي بعده ومجموع الساعات بيتضخّم. مابنصلّحش الرقم من عندنا — بنعلّم الورديات
// المشكوك فيها (مفتوحة أو أطول من ١٢ ساعة) عشان اللي بيقرا يعرف الرقم مبني على إيه.
const LONG_SHIFT_HOURS = 12;

async function listAttendanceHistory(req, res) {
  try {
    const isAdmin = req.session.userRole === 'admin';
    // الموظف بيتقفل على نفسه في السيرفر مش في الواجهة — إخفاء الفلتر تجميل،
    // والحارس الحقيقي هو إن الـuser_id بيتفرض هنا
    const requested = Number(req.body?.user || req.query.user);
    const userId = isAdmin ? (Number.isInteger(requested) && requested > 0 ? requested : null)
      : req.session.userId;

    // التواريخ بتوقيت القاهرة مش UTC: الموظف اللي سجّل حضور ٢ بالليل بيعتبرها ليلته هو،
    // وفلترة بالـUTC كانت هتحطّه في اليوم اللي بعده
    const to = String(req.query.to || '').slice(0, 10) || null;
    const from = String(req.query.from || '').slice(0, 10) || null;

    const conditions = [];
    const params = [];
    if (userId) { params.push(userId); conditions.push(`ta.user_id = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`(ta.started_at AT TIME ZONE 'Africa/Cairo')::date >= $${params.length}::date`); }
    if (to) { params.push(to); conditions.push(`(ta.started_at AT TIME ZONE 'Africa/Cairo')::date <= $${params.length}::date`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // المدة بتتحسب في القاعدة: الوردية المفتوحة مدتها لحد دلوقتي، والمقفولة لحد ما اتقفلت
    const { rows } = await pool.query(
      `SELECT ta.id, ta.user_id, u.name, ta.team, ta.started_at, ta.ended_at,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(ta.ended_at, NOW()) - ta.started_at)) / 60)::int AS minutes
       FROM team_attendance ta
       JOIN users u ON u.id = ta.user_id
       ${where}
       ORDER BY ta.started_at DESC
       LIMIT 1000`, params);

    const shifts = rows.map((row) => ({
      ...row,
      open: row.ended_at === null,
      // **الطول هو العلامة، مش كون الوردية مفتوحة.** وردية مفتوحة من نص ساعة معناها
      // إن الموظف شغّال دلوقتي — تعليمها "مشكوك فيها" كان بيوصّم كل اللي على رأس
      // شغله. اللي مريب هو الوردية اللي عدّت ١٢ ساعة، مقفولة كانت أو مفتوحة
      suspect: row.minutes > LONG_SHIFT_HOURS * 60,
    }));

    const byUser = new Map();
    for (const shift of shifts) {
      if (!byUser.has(shift.user_id)) {
        byUser.set(shift.user_id, {
          user_id: shift.user_id, name: shift.name, team: shift.team,
          shifts: 0, minutes: 0, suspect: 0, open: 0, longest: 0,
        });
      }
      const row = byUser.get(shift.user_id);
      row.shifts += 1;
      row.minutes += shift.minutes;
      if (shift.suspect) row.suspect += 1;
      if (shift.open) row.open += 1;
      if (shift.minutes > row.longest) row.longest = shift.minutes;
    }

    res.json({
      is_admin: isAdmin,
      from, to,
      long_shift_hours: LONG_SHIFT_HOURS,
      per_user: [...byUser.values()].sort((a, b) => b.minutes - a.minutes),
      shifts,
    });
  } catch (error) {
    console.error('❌ Failed to load the attendance history:', error.message);
    res.status(500).json({ error: 'تعذر تحميل سجل الحضور' });
  }
}

// مين حاضر دلوقتي من كل تيم — بيتعرض لموظف المتابعة عشان يعرف قبل ما يدوس التحويل
async function listOnDuty(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.team, ta.started_at,
        (SELECT COUNT(*)::int FROM tickets t WHERE t.transfer_agent_id = u.id) AS holding
       FROM users u
       JOIN team_attendance ta ON ta.user_id = u.id AND ta.ended_at IS NULL
       WHERE u.is_active = TRUE AND u.team IS NOT NULL
       ORDER BY u.team, ta.started_at`
    );
    res.json({ on_duty: rows });
  } catch (error) {
    console.error('❌ Failed to list on-duty team agents:', error.message);
    res.status(500).json({ error: 'تعذر تحميل قائمة الحاضرين' });
  }
}

async function messageStudent(chatId, text) {
  const bot = botManager.getBot();
  if (!bot || !chatId || !text) return false;
  try {
    await bot.telegram.sendMessage(chatId, text);
    return true;
  } catch (error) {
    console.error('❌ Failed to message the student about a team transfer:', error.message);
    return false;
  }
}

// ---------- التحويل: المنطق مفصول عن الـ HTTP ----------
//
// **ليه مفصول:** التحويل بقى ليه مصدرين — موظف المتابعة بيدوس زرار في اللوحة، والطالب نفسه
// بيطلبه من البوت. المنطق واحد (قفل التذكرة، اختيار موظف حاضر، رسالة الغياب، الإشعار)،
// واللي بيختلف هو **مين مسموح له يحوّل تذكرة ماسكها تيم تاني** — وده الفرق الوحيد اللي
// اتحط في transferGuard.
//
// بترجّع كائن نتيجة مش بترد على الطلب، عشان اللي بينده هو اللي يقرر يعملها HTTP ولا رسالة بوت.

// **مين يقدر يحوّل تذكرة موجودة مع تيم بالفعل؟**
//   الموظف: بس لو هو نفسه الماسك وتيمه فيه canHandOff (الواتساب) — التذكرة جتله بقاعدة
//     تلقائية مش باختيار حد، فمحتاج مخرج.
//   الطالب: يقدر ينط بين العلمي والفني بس. **ممنوع يسحبها من موظف الواتساب** — دي محادثة
//     إقناع مع طالب مش مشترك، وسحبها في نصّها معناه إن اللي بيكلّمه يتغيّر فجأة.
//     **استثناء واحد: الدعم الفني.** الطالب اللي بيتكلم مع موظف الإقناع لسه ممكن المنصة
//     تقع عنده، ومنعه معناه إن العطل مالوش طريق خالص — وغير المشترك دي الجهة الوحيدة
//     المفتوحة له أصلًا. ولما يخلص، الإرجاع بيرجّعه للمتابعة والتوجيه التلقائي بيرجّعه
//     لموظف الواتساب خلال ٥ دقايق لوحده.
function transferGuard({ by, actorUserId, holderTeam, holderAgentId, targetTeam }) {
  if (holderTeam.key === targetTeam.key) return 'التذكرة مع نفس التيم بالفعل';
  if (by === 'student') {
    if (holderTeam.key !== 'whatsapp') return null;
    return targetTeam.key === 'tech' ? null : 'التذكرة مع موظف واتساب';
  }
  const isHolder = Number(holderAgentId) === Number(actorUserId);
  return (isHolder && holderTeam.canHandOff) ? null : 'التذكرة محوّلة لتيم بالفعل';
}

async function performTransfer({ ticketId, teamKey, by, actorUserId = null }) {
  const team = getTeam(teamKey);
  if (!team) return { ok: false, status: 400, error: 'التيم غير معروف' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticketResult = await client.query(
      `SELECT t.id, t.transfer_agent_id, t.transfer_team, c.chat_id FROM tickets t
       JOIN contacts c ON c.id = t.contact_id WHERE t.id = $1 FOR UPDATE`,
      [ticketId]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket) {
      await client.query('ROLLBACK');
      return { ok: false, status: 404, error: 'التذكرة غير موجودة' };
    }

    if (ticket.transfer_agent_id) {
      const blocked = transferGuard({
        by,
        actorUserId,
        holderTeam: getTeam(ticket.transfer_team) || { key: ticket.transfer_team },
        holderAgentId: ticket.transfer_agent_id,
        targetTeam: team,
      });
      if (blocked) {
        await client.query('ROLLBACK');
        return { ok: false, status: 409, error: blocked };
      }
    }

    const agentId = await getNextTeamAgent(client, team.key);
    if (!agentId) {
      // مفيش حد حاضر: الطالب بياخد رسالة تقوله يبعت في المواعيد، والتحويل مابيحصلش.
      // متعمّد إن مفيش طابور مخفي — سؤال واقف محدش شايفه أسوأ من رد صريح للطالب
      await client.query('ROLLBACK');
      const setting = await pool.query('SELECT value FROM settings WHERE key = $1', [team.offlineSettingKey]);
      const delivered = await messageStudent(ticket.chat_id, setting.rows[0]?.value);
      return {
        ok: false, status: 409, offline: true, team,
        error: `مفيش حد من ${team.label} مسجّل حضور دلوقتي`,
        student_notified: delivered,
      };
    }

    await client.query(
      `UPDATE tickets SET transfer_agent_id = $2, transfer_team = $3, transfer_since = NOW(),
        updated_at = NOW() WHERE id = $1`,
      [ticketId, agentId, team.key]
    );
    await client.query('COMMIT');

    const agent = await pool.query('SELECT name FROM users WHERE id = $1', [agentId]);
    push.sendToUser(agentId, {
      title: `تذكرة محوّلة لك — ${team.label}`,
      body: by === 'student' ? 'الطالب طلب التحويل بنفسه' : 'تذكرة اتحوّلت لك من فريق المتابعة',
      tag: `ticket-${ticketId}`,
      url: `/?ticket=${ticketId}`,
    }).catch((err) => console.error('❌ Failed to notify the team agent:', err.message));

    return { ok: true, team, agent_id: agentId, agent_name: agent.rows[0]?.name || null };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to transfer the ticket to a team:', error.message);
    return { ok: false, status: 500, error: 'تعذر التحويل' };
  } finally {
    client.release();
  }
}

// التحويل من اللوحة — موظف المتابعة بيدوسه لما السؤال يبقى بره اختصاصه
async function transferToTeam(req, res) {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });

  const result = await performTransfer({
    ticketId, teamKey: req.params.team, by: 'staff', actorUserId: req.session.userId,
  });
  if (!result.ok) {
    const body = { error: result.error };
    if (result.student_notified !== undefined) body.student_notified = result.student_notified;
    return res.status(result.status).json(body);
  }
  res.json({
    ok: true, team: result.team.key, agent_id: result.agent_id, agent_name: result.agent_name,
  });
}

// ---------- الإرجاع لتيم المتابعة: المنطق مفصول عن الـ HTTP ----------
//
// زي التحويل بالظبط بقى ليه مصدرين: الموظف المتخصص بيدوس زرار الإرجاع في اللوحة، والطالب
// بيضغط «تيم المتابعة» في قايمة البوت.
//
// **الفرق الوحيد إن إرجاع الطالب بيبلّغ الموظف الماسك.** لما الموظف بيرجّعها بنفسه هو عارف،
// إنما لو الطالب رجع للمتابعة وهو في نص الكلام مع المتخصص، التذكرة بتختفي من قايمة المتخصص
// من غير ما يعرف ليه — فبياخد إشعار.
//
// الـ CTE بيقرا الماسك القديم قبل ما الأعمدة تتصفّر: `RETURNING` لوحدها بترجّع القيم الجديدة
// (يعني NULL)، فما كانش فيه طريقة نعرف بيها نبلّغ مين
async function performReturn({ ticketId, by }) {
  const result = await pool.query(
    `WITH previous AS (
       SELECT id, transfer_agent_id, transfer_team FROM tickets
       WHERE id = $1 AND transfer_agent_id IS NOT NULL
     )
     UPDATE tickets t SET transfer_agent_id = NULL, transfer_team = NULL, transfer_since = NULL,
       updated_at = NOW()
     FROM previous p WHERE t.id = p.id
     RETURNING p.transfer_agent_id AS previous_agent_id, p.transfer_team AS previous_team`,
    [ticketId]
  );
  const row = result.rows[0];
  if (!row) return { ok: false, status: 409, error: 'التذكرة مش محوّلة لأي تيم' };

  if (by === 'student' && row.previous_agent_id) {
    const team = getTeam(row.previous_team);
    push.sendToUser(row.previous_agent_id, {
      title: 'الطالب رجع لفريق المتابعة',
      body: `تذكرة كانت معاك${team ? ` في ${team.label}` : ''} رجعت للمتابعة بطلب الطالب`,
      tag: `ticket-${ticketId}`,
      url: `/?ticket=${ticketId}`,
    }).catch((err) => console.error('❌ Failed to notify the team agent about a student return:', err.message));
  }

  return { ok: true, previous_team: row.previous_team, previous_agent_id: row.previous_agent_id };
}

// الإرجاع من اللوحة — الموظف المتخصص بيدوسه لما يخلّص، وموظف المتابعة يقدر يسحبها برضه
async function returnFromTeam(req, res) {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });
  try {
    const result = await performReturn({ ticketId, by: 'staff' });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to return the ticket from a team:', error.message);
    res.status(500).json({ error: 'تعذر إرجاع التذكرة' });
  }
}

module.exports = {
  getAttendanceStatus, checkIn, checkOut, listOnDuty, listAttendanceHistory,
  transferToTeam, returnFromTeam, performTransfer, performReturn,
};
