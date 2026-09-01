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

// علامة = حرف + رقم + (حرف فرع اختياري). الرقم هو اللي بيميّزها عن الاختيار.
//
// **والفاصل بعد الرقم اختياري** — `س1 السؤال` زي `س1) السؤال` بالظبط. عشان كده حرف
// الفرع محكوم بشرطين: لازم يبقى **ملزوق بالرقم من غير مسافة**، ولازم يكون بعده فاصل أو
// مسافة أو آخر السطر.
//
// من غير الشرطين دول، `س1 عرّف عملية البناء` كان بيتقري فرع اسمه "ع" ونصه "رّف عملية
// البناء" — أول حرف في السؤال بيتاكل. الشرط الأول بيفرّق بين `س3أ` (فرع) و`س1 عرّف`
// (سؤال بدأ بحرف)، والتاني بيفرّق بين `س3أ) كذا` و`س1عرّف` الملزوقة من غير مسافة
const MARKER = new RegExp(
  `^\\s*([سجدت])\\s*([0-9٠-٩۰-۹]+)(?:([أ-ي])(?=\\s|${SEPARATOR}|$))?\\s*${SEPARATOR}?\\s*(.*)$`);

// اختيار بفاصل: حرف + فاصل + نص. الشكل ده مقبول في أي مكان في القايمة
const OPTION = new RegExp(`^\\s*([أ-ي])\\s*${SEPARATOR}\\s*(.+)$`);

// **اختيار من غير فاصل: حرف + مسافة + نص.** الشكل ده لوحده خطر — سطر زي "و الناتج
// بيكون الجلوكوز" جوه سؤال كان هيتقري اختيار. عشان كده مابيتقبلش إلا لو الحرف هو
// **الحرف اللي جاي في الدور**: أول اختيار لازم "أ"، واللي بعده "ب"، وهكذا. الكلمة
// اللي بتبدأ الجملة بالصدفة نادرًا ما تكون هي الحرف المنتظر بالظبط
const BARE_OPTION = /^\s*([أ-ي])\s+(.+)$/;
const OPTION_LETTERS = ['أ', 'ب', 'ج', 'د', 'ه', 'و', 'ز', 'ح', 'ط', 'ي'];

// **ثلاث نجمات في آخر الاختيار = ده الصح.** بديل عن سطر `ج1` للاختياري: المدرّس
// بيعلّم الإجابة وهو بيكتبها، مش بيرجع يكتب حرفها تحت — والرجوع ده هو اللي بيغلط فيه
const STAR = /\s*\*{1,}\s*$/;

// الرقم لوحده بعد رقم السؤال هو الدرجة: `س1 3`. أي حاجة تانية نص السؤال
const BARE_NUMBER = /^[0-9]+(?:\.[0-9]+)?$/;

const PART_LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'ه', 'و', 'ز', 'ح', 'ط', 'ي'];

function blank(number, label) {
  return {
    number, label: label || null, text: '', options: [], optionLetters: [], starred: [],
    answer: '', points: null, notes: '', parts: [],
  };
}

function nameOf(number, label) {
  return `${number}${label || ''}`;
}

