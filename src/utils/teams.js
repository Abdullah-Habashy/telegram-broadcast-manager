// ---------- التيمات المتخصصة اللي بتتحوّل لها التذاكر ----------
//
// موظف المتابعة بيفضل صاحب التذكرة دايمًا وشايف كل الرسايل؛ التحويل بيزوّد موظف من تيم متخصص
// جنبه مؤقتًا. الطالب مش بيحس بأي حاجة — نفس البوت ونفس تسلسل الرسايل.
//
// كل حاجة عن التيم في الصف بتاعه هنا: اللون، الأيقونة، الاسم، ومفتاح رسالة "بره المواعيد".
// إضافة تيم رابع = صف زيادة هنا + قاعدة CSS واحدة، من غير عمود جديد ولا مسار ولا هجرة.
const TEAMS = {
  science: {
    key: 'science',
    label: 'التيم العلمي',
    icon: '🧪',
    // بيتحط كـ class على كارت التذكرة: ticket-list-item.transfer-science
    tone: 'science',
    offlineSettingKey: 'science_offline_message',
    transferTitle: 'تحويل السؤال للتيم العلمي',
  },
  tech: {
    key: 'tech',
    label: 'الدعم الفني',
    icon: '🛠️',
    tone: 'tech',
    offlineSettingKey: 'tech_offline_message',
    transferTitle: 'تحويل المشكلة للدعم الفني',
  },
};

const TEAM_KEYS = Object.keys(TEAMS);

function isTeamKey(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEAMS, value);
}

function getTeam(value) {
  return isTeamKey(value) ? TEAMS[value] : null;
}

module.exports = { TEAMS, TEAM_KEYS, isTeamKey, getTeam };
