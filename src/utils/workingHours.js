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

// "09:00" -> "٩:٠٠ صباحًا" — بصيغة عربية مقروءة عشان تتحط في رسالة للطالب مش في واجهة إدارية
function formatArabicTime(hhmm) {
  const [rawHour, rawMinute] = String(hhmm || '').split(':');
  const hour24 = Number(rawHour);
  if (!Number.isInteger(hour24)) return hhmm || '';
  const minute = String(rawMinute ?? '00').padStart(2, '0');
  // الساعة ١٢ هي الوحيدة اللي "صباحًا/مساءً" مابتفرّقش فيها: منتصف الليل والظهر الاتنين
  // بيتكتبوا 12:00. الطالب اللي يقرا "من ١٠ صباحًا لـ ١٢ صباحًا" مش هيفهم ده يوم كامل
  if (hour24 === 0 && minute === '00') return '١٢ بالليل';
  if (hour24 === 12 && minute === '00') return '١٢ الظهر';
  const period = hour24 < 12 ? 'صباحًا' : 'مساءً';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${period}`;
}

// وقت أول فتح جاي لمواعيد العمل، بصيغة جاهزة للرسالة: "النهارده الساعة ٩:٠٠ صباحًا" أو "بكرة ...".
// القاعدة: لو الوقت الحالي قبل ساعة البداية يبقى الفتح النهارده، وإلا بكرة. وده صحيح كمان لو
// مواعيد العمل بتعدّي منتصف الليل (مثلاً 22:00 لحد 06:00) — بيتعامل معاها بنفس المقارنة
function nextWorkingWindowPhrase(start, now) {
  const startTime = start || '09:00';
  const day = String(now || '') < startTime ? 'النهارده' : 'بكرة';
  return `${day} الساعة ${formatArabicTime(startTime)}`;
}

module.exports = { isWithinWorkingHours, currentCairoTime, formatArabicTime, nextWorkingWindowPhrase };
