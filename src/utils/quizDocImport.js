// ---------- استيراد أسئلة من ملف Word ----------
//
// **المشكلة:** التيم العلمي بيكتب الأسئلة في Word أصلًا، وبعدين بيقعد ينقلها سؤال سؤال
// في المحرر. الملف موجود، والنقل هو الشغل الضايع.
//
// **الصيغة:** علامات على أول السطر — `س1` للسؤال، `ج1` للإجابة، `د1` للدرجة، `ت1`
// لتعليمات التصحيح (اختيارية). والاختياري بيتكتب زي ما المدرّس بيكتبه أصلًا: أ) ب) ج) د)
// تحت السؤال، و`ج1` بيبقى حرف الإجابة الصح.
//
// **الفرق بين علامة واختيار هو الرقم.** `ج1` علامة (حرف + رقم)، و`ج)` اختيار تالت
// (حرف + فاصل من غير رقم). من غير التفرقة دي كان مستحيل تكتب سؤال اختياري فيه أربع
// اختيارات لأن التالت اسمه "ج" زي علامة الإجابة بالظبط.
//
// **الناتج مابيتكتبش في القاعدة.** بيرجع للمحرر عشان الموظف يراجعه ويحفظ بنفسه —
// ملف فيه غلطة إملائية في علامة بيبوّظ اختبار كامل لو دخل على طول.

// الأرقام العربية والفارسية بتتحوّل لإنجليزي — المدرّس بيكتب من كيبورد عربي فبيطلع ١ مش 1.
// نفس تطبيع quizPublic.controller.js بالحرف
function toAsciiDigits(value) {
  return String(value == null ? '' : value).replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });
}

// المدرّس بيفصل بين العلامة والنص بأي حاجة: قوس، نقطتين، نقطة، شرطة، أو مسافة بس
const SEPARATOR = '[)\\.:\\-–—\\]}]';

// علامة = حرف + رقم + (حرف فرع اختياري). الرقم هو اللي بيميّزها عن الاختيار
const MARKER = new RegExp(`^\\s*([سجدت])\\s*([0-9٠-٩۰-۹]+)\\s*([أ-ي])?\\s*${SEPARATOR}?\\s*(.*)$`);

// اختيار = حرف واحد + فاصل. الفاصل مطلوب عشان "أحمد كان" ماتتقريش على إنها اختيار
const OPTION = new RegExp(`^\\s*([أ-ي])\\s*${SEPARATOR}\\s*(.+)$`);

const PART_LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'ه', 'و', 'ز', 'ح', 'ط', 'ي'];

function blank(number, label) {
  return {
    number, label: label || null, text: '', options: [], optionLetters: [],
    answer: '', points: null, notes: '', parts: [],
  };
}

// النص بيتجمّع على أسطر: السؤال ممكن يكون فقرتين، والإجابة المرجعية ممكن تكون خمس سطور
function appendLine(current, field, line) {
  if (!current) return;
  current[field] = current[field] ? `${current[field]}\n${line}` : line;
}