// الدرجة ممكن تتكتب جنب العلامة (`د1 3`) أو في السطر اللي بعدها (`د1` وتحتها `3`).
// الاتنين بيعدّوا من هنا عشان مايبقاش فيه تفسيرين لنفس الرقم
function readPoints(target, raw, warnings) {
  const points = Number(toAsciiDigits(raw).replace(/[^0-9.]/g, ''));
  if (Number.isFinite(points) && points > 0) {
    target.points = points;
    return true;
  }
  warnings.push(`درجة السؤال ${nameOf(target.number, target.label)} مش رقم مفهوم — اتحطّت ١.`);
  return false;
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
        // `س1 3` — الرقم لوحده بعد رقم السؤال درجته، مش نصه. النص بيجي في السطر اللي
        // بعده. أي حاجة غير رقم بتفضل نص زي الأول
        if (rest && BARE_NUMBER.test(toAsciiDigits(rest).trim())) {
          readPoints(current, rest, warnings);
        } else if (rest) {
          appendLine(current, 'text', rest);
        }
        continue;
      }

      // ج/د/ت بتروح للفرع لو الرقم معاه حرف، وللسؤال لو لأ
      const target = partLetter
        ? (parent.parts.find((item) => item.label === partLetter) || parent)
        : parent;
      current = target;

      if (kind === 'د') {
        // **العلامة لوحدها في سطر والرقم في السطر اللي بعدها.** الشكل ده طبيعي في Word
        // لما المدرّس يعمل قايمة، وقبل كده كان الرقم بيضيع والدرجة ترجع ١ من غير ما حد
        // ياخد باله. field = 'points' بيخلي السطر الجاي يتقري درجة مش نص
        if (!rest.trim()) { field = 'points'; continue; }
        readPoints(target, rest, warnings);
        field = null;
        continue;
      }

      field = kind === 'ج' ? 'answer' : 'notes';
      if (rest) appendLine(target, field, rest);
      continue;
    }

    // السطر اللي بعد `د1` لوحدها هو الدرجة — مش نص يتضاف لأي حاجة
    if (current && field === 'points') {
      readPoints(current, trimmed, warnings);
      field = null;
      continue;
    }

    // اختيار: بس لو إحنا جوه سؤال أو في نص قايمة اختياراته. جوه الإجابة المرجعية
    // السطر اللي شكله "أ) كذا" جزء من الإجابة مش اختيار جديد
    if (current && (field === 'text' || field === 'options')) {
      const withSeparator = trimmed.match(OPTION);
      const bare = withSeparator ? null : trimmed.match(BARE_OPTION);
      const expected = OPTION_LETTERS[current.optionLetters.length];
      const option = withSeparator || (bare && bare[1] === expected ? bare : null);
      if (option) {
        const body = option[2].trim();
        if (STAR.test(body)) current.starred.push(current.options.length);
        current.optionLetters.push(option[1]);
        current.options.push({ text: body.replace(STAR, '').trim(), image: null });
        // **بعد أول اختيار، السطر اللي مش اختيار ولا علامة بيتسقط.** نص السؤال بييجي
        // قبل اختياراته دايمًا، فأي سطر بعدها (عنوان، فاصل، كلام سايب) لو اتضاف للنص
        // كان هيروح للطالب في ورقة الامتحان من غير ما حد ياخد باله
        field = 'options';
        continue;
      }
    }

    if (current && (field === 'text' || field === 'answer' || field === 'notes')) {
      appendLine(current, field, trimmed);
    }
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
    const name = nameOf(item.number, label);
    if (!shaped.text) warnings.push(`السؤال ${name} مالوش نص.`);
    if (item.points === null) warnings.push(`السؤال ${name} مالوش درجة — اتحطّت ١.`);

    if (hasOptions) {
      // **النجمة بتكسب سطر `ج`.** لو الاتنين موجودين، اللي المدرّس علّمه جنب الاختيار
      // نفسه أقرب لقصده من حرف كتبه تحت — والحرف هو اللي بيتنسى يتحدّث لما الترتيب يتغيّر
      if (item.starred.length) {
        if (item.starred.length > 1) {
          warnings.push(`السؤال ${name} فيه ${item.starred.length} اختيارات متعلّمين بنجمة — اتاخد الأول فيهم.`);
        }
        shaped.correct_option = item.starred[0];
      } else {
        // الإجابة حرف (ب) أو نص الاختيار نفسه — الاتنين مقبولين
        const letter = answer.replace(new RegExp(SEPARATOR, 'g'), '').trim();
        let index = item.optionLetters.indexOf(letter);
        if (index < 0) {
          index = item.options.findIndex((choice) => choice.text === answer);
        }
        if (index < 0) {
          warnings.push(`السؤال ${name} اختياري ومفيش اختيار متعلّم بـ *** ولا إجابة مطابقة — اتحطّ الأول.`);
          index = 0;
        }
        shaped.correct_option = index;
      }
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
