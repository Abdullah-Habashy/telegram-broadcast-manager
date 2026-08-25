const pool = require('../config/db');
const botManager = require('../bot/botManager');
const push = require('../utils/push');
const { getNextScienceAgent } = require('../utils/ticketAssignment');

// ---------- التيم العلمي: الحضور والتحويل ----------
//
// التذكرة مابتنتقلش ملكيتها. assigned_to بيفضل موظف المتابعة طول الوقت وهو شايف كل الرسايل
// وعنده زرار التحويل دايمًا؛ science_agent_id بيزوّد موظف علمي مؤقتًا جنبه. الطالب مش بيحس
// بأي حاجة — نفس البوت ونفس تسلسل الرسايل، ومحدش بيقوله "تم تحويلك".

// حالة حضور الموظف الحالي + كام تذكرة في إيده
async function getAttendanceStatus(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT started_at FROM science_attendance
       WHERE user_id = $1 AND ended_at IS NULL LIMIT 1`,
      [req.session.userId]
    );
    const holding = await pool.query(
      'SELECT COUNT(*)::int AS count FROM tickets WHERE science_agent_id = $1',
      [req.session.userId]
    );
    res.json({
      present: Boolean(rows[0]),
      started_at: rows[0]?.started_at || null,
      holding: holding.rows[0].count,
    });
  } catch (error) {
    console.error('❌ Failed to read science attendance:', error.message);
    res.status(500).json({ error: 'تعذر قراءة حالة الحضور' });
  }
}

async function checkIn(req, res) {
  try {
    // ON CONFLICT على الفهرس الجزئي الفريد: الضغط مرتين بسرعة أو من تبويبين مايعملش وردية تانية
    await pool.query(
      `INSERT INTO science_attendance (user_id) VALUES ($1)
       ON CONFLICT (user_id) WHERE ended_at IS NULL DO NOTHING`,
      [req.session.userId]
    );
    const { rows } = await pool.query(
      'SELECT started_at FROM science_attendance WHERE user_id = $1 AND ended_at IS NULL LIMIT 1',
      [req.session.userId]
    );
    res.json({ present: true, started_at: rows[0]?.started_at || null });
  } catch (error) {
    console.error('❌ Failed to check in to the science shift:', error.message);
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
      `UPDATE tickets SET science_agent_id = NULL, science_since = NULL, updated_at = NOW()
       WHERE science_agent_id = $1 RETURNING id`,
      [req.session.userId]
    );
    await client.query(
      'UPDATE science_attendance SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL',
      [req.session.userId]
    );
    await client.query('COMMIT');
    res.json({ present: false, returned: returned.rowCount });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to check out of the science shift:', error.message);
    res.status(500).json({ error: 'تعذر تسجيل الانصراف' });
  } finally {
    client.release();
  }
}

// مين حاضر دلوقتي — بيتعرض لموظف المتابعة عشان يعرف قبل ما يدوس التحويل
async function listOnDuty(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, sa.started_at,
        (SELECT COUNT(*)::int FROM tickets t WHERE t.science_agent_id = u.id) AS holding
       FROM users u
       JOIN science_attendance sa ON sa.user_id = u.id AND sa.ended_at IS NULL
       WHERE u.is_active = TRUE AND u.is_science_team = TRUE
       ORDER BY sa.started_at`
    );
    res.json({ on_duty: rows });
  } catch (error) {
    console.error('❌ Failed to list on-duty science agents:', error.message);
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
    console.error('❌ Failed to message the student about the science team:', error.message);
    return false;
  }
}

// التحويل للتيم العلمي — موظف المتابعة بيدوسه لما الطالب يسأل سؤال علمي
async function transferToScience(req, res) {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticketResult = await client.query(
      `SELECT t.id, t.science_agent_id, c.chat_id FROM tickets t
       JOIN contacts c ON c.id = t.contact_id WHERE t.id = $1 FOR UPDATE`,
      [ticketId]
    );
    const ticket = ticketResult.rows[0];
    if (!ticket) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'التذكرة غير موجودة' });
    }
    if (ticket.science_agent_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'التذكرة محوّلة للتيم العلمي بالفعل' });
    }

    const agentId = await getNextScienceAgent(client);
    if (!agentId) {
      // مفيش حد حاضر: الطالب بياخد رسالة تقوله يبعت في المواعيد، والتحويل مابيحصلش.
      // متعمّد إن مفيش طابور مخفي — سؤال واقف محدش شايفه أسوأ من رد صريح للطالب
      await client.query('ROLLBACK');
      const setting = await pool.query(
        "SELECT value FROM settings WHERE key = 'science_offline_message'"
      );
      const delivered = await messageStudent(ticket.chat_id, setting.rows[0]?.value);
      return res.status(409).json({
        error: 'مفيش حد من التيم العلمي مسجّل حضور دلوقتي',
        student_notified: delivered,
      });
    }

    await client.query(
      `UPDATE tickets SET science_agent_id = $2, science_since = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [ticketId, agentId]
    );
    await client.query('COMMIT');

    const agent = await pool.query('SELECT name FROM users WHERE id = $1', [agentId]);
    push.sendToUser(agentId, {
      title: 'سؤال علمي محوّل لك',
      body: 'تذكرة اتحوّلت لك من فريق المتابعة',
      tag: `ticket-${ticketId}`,
      url: `/?ticket=${ticketId}`,
    }).catch((err) => console.error('❌ Failed to notify the science agent:', err.message));

    res.json({ ok: true, science_agent_id: agentId, science_agent_name: agent.rows[0]?.name || null });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to transfer the ticket to the science team:', error.message);
    res.status(500).json({ error: 'تعذر التحويل للتيم العلمي' });
  } finally {
    client.release();
  }
}

// الإرجاع — الموظف العلمي بيدوسه لما يخلّص، وموظف المتابعة يقدر يسحبها برضه
async function returnFromScience(req, res) {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return res.status(400).json({ error: 'التذكرة غير صالحة' });
  try {
    const result = await pool.query(
      `UPDATE tickets SET science_agent_id = NULL, science_since = NULL, updated_at = NOW()
       WHERE id = $1 AND science_agent_id IS NOT NULL RETURNING id`,
      [ticketId]
    );
    if (!result.rows[0]) return res.status(409).json({ error: 'التذكرة مش محوّلة للتيم العلمي' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to return the ticket from the science team:', error.message);
    res.status(500).json({ error: 'تعذر إرجاع التذكرة' });
  }
}

module.exports = {
  getAttendanceStatus, checkIn, checkOut, listOnDuty,
  transferToScience, returnFromScience,
};
