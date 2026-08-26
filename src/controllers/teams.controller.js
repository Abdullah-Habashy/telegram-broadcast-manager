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

// الانصراف بيرجّع كل التذاكر اللي في إيده لموظفي المتابعة — تذكرة محوّلة لموظف مشي معناها
// سؤال طالب واقف عند حد مش موجود، وده بالظبط اللي المفروض الميزة تمنعه
async function checkOut(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const returned = await client.query(
      `UPDATE tickets SET transfer_agent_id = NULL, transfer_team = NULL, transfer_since = NULL,
        updated_at = NOW()
       WHERE transfer_agent_id = $1 RETURNING id`,
      [req.session.userId]
    );
    await client.query(
      'UPDATE team_attendance SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL',
      [req.session.userId]
    );
    await client.query('COMMIT');
    res.json({ present: false, returned: returned.rowCount });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to check out of the team shift:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل الانصراف' });
  } finally {
    client.release();
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

// التحويل لتيم متخصص — موظف المتابعة بيدوسه لما السؤال يبقى بره اختصاصه
async function transferToTeam(req, res) {
  const ticketId = Number(req.params.id);
  const team = getTeam(req.params.team);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });
  if (!team) return res.status(400).json({ error: 'التيم غير معروف' });

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
      return res.status(404).json({ error: 'التذكرة غير موجودة' });
    }
    if (ticket.transfer_agent_id) {
      // التذكرة مع تيم بالفعل. الاستثناء الوحيد: الموظف الماسكها بنفسه بيسلّمها لتيم تاني،
      // ولتيمه خاصية canHandOff (الواتساب). من غير ده التسليم كان لازم يعدّي على المتابعة —
      // خطوة زيادة وسط محادثة الطالب، وموظف المتابعة مش شايف السؤال أصلًا عشان يوجّهه
      const holderTeam = getTeam(ticket.transfer_team);
      const isHolder = Number(ticket.transfer_agent_id) === Number(req.session.userId);
      if (!isHolder || !holderTeam?.canHandOff || holderTeam.key === team.key) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'التذكرة محوّلة لتيم بالفعل' });
      }
    }

    const agentId = await getNextTeamAgent(client, team.key);
    if (!agentId) {
      // مفيش حد حاضر: الطالب بياخد رسالة تقوله يبعت في المواعيد، والتحويل مابيحصلش.
      // متعمّد إن مفيش طابور مخفي — سؤال واقف محدش شايفه أسوأ من رد صريح للطالب
      await client.query('ROLLBACK');
      const setting = await pool.query('SELECT value FROM settings WHERE key = $1', [team.offlineSettingKey]);
      const delivered = await messageStudent(ticket.chat_id, setting.rows[0]?.value);
      return res.status(409).json({
        error: `مفيش حد من ${team.label} مسجّل حضور دلوقتي`,
        student_notified: delivered,
      });
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
      body: 'تذكرة اتحوّلت لك من فريق المتابعة',
      tag: `ticket-${ticketId}`,
      url: `/?ticket=${ticketId}`,
    }).catch((err) => console.error('❌ Failed to notify the team agent:', err.message));

    res.json({ ok: true, team: team.key, agent_id: agentId, agent_name: agent.rows[0]?.name || null });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to transfer the ticket to a team:', error.message);
    res.status(500).json({ error: 'تعذر التحويل' });
  } finally {
    client.release();
  }
}

// الإرجاع — الموظف المتخصص بيدوسه لما يخلّص، وموظف المتابعة يقدر يسحبها برضه
async function returnFromTeam(req, res) {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });
  try {
    const result = await pool.query(
      `UPDATE tickets SET transfer_agent_id = NULL, transfer_team = NULL, transfer_since = NULL,
        updated_at = NOW()
       WHERE id = $1 AND transfer_agent_id IS NOT NULL RETURNING id`,
      [ticketId]
    );
    if (!result.rows[0]) return res.status(409).json({ error: 'التذكرة مش محوّلة لأي تيم' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to return the ticket from a team:', error.message);
    res.status(500).json({ error: 'تعذر إرجاع التذكرة' });
  }
}

module.exports = {
  getAttendanceStatus, checkIn, checkOut, listOnDuty,
  transferToTeam, returnFromTeam,
};
