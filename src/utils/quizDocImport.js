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

// ---------- علامة الصورة ----------
//
// **بحرف تحكّم مش بنص عادي.** المحلّل ده بيخدم مسارين: ملف Word، و"الصق النص" اللي
// الموظف بيكتب فيه بإيده. أي علامة من حروف عادية كان الموظف يقدر يكتبها — بالصدفة أو
// بالقصد — ويحط صورة في سؤال من غير ما يرفع صورة أصلًا. U+0000 مستحيل يتكتب من كيبورد
// ولا يطلع من مستند Word.
//
// الشكل والتعرّف في نفس المكان عشان الوحدة اللي بتحوّل ملف الـWord تستعمل نفس التعريف —
// نسختين معناهما إن الصورة تتعلّم بشكل والقراءة تدوّر على شكل تاني
const IMAGE_MARKER = /^\u0000IMG:(\d+)\u0000$/;

function imageMarker(index) {
  return `\u0000IMG:${index}\u0000`;
}

const PART_LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'ه', 'و', 'ز', 'ح', 'ط', 'ي'];

// **النص بيتخزّن أسطر مش نص واحد.** السؤال الاختياري بيتكتب "نص السؤال" وتحته
// الاختيارات من غير حروف، فالتفرقة بينهم مابتتعرفش غير بعد ما البلوك يخلص — ولو
// لزقناهم في نص واحد وقتها مافيش طريقة نفصلهم تاني
function blank(number, label) {
  return {
    number, label: label || null,
    lines: { text: [], answer: [], notes: [] },
    options: [], optionLetters: [], starred: [],
    // أرقام الصور اللي في **نص** السؤال. الصور اللي تحت الإجابة بتتسجّل على جنب
    // (answerImages) لأنها غالبًا رسم الإجابة النموذجية
    images: [], answerImages: [],
    points: null, parts: [],
  };
}

function joined(item, field) {
  return item.lines[field].join('\n').trim();
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
  if (!current || !current.lines[field]) return;
  current.lines[field].push(line);
}

