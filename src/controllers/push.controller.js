const pool = require('../config/db');
const env = require('../config/env');
const push = require('../utils/push');

function getPublicKey(req, res) {
  res.json({ enabled: push.enabled, publicKey: env.vapidPublicKey });
}

async function subscribe(req, res) {
  const { endpoint, keys } = req.body.subscription || req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'بيانات الاشتراك غير مكتملة' });
  }

  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent`,
      [req.session.userId, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to save push subscription:', error.message);
    res.status(500).json({ error: 'حصل خطأ في تفعيل الإشعارات' });
  }
}

async function unsubscribe(req, res) {
  const endpoint = req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'الرابط المطلوب حذفه غير موجود' });

  try {
    await pool.query(
      'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
      [endpoint, req.session.userId]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to remove push subscription:', error.message);
    res.status(500).json({ error: 'حصل خطأ في إلغاء الإشعارات' });
  }
}

module.exports = { getPublicKey, subscribe, unsubscribe };