function parseQuizDocument(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const byNumber = new Map();
  const warnings = [];

  let current = null;   // السؤال أو الفرع اللي بنكتب فيه دلوقتي
  let field = null;     // آخر علامة اتفتحت: text · answer · notes

  const questionFor = (number) => {
    if (!byNumber.has(number)) byNumber.set(number, blank(number, null));
    return byNumber.get(number);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const marker = trimmed.match(MARKER);
    if (marker) {
      const [, kind, digits, partLetter, rest] = marker;
      const number = Number(toAsciiDigits(digits));
      if (!Number.isInteger(number) || number <= 0) continue;
      const parent = questionFor(number);

      if (kind === 'س') {
        if (partLetter) {
          // فرع: بيتضاف تحت رأسه، والرأس بيفضل ماسك نصه
          let part = parent.parts.find((item) => item.label === partLetter);
          if (!part) { part = blank(number, partLetter); parent.parts.push(part); }
          current = part;
        } else {
          if (parent.text) warnings.push(`السؤال ${number} مكرّر في الملف — اتاخد آخر نص ليه.`);
          current = parent;
        }
        field = 'text';
        if (rest) appendLine(current, 'text', rest);
        continue;
      }

      // ج/د/ت بتروح للفرع لو الرقم معاه حرف، وللسؤال لو لأ
      const target = partLetter
        ? (parent.parts.find((item) => item.label === partLetter) || parent)
        : parent;
      current = target;

      if (kind === 'د') {
        const points = Number(toAsciiDigits(rest).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(points) && points > 0) target.points = points;
        else warnings.push(`درجة السؤال ${number}${partLetter || ''} مش رقم مفهوم — اتحطّت ١.`);
        field = null;
        continue;
      }

      field = kind === 'ج' ? 'answer' : 'notes';
      if (rest) appendLine(target, field, rest);
      continue;
    }

    // اختيار: بس لو إحنا جوه نص سؤال. جوه الإجابة المرجعية السطر اللي شكله "أ) كذا"
    // جزء من الإجابة مش اختيار جديد
    const option = current && field === 'text' && trimmed.match(OPTION);
    if (option) {
      current.optionLetters.push(option[1]);
      current.options.push({ text: option[2].trim(), image: null });
      continue;
    }

    if (current && field) appendLine(current, field, trimmed);
  }

  // ---------- التحويل لشكل المحرر ----------
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const questions = [];

  const finish = (item, label) => {
    const hasOptions = item.options.length >= 2;
    const answer = item.answer.trim();
    const points = item.points === null ? 1 : item.points;
    const shaped = {
      kind: hasOptions ? 'mcq' : 'essay',
      label: label || '',
      text: item.text.trim(),
      image: null,
      points,
      options: hasOptions ? item.options : [],
      correct_option: null,
      reference_answer: hasOptions ? '' : answer,
      grading_notes: item.notes.trim(),
      parts: [],
    };
    const name = `${item.number}${label ? label : ''}`;
    if (!shaped.text) warnings.push(`السؤال ${name} مالوش نص.`);
    if (item.points === null) warnings.push(`السؤال ${name} مالوش درجة — اتحطّت ١.`);

    if (hasOptions) {
      // الإجابة حرف (ب) أو نص الاختيار نفسه — الاتنين مقبولين
      const letter = answer.replace(new RegExp(SEPARATOR, 'g'), '').trim();
      let index = item.optionLetters.indexOf(letter);
      if (index < 0) {
        index = item.options.findIndex((choice) => choice.text === answer);
      }
      if (index < 0) {
        warnings.push(`السؤال ${name} اختياري والإجابة "${answer || '—'}" مش مطابقة أي اختيار — اتحطّ الأول.`);
        index = 0;
      }
      shaped.correct_option = index;
    } else if (!answer) {
      warnings.push(`السؤال ${name} مالوش إجابة مرجعية — التصحيح الآلي مش هيشتغل عليه.`);
    }
    return shaped;
  };

  for (const number of numbers) {
    const item = byNumber.get(number);
    if (item.parts.length) {
      // رأس وفروع: الرأس عنوان بس، وأي إجابة أو درجة اتكتبت له مالهاش مكان
      if (item.answer.trim() || item.points !== null) {
        warnings.push(`السؤال ${number} ليه فروع، فالإجابة والدرجة بتاعته اتجاهلوا — كل فرع ليه إجابته ودرجته.`);
      }
      questions.push({
        kind: 'group', label: '', text: item.text.trim(), image: null, points: 0,
        options: [], correct_option: null, reference_answer: '', grading_notes: '',
        parts: item.parts
          .slice()
          .sort((a, b) => PART_LETTERS.indexOf(a.label) - PART_LETTERS.indexOf(b.label))
          .map((part) => finish(part, part.label)),
      });
      continue;
    }
    questions.push(finish(item, null));
  }

  return { questions, warnings };
}

module.exports = { parseQuizDocument, toAsciiDigits };