function parseQuizDocument(raw) {
  const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
  const byNumber = new Map();
  const warnings = [];
  // صور قبل أول سؤال: مالهاش صاحب. القارئ بيسقط كل سطر قبل أول `س` عن قصد (مكان
  // الشرح في النموذج)، فالصورة هنا مش هيكون ليها سؤال تتحط فيه
  const orphanImages = [];

  let current = null;   // السؤال أو الفرع اللي بنكتب فيه دلوقتي
  let field = null;     // آخر علامة اتفتحت: text · answer · notes

  const questionFor = (number) => {
    if (!byNumber.has(number)) byNumber.set(number, blank(number, null));
    return byNumber.get(number);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // **علامة الصورة بتتمسك هنا وبتعدّي — قبل أي فحص تاني.**
    // القارئ ده بياخد أول سطر على إنه نص السؤال و**كل اللي بعده اختيارات**، فسطر
    // العلامة لو نزل في نص السؤال بيتحسب **اختيار خامس فاضي بيظهر للطالب**.
    // وأي مكان تاني بيغلط بشكل مختلف: بعد فحص الدرجة بتتاكل على إنها درجة، وبعد فحص
    // الاختيارات بتتقري اختيار اسمه "أ". والتعدية مش اختيارية — من غيرها بترجع للنص
    const image = trimmed.match(IMAGE_MARKER);
    if (image) {
      const index = Number(image[1]);
      // **الصورة تحت `ج` أو `د` أو `ت` مش صورة سؤال.** دي غالبًا رسم الإجابة
      // النموذجية، وصفحة الطالب بتعرض صورة السؤال **فوق خانة الإجابة** — يعني كان
      // هيشوف الحل قبل ما يحل
      if (!current) orphanImages.push(index);
      else if (field === 'text' || field === 'options') current.images.push(index);
      else current.answerImages.push(index);
      continue;
    }

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
          if (parent.lines.text.length) {
            warnings.push(`السؤال ${number} مكرّر في الملف — اتاخد آخر نص ليه.`);
          }
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

  // **الاختيارات من غير حروف: النجمة هي اللي بتقول إن البلوك ده اختياري.**
  // المدرّس بيكتب نص السؤال وتحته أربع سطور من غير أ ب ج د، فمافيش أي حاجة في السطر
  // نفسه بتفرّقه عن سطر تاني من نص السؤال. اللي بيفرّق إن سطر واحد فيهم متعلّم بـ ***
  // — يعني البلوك فيه إجابة صح، يعني هو اختياري. من غير النجمة بيتقري مقالي.
  //
  // أول سطر بيفضل نص السؤال دايمًا، والباقي اختيارات بالترتيب أ ب ج د
  const splitPositionalOptions = (item, name) => {
    if (item.options.length) return null;
    const lines = item.lines.text;
    const starIndex = lines.findIndex((line) => STAR.test(line));
    if (starIndex < 0) return null;
    if (starIndex === 0) {
      warnings.push(`السؤال ${name} أول سطر بعد رقمه متعلّم بـ *** — نص السؤال لازم يجي قبل الاختيارات.`);
      return null;
    }
    const body = lines.slice(1);
    return {
      text: lines[0].trim(),
      options: body.map((line) => ({ text: line.replace(STAR, '').trim(), image: null })),
      starred: body.reduce((found, line, index) => (STAR.test(line) ? found.concat(index) : found), []),
    };
  };

  const finish = (item, label) => {
    const name = nameOf(item.number, label);
    const positional = splitPositionalOptions(item, name);
    const options = positional ? positional.options : item.options;
    const starredAt = positional ? positional.starred : item.starred;
    const hasOptions = options.length >= 2;
    const answer = joined(item, 'answer');
    const points = item.points === null ? 1 : item.points;
    const shaped = {
      kind: hasOptions ? 'mcq' : 'essay',
      label: label || '',
      // الاسم زي ما الموظف بيشوفه في التحذيرات: "3أ"
      name,
      // **أرقام مش مسارات.** القارئ مابيعرفش حاجة عن حفظ الملفات — بيقول الصورة رقم
      // كام في السؤال ده بس، واللي بينده هو اللي بيقرر يحفظ ولا يرفض
      image_indexes: item.images.slice(),
      answer_image_indexes: item.answerImages.slice(),
      text: positional ? positional.text : joined(item, 'text'),
      image: null,
      points,
      options: hasOptions ? options : [],
      correct_option: null,
      reference_answer: hasOptions ? '' : answer,
      grading_notes: joined(item, 'notes'),
      parts: [],
    };
    if (!shaped.text) warnings.push(`السؤال ${name} مالوش نص.`);
    if (item.points === null) warnings.push(`السؤال ${name} مالوش درجة — اتحطّت ١.`);
    // مقالي من غير إجابة وتحته تلات سطور قصيرة أو أكتر: الأغلب اختياري ونُسيت نجمته.
    // التخمين ده تحذير بس — مابيغيّرش نوع السؤال، عشان مايتصرّفش من ورا المدرّس
    if (!hasOptions && !answer && item.lines.text.length >= 4
        && item.lines.text.slice(1).every((line) => line.trim().length <= 80)) {
      warnings.push(`السؤال ${name} شكله اختياري — لو كده، حط *** بعد الإجابة الصح.`);
    }

    if (hasOptions) {
      // **النجمة بتكسب سطر `ج`.** لو الاتنين موجودين، اللي المدرّس علّمه جنب الاختيار
      // نفسه أقرب لقصده من حرف كتبه تحت — والحرف هو اللي بيتنسى يتحدّث لما الترتيب يتغيّر
      if (starredAt.length) {
        if (starredAt.length > 1) {
          warnings.push(`السؤال ${name} فيه ${starredAt.length} اختيارات متعلّمين بنجمة — اتاخد الأول فيهم.`);
        }
        shaped.correct_option = starredAt[0];
      } else {
        // الإجابة حرف (ب) أو نص الاختيار نفسه — الاتنين مقبولين
        const letter = answer.replace(new RegExp(SEPARATOR, 'g'), '').trim();
        let index = item.optionLetters.indexOf(letter);
        if (index < 0) {
          index = options.findIndex((choice) => choice.text === answer);
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
      if (joined(item, 'answer') || item.points !== null) {
        warnings.push(`السؤال ${number} ليه فروع، فالإجابة والدرجة بتاعته اتجاهلوا — كل فرع ليه إجابته ودرجته.`);
      }
      questions.push({
        kind: 'group', label: '', name: String(number),
        image_indexes: item.images.slice(), answer_image_indexes: item.answerImages.slice(),
        text: joined(item, 'text'), image: null, points: 0,
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

  return { questions, warnings, orphan_images: orphanImages };
}

module.exports = { parseQuizDocument, toAsciiDigits, imageMarker, IMAGE_MARKER };
