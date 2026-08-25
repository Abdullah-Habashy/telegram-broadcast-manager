const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- تجهيز الرسايل الصوتية اللي الموظف بيبعتها للطالب ----------
//
// تليجرام بيقبل في sendVoice تلات صيغ بس: OGG بترميز Opus، أو MP3، أو M4A. والمتصفحات
// بتسجّل حاجات مختلفة: فايرفوكس بيطلّع ogg/opus جاهزة، سفاري بيطلّع mp4، وكروم وإيدچ
// بيطلّعوا webm/opus — ودي تليجرام بترفضها رغم إن الصوت جوّاها Opus بالفعل.
//
// فالحل إننا **نغيّر الحاوية بس من غير ما نلمس الصوت**: `-c:a copy` بينقل فريمات الـ Opus
// زي ما هي من webm لـ ogg. مفيش إعادة ترميز، يعني مفيش فقد جودة والعملية بتاخد أقل من
// عُشر ثانية. الصيغ اللي تليجرام بيقبلها أصلًا بتعدّي من غير أي تحويل.
const ACCEPTED_DIRECTLY = new Set(['.ogg', '.oga', '.mp3', '.m4a']);

// حد أقصى للتسجيل. تليجرام بيسمح بـ 50 ميجا للملف، لكن رسالة صوتية أطول من كده في شات
// دعم معناها غالبًا إن حد نسي يقفل التسجيل
const MAX_BYTES = 20 * 1024 * 1024;

function hasFfmpeg() {
  return fs.existsSync('/usr/bin/ffmpeg') || fs.existsSync('/usr/local/bin/ffmpeg');
}

function remuxToOgg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-c:a', 'copy', '-f', 'ogg', '-y', outputPath],
      { timeout: 30000 },
      (error, _stdout, stderr) => {
        if (error) return reject(new Error(stderr?.trim() || error.message));
        resolve(outputPath);
      }
    );
  });
}

// بترجّع مسار ملف جاهز لـ sendVoice، وبتشيل الملف الأصلي لو اتعمله تحويل.
// بترمي خطأ بالعربي لو الصيغة محتاجة تحويل وffmpeg مش متاح — أوضح من فشل صامت عند تليجرام
async function prepareVoiceForTelegram(uploadedPath) {
  const extension = path.extname(uploadedPath).toLowerCase();
  if (ACCEPTED_DIRECTLY.has(extension)) return uploadedPath;

  if (!hasFfmpeg()) {
    throw new Error('متصفحك بيسجّل بصيغة محتاجة تحويل، والتحويل مش متاح على السيرفر دلوقتي');
  }
  const outputPath = path.join(path.dirname(uploadedPath), `${crypto.randomUUID()}.ogg`);
  try {
    await remuxToOgg(uploadedPath, outputPath);
  } catch (error) {
    fs.unlink(outputPath, () => {});
    throw new Error(`تعذر تجهيز التسجيل الصوتي: ${error.message}`);
  }
  fs.unlink(uploadedPath, () => {});
  return outputPath;
}

module.exports = { prepareVoiceForTelegram, hasFfmpeg, ACCEPTED_DIRECTLY, MAX_BYTES };
