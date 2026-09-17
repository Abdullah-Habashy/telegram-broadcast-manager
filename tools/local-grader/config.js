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
function psql(sql) {
  const encoded = Buffer.from(sql, 'utf8').toString('base64');
  return ssh(`echo ${encoded} | base64 -d | sudo -u postgres psql -d ${REMOTE_DB} -Atq -v ON_ERROR_STOP=1 -f -`);
}

// بيدوّر على سطر JSON مش بياخد آخر سطر — حتى مع `-q` فيه أوامر بتطبع حاجة (NOTICE مثلًا)،
// والاعتماد على الموضع بيكسر السكربت في يوم من غير سبب ظاهر
function psqlJson(sql) {
  const lines = psql(sql).split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { return JSON.parse(line); } catch { /* مش ده السطر */ }
  }
  return null;
}

function quizWorkDir(quizId) {
  return path.join(WORK_DIR, `quiz-${quizId}`);
}

module.exports = { SSH_HOST, SSH_KEY, REMOTE_APP, REMOTE_DB, WORK_DIR, sshArgs, ssh, psql, psqlJson, quizWorkDir };
