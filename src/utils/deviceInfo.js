// تحليل بسيط لسلسلة User-Agent لاستخراج نوع الجهاز/النظام/المتصفح — تقريبي وكافٍ للعرض في
// لوحة التحكم (مين داخل من موبايل/كمبيوتر)، مش تحليل دقيق شامل لكل الحالات النادرة
function detectOs(ua) {
  if (/windows/i.test(ua)) return 'ويندوز';
  if (/iphone/i.test(ua)) return 'iOS (آيفون)';
  if (/ipad/i.test(ua)) return 'iOS (آيباد)';
  if (/android/i.test(ua)) return 'أندرويد';
  if (/mac os x/i.test(ua)) return 'ماك';
  if (/linux/i.test(ua)) return 'لينكس';
  return 'نظام غير معروف';
}

function detectBrowser(ua) {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/chrome\//i.test(ua)) return 'Chrome';
  if (/firefox\//i.test(ua)) return 'Firefox';
  if (/safari\//i.test(ua)) return 'Safari';
  return 'متصفح غير معروف';
}

function detectDeviceType(ua) {
  if (/ipad/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return 'تابلت';
  if (/mobile|iphone|android/i.test(ua)) return 'موبايل';
  return 'كمبيوتر';
}

function parseDeviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua.trim()) return 'جهاز غير معروف';
  return `${detectDeviceType(ua)} · ${detectOs(ua)} · ${detectBrowser(ua)}`;
}

module.exports = { parseDeviceLabel };
