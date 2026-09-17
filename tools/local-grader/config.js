// ---------- إعدادات أداة التصحيح المحلي ----------
//
// **مفيش أي بيانات سيرفر في الملف ده.** الريبو عام، فالمضيف والمفتاح بيتقروا من `.env`
// المحلي (متجاهَل في git) أو من متغيّرات البيئة. الأداة بترمي خطأ واضح لو ناقصين بدل
// ما تفشل جوه نداء ssh برسالة مالهاش معنى.

require('dotenv').config();
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SSH_HOST = process.env.GRADER_SSH_HOST || '';
const SSH_KEY = process.env.GRADER_SSH_KEY || '';
const REMOTE_APP = process.env.GRADER_REMOTE_APP || '/root/app';
const REMOTE_DB = process.env.GRADER_REMOTE_DB || 'telegram_broadcast_manager';

// **مساحة الشغل بره المستودع عن قصد، لسببين:**
// ١) جوّاها صور إجابات طلبة حقيقيين — بيانات خاصة مالهاش مكان في ريبو عام، وأي `git add -A`
//    من جلسة تانية كان ممكن يدخّلها.
// ٢) `claude -p` بيدوّر على CLAUDE.md من مجلد التشغيل وطالع — لو الشغل جوه المشروع كان
//    هيحمّل تعليمات المشروع كلها مع كل نداء تصحيح، توكنز مدفوعة في حاجة مالهاش لازمة.
const WORK_DIR = process.env.GRADER_WORK_DIR || path.join(os.homedir(), '.quiz-local-grader');

function sshArgs(extra = []) {
  if (!SSH_HOST) {
    throw new Error('ناقص GRADER_SSH_HOST في .env — الشكل: root@<ip>. شوف tools/local-grader/README.md');
  }
  return (SSH_KEY ? ['-i', SSH_KEY] : []).concat(extra);
}

// بينفّذ أمر على السيرفر وبيرجّع stdout. **بيرمي لو رجع كود غير صفر** — الأداة بتاعة
// بيانات درجات، وتكميل الشغل على مخرج ناقص أسوأ بكتير من إنها تقف
function ssh(command, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  const result = spawnSync('ssh', sshArgs([SSH_HOST, command]), { encoding: 'utf8', maxBuffer });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ssh رجع ${result.status}: ${(result.stderr || '').trim().slice(0, 500)}`);
  }
  return result.stdout;
}

// psql بمخرج خام من غير ترويسة ولا محاذاة — الاستعلامات هنا كلها بترجّع JSON في خانة واحدة.
// `-q` مهم: من غيره psql بيطبع وسم كل أمر (`BEGIN`, `UPDATE 8`, `ROLLBACK`) على stdout
// جنب نتيجة الاستعلام، والسطر الأخير بيبقى `ROLLBACK` مش الـJSON اللي إحنا عايزينه
// **الاستعلام بيتبعت على stdin مش كوسيطة.** كان بيتحوّل base64 وينحط جوه أمر ssh،
// وده بيقع بـENAMETOOLONG أول ما الاستعلام يكبر — استيراد ٢٢ ورقة × ٤٥ إجابة بنصوصها
// طلّع أمر أطول من الحد المسموح للسطر. stdin مالهوش حد زي ده.
function psql(sql, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  const remote = `sudo -u postgres psql -d ${REMOTE_DB} -Atq -v ON_ERROR_STOP=1 -f -`;
  const result = spawnSync('ssh', sshArgs([SSH_HOST, remote]), {
    input: sql, encoding: 'utf8', maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`psql رجع ${result.status}: ${(result.stderr || '').trim().slice(0, 800)}`);
  }
  return result.stdout;
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// **الـJSON بيجي على أكتر من سطر.** `json_agg` بيحط سطر جديد بين كل عنصر، فأي منطق
// بيدوّر على "السطر اللي فيه الـJSON" بيرجّع null على استعلام فيه أكتر من صف — وده
// بيبان كأن الاستعلام مالقاش حاجة، مش كأنه فشل.
//
// وفي نفس الوقت مخرج المعاملات (`push.js`) بينتهي بوسم زي `ROLLBACK` بعد الـJSON.
// فالترتيب: جرّب المخرج كله، وبعدين لمّ من أول سطر بيبدأ بقوس لآخر سطر بيقفل قوس.
function psqlJson(sql) {
  const raw = psql(sql).trim();
  if (!raw || raw === '\\N') return null;

  const whole = tryParse(raw);
  if (whole !== undefined) return whole;

  const lines = raw.split('\n');
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  if (start === -1) return null;
  for (let end = lines.length - 1; end >= start; end -= 1) {
    if (!/[\]}]\s*$/.test(lines[end])) continue;
    const parsed = tryParse(lines.slice(start, end + 1).join('\n'));
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function quizWorkDir(quizId) {
  return path.join(WORK_DIR, `quiz-${quizId}`);
}

module.exports = { SSH_HOST, SSH_KEY, REMOTE_APP, REMOTE_DB, WORK_DIR, sshArgs, ssh, psql, psqlJson, quizWorkDir };
