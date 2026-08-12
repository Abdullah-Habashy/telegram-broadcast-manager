// إرسال إشعارات المتصفح (Web Push) للموظفين — بتوصل للتليفون حتى لو المتصفح مقفول
const webpush = require('web-push');
const env = require('../config/env');
const pool = require('../config/db');

const enabled = Boolean(env.vapidPublicKey && env.vapidPrivateKey);

if (enabled) {
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
} else {
  console.warn('⚠️ VAPID keys غير مضبوطة — إشعارات المتصفح (Web Push) معطّلة.');
}

// بيبعت إشعار لكل اشتراكات مستخدم معيّن، وبيشيل أي اشتراك بقى منتهي/باطل من الداتابيز
async function sendToUser(userId, payload) {
  if (!enabled || !userId) return;
  const { rows } = await pool.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  await Promise.all(rows.map((row) => sendToSubscription(row, payload)));
}

async function sendToUsers(userIds, payload) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  await Promise.all(uniqueIds.map((userId) => sendToUser(userId, payload)));
}

async function sendToSubscription(row, payload) {
  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (error) {
    // 404/410 تعني إن المتصفح ألغى الاشتراك (مثلاً بعد مسح بيانات الموقع)
    if (error.statusCode === 404 || error.statusCode === 410) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
    } else {
      console.error('❌ Failed to send push notification:', error.message);
    }
  }
}

module.exports = { enabled, sendToUser, sendToUsers };
