// بتقارن الوقت الحالي (بتوقيت القاهرة) بمواعيد العمل — بتدعم نطاق بيعدي منتصف الليل كمان (مثلاً 22:00 لحد 06:00)
function isWithinWorkingHours(start, end, now) {
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end;
}

function currentCairoTime() {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

module.exports = { isWithinWorkingHours, currentCairoTime };
