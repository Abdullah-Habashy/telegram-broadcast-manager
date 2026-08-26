// ---------- التيمات المتخصصة اللي بتتحوّل لها التذاكر ----------
//
// موظف المتابعة بيفضل صاحب التذكرة دايمًا وشايف كل الرسايل؛ التحويل بيزوّد موظف من تيم متخصص
// جنبه مؤقتًا. الطالب مش بيحس بأي حاجة — نفس البوت ونفس تسلسل الرسايل.
//
// كل حاجة عن التيم في الصف بتاعه هنا: اللون، الأيقونة، الاسم، وسلوكه.
//
// التيمات مش كلها بتشتغل بنفس الطريقة، والفروق دي خصايص مش أكواد منفصلة:
//   requiresAttendance — التحويل بيروح للحاضرين بس (العلمي والفني). الواتساب لأ: التوجيه
//     بتاعه تلقائي وقت ما الطالب يدخل البوت، ولو اشترطنا حضور كان الطالب اللي بييجي الساعة
//     تلاتة الفجر ميروحش لحد.
//   idleReturn — بترجع لوحدها بعد نص ساعة سكوت (سؤال علمي أو مشكلة تقنية ليها بداية ونهاية).
//     الواتساب لأ: دي محادثة إقناع ممكن تاخد أيام.
//   autoRoute — بيتحوّل عليها تلقائيًا حسب قاعدة، مش بضغطة موظف.
const TEAMS = {
  science: {
    key: 'science',
    label: 'التيم العلمي',
    icon: '🧪',
    // بيتحط كـ class على كارت التذكرة: ticket-list-item.transfer-science
    tone: 'science',
    offlineSettingKey: 'science_offline_message',
    transferTitle: 'تحويل السؤال للتيم العلمي',
    requiresAttendance: true,
    idleReturn: true,
  },
  tech: {
    key: 'tech',
    label: 'الدعم الفني',
    icon: '🛠️',
    tone: 'tech',
    offlineSettingKey: 'tech_offline_message',
    transferTitle: 'تحويل المشكلة للدعم الفني',
    requiresAttendance: true,
    idleReturn: true,
  },
  whatsapp: {
    key: 'whatsapp',
    label: 'موظف واتساب',
    icon: '💬',
    tone: 'whatsapp',
    transferTitle: 'تحويل الطالب لموظف واتساب',
    // مفيش حضور: الطلاب غير المشتركين بيدخلوا البوت في أي وقت والتوجيه تلقائي
    requiresAttendance: false,
    // مفيش إرجاع بالسكوت: محادثة الإقناع ممكن تفضل أيام من غير رسالة، ورجوعها للمتابعة
    // في النص معناه إن اللي بيكلّم الطالب يتغيّر في نص الكلام
    idleReturn: false,
    // بتتحوّل تلقائيًا للطالب اللي مش مشترك في أي كورس، وبترجع لوحدها أول ما يشترك
    autoRoute: 'unenrolled',
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
