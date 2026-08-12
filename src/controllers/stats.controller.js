const pool = require('../config/db');

// إحصائيات أساسية — response_rate هنا تقريب بسيط (رسائل واردة ÷ رسائل مُرسلة)
// مش معدل رد دقيق لكل broadcast على حدة، ده نقطة بداية يمكن تطويرها لاحقًا
async function getStats(req, res) {
  try {
    const [totalContacts, activeLastWeek, totalSent, totalIncoming] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM contacts c
        WHERE c.source <> 'tafra' OR c.last_contacted_at IS NOT NULL`),
      pool.query(`SELECT COUNT(*)::int AS count FROM contacts c
        WHERE (c.source <> 'tafra' OR c.last_contacted_at IS NOT NULL)
          AND last_contacted_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM broadcast_recipients WHERE status = 'sent'`),
      pool.query('SELECT COUNT(*)::int AS count FROM incoming_messages'),
    ]);

    const sentCount = totalSent.rows[0].count;
    const incomingCount = totalIncoming.rows[0].count;

    res.json({
      total_contacts: totalContacts.rows[0].count,
      active_last_week: activeLastWeek.rows[0].count,
      total_messages_sent: sentCount,
      total_incoming_messages: incomingCount,
      response_rate: sentCount > 0 ? +((incomingCount / sentCount) * 100).toFixed(1) : 0,
    });
  } catch (err) {
    console.error('❌ Failed to load statistics:', err.message);
    res.status(500).json({ error: 'حصل خطأ في جلب الإحصائيات' });
  }
}

module.exports = { getStats };
