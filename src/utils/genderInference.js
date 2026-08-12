// تخمين نوع الطالب (ولد/بنت) من اسمه الأول بالاعتماد على التسمية الشائعة في مصر. النتيجة تخمين
// مبني على قاموس أسماء + قواعد لغوية، مش يقين 100% — خصوصًا للأسماء النادرة أو الأجنبية غير
// الشائعة. بيدعم الاسم المكتوب عربي أو بالحروف اللاتينية (شائع جدًا في بيانات منصة طفرة).

// أسماء بنات شائعة (عربي) — من غير التاء المربوطة العادية لأن القاعدة اللغوية بتغطيها، وبنضيف
// كمان تهجئة "ه" العادية بدل "ة" لأنها شائعة جدًا في الكتابة غير الرسمية في مصر (منه، نعمه، رحمه...)
const FEMALE_NAMES_AR = new Set([
  'زينب', 'مريم', 'نور', 'ندى', 'ندي', 'هدى', 'هدي', 'منى', 'مني', 'سلمى', 'سلمي', 'لمى', 'لمي',
  'جنى', 'جني', 'دينا', 'لينا', 'رنا', 'يارا', 'ميار', 'إيمان', 'ايمان', 'إسراء', 'اسراء', 'شيماء',
  'أسماء', 'اسماء', 'سماء', 'هناء', 'هنا', 'سناء', 'دعاء', 'رجاء', 'صفاء', 'شفاء', 'آلاء', 'الاء',
  'ياسمين', 'جودي', 'جوري', 'روان', 'رؤى', 'روى', 'روي', 'سهى', 'سها', 'ليلى', 'ليلي', 'دنيا', 'فرح',
  'ملك', 'ملاك', 'رهف', 'تالا', 'تاليا', 'كارما', 'لجين', 'ريم', 'ريما', 'رانيا', 'رانيه', 'راندا',
  'رحمة', 'رحمه', 'حبيبة', 'حبيبه', 'زهراء', 'زهره', 'زهرة', 'نورهان', 'نيرة', 'نيره', 'نادين',
  'نانسي', 'نرمين', 'نسمة', 'نسمه', 'هاجر', 'هالة', 'هاله', 'سارة', 'ساره', 'سارا', 'مايا', 'مايسة',
  'مايسه', 'ميرا', 'ميرال', 'فيروز', 'جمانة', 'جمانه', 'جيهان', 'إيناس', 'ايناس', 'إنجي', 'انجي',
  'أميرة', 'اميرة', 'اميره', 'أميره', 'عبير', 'غادة', 'غاده', 'وفاء', 'وسام', 'وعد', 'يسرا', 'يمنى',
  'يمني', 'كنزي', 'كنزى', 'كارين', 'كوثر', 'لبنى', 'لبني', 'لمياء', 'مادونا', 'مارينا', 'مارتينا',
  'مي', 'مى', 'ميرنا', 'ندين', 'نغم', 'هبة', 'هبه', 'هدير', 'ورد', 'وردة', 'ورده', 'أروى', 'اروى',
  'أريج', 'اريج', 'بسملة', 'بسمله', 'بسمة', 'بسمه', 'تسنيم', 'جنات', 'جنة', 'جنه', 'حنين', 'حنان',
  'خلود', 'دانة', 'دانه', 'دانيا', 'رزان', 'رغد', 'روزا', 'ريتاج', 'سيلين', 'سيلينا', 'شهد', 'صبا',
  'ضحى', 'ضحي', 'عائشة', 'عائشه', 'عايشة', 'عايشه', 'فاطمة', 'فاطمه', 'قمر', 'كادي', 'كيان', 'لانا',
  'لارا', 'لمار', 'مرام', 'مروة', 'مروه', 'مها', 'مياسة', 'مياسه', 'نور الهدى', 'نورا', 'هيا',
  'ياسمينا', 'دينار', 'إليانا', 'اليانا', 'منة', 'منه', 'أمنية', 'امنية', 'امنيه', 'أمنيه', 'سعاد',
  'شروق', 'لوجينا', 'لوچينا', 'نعمة', 'نعمه', 'مروان' /* نادرًا بنت */, 'إيلاف', 'ايلاف', 'رودينا',
  'روضة', 'روضه', 'سجى', 'سجي', 'مي محمد', 'يسمين', 'ياسمينه', 'كارولين', 'كريستين', 'مارلين',
  'مارينا', 'ماريا', 'ماريان', 'ماري', 'مارى', 'كيرلس' /* نادرًا */, 'فيبي', 'فيبى', 'ديانا', 'دينا',
  'سيمون', 'سالي', 'سالى', 'سيرين', 'سرين', 'رنيم', 'رهام', 'رودينا', 'داليا', 'دلال', 'أسيل',
  'اسيل', 'إسيل', 'رفيدة', 'رفيده', 'رودينا', 'شهيرة', 'شهيره', 'عبلة', 'عبله', 'فايزة', 'فايزه',
  'نبيلة', 'نبيله', 'نجلاء', 'نجلا', 'هيام', 'وداد', 'وردة', 'ياقوت', 'يمامة', 'يمامه', 'زمزم',
  'رنده', 'رندة', 'راغدة', 'راغده', 'سوسن', 'شذى', 'شذي', 'صافيناز', 'عزة', 'عزه', 'كريمة', 'كريمه',
  'لطيفة', 'لطيفه', 'ليان', 'ليانا', 'مادلين', 'مروى', 'مروي', 'ميادة', 'ميرال', 'نيفين', 'هند',
  'أشواق', 'اشواق', 'عهود', 'جنا', 'سما', 'سمر', 'رضوى', 'رضوي', 'رؤي', 'ريناد', 'بيسان', 'تالين',
  'روز', 'جود', 'ندا', 'هبا', 'رنيم', 'رهف', 'لارين', 'كارلا', 'ميلا', 'أفنان', 'افنان', 'أثير',
  'اثير', 'إشراق', 'اشراق', 'وئام', 'إباء', 'اباء', 'رند', 'ريحان', 'ريحانة', 'شذا', 'صفية', 'صفيه',
  'عزيزة', 'عزيزه', 'فرحة', 'فرحه', 'قدرية', 'قدريه', 'كريستينا', 'مارغريت', 'مرفت', 'نادرة', 'نادره',
  'نجوى', 'نجوي', 'وسن', 'يقين', 'بسنت', 'ميسون', 'ميسان',
]);

const FEMALE_NAMES_LATIN = new Set([
  'salma', 'mariam', 'maryam', 'rahaf', 'sara', 'sarah', 'nada', 'malak', 'farida', 'habiba', 'nour',
  'noura', 'yasmin', 'yasmine', 'jana', 'jana', 'jenna', 'lina', 'lena', 'dina', 'rana', 'yara',
  'menna', 'mina', 'mennatullah', 'mennatallah', 'aya', 'aliaa', 'aleaa', 'alia', 'alaa', 'esraa',
  'israa', 'esraa', 'shahd', 'shahed', 'salsabil', 'tasneem', 'tasnim', 'tasneememadgooda', 'razan',
  'rawan', 'roaa', 'roqaya', 'ruqaya', 'jomana', 'jumana', 'gehad', 'gihan', 'jihan', 'basmala',
  'basma', 'hana', 'hanaa', 'lujain', 'lojain', 'lojina', 'logina', 'reem', 'reema', 'rania',
  'randa', 'rahma', 'habiba', 'zahraa', 'nourhan', 'nada', 'nadine', 'nesma', 'hala', 'mai', 'may',
  'mirna', 'ganna', 'ganat', 'jannat', 'hanin', 'hanan', 'khloud', 'dana', 'raghad', 'seleen',
  'shahd', 'sabaa', 'doha', 'aisha', 'ayesha', 'fatma', 'fatema', 'fatima', 'qamar', 'kayan',
  'lana', 'lara', 'maram', 'marwa', 'maha', 'noran', 'yara', 'iman', 'eman', 'nourhan',
  'shrouk', 'shorouk', 'shorok', 'bassant', 'basant', 'basent', 'mayson', 'maysoon', 'maisoon',
]);

// أسماء ولاد بتنتهي بتاء مربوطة/ه أو "اء" فبتكسر القاعدة اللغوية العادية — استثناءات مهمة
const MALE_EXCEPTIONS_AR = new Set([
  'حمزة', 'حمزه', 'أسامة', 'اسامه', 'اسامة', 'معاوية', 'معاويه', 'طلحة', 'طلحه', 'عبيدة', 'عبيده',
  'عطية', 'عطيه', 'بهاء', 'يحيى', 'يحيي', 'مصطفى', 'مصطفي', 'موسى', 'موسي', 'عيسى', 'عيسي', 'زكريا',
  'إلياس', 'الياس', 'نجا', 'رضا', 'مرتضى', 'مرتضي', 'المهدي', 'المهدى', 'طه', 'عبده', 'رفاعي',
  'رفاعى', 'شحاته', 'شحاتة', 'زغلول', 'حجازي', 'دنيا' /* نادرًا ولد */, 'بيشوى', 'بيشوي',
]);

const MALE_NAMES_LATIN = new Set([
  'ahmed', 'ahmad', 'mohamed', 'mohammed', 'muhammad', 'mohammad', 'mahmoud', 'mahmood', 'ali',
  'omar', 'amr', 'youssef', 'yousef', 'yousif', 'joseph', 'karim', 'kareem', 'hassan', 'hussein',
  'hussain', 'khaled', 'khalid', 'adam', 'ibrahim', 'ziad', 'ziyad', 'tarek', 'tarik', 'sherif',
  'waleed', 'walid', 'fady', 'fadi', 'andrew', 'mina', 'peter', 'michael', 'ramy', 'rami', 'sameh',
  'sayed', 'seyed', 'nabil', 'ashraf', 'emad', 'wael', 'bassem', 'basem', 'islam', 'ayman', 'marwan',
  'yassin', 'yasin', 'bilal', 'belal', 'anas', 'momen', 'moamen', 'eyad', 'iyad', 'hazem', 'karam',
  'saad', 'saeed', 'said', 'salah', 'salah', 'gamal', 'jamal', 'hisham', 'sameh', 'sameer', 'samir',
  'shady', 'shadi', 'khalil', 'zeyad', 'zaid', 'zayed', 'nader', 'nadir', 'george', 'girgis',
  'kirolos', 'kirollos', 'mark', 'maged', 'magdy', 'medhat', 'ehab', 'sherief', 'ossama', 'rageh',
  'ragheb', 'mostafa', 'mustafa', 'moustafa', 'yahia', 'yehia', 'yahya', 'isa', 'eisa', 'osama',
  'hamza', 'hamzah', 'redha', 'reda', 'seif', 'seifeldin', 'zein', 'zain', 'moaz', 'moaaz',
  'hossam', 'hosam', 'bishoy', 'bishoi', 'bishop', 'antoun', 'antony', 'anthony',
  // "nour" مقصودة برّه القايمتين — الاسم ده unisex فعليًا في مصر (ولاد وبنات)، فبنسيبه غير محدد
]);

function extractFirstNameToken(fullName) {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return '';
  const tokens = trimmed.split(/\s+/);
  // "عبد + اسم من أسماء الله" لازم تتاخد كوحدة واحدة (ولد قطعًا)، وإلا هتتقطع لـ"عبد" لوحدها
  if (/^عبد$/i.test(tokens[0]) && tokens[1]) return `${tokens[0]} ${tokens[1]}`;
  return tokens[0];
}

function isArabic(text) {
  return /[؀-ۿ]/.test(text);
}

// 'male' | 'female' | null (مش متأكدين — اسم مش موجود بالقاموس ومفيهوش علامة واضحة)
function inferGenderFromName(fullName) {
  const firstNameRaw = extractFirstNameToken(fullName);
  if (!firstNameRaw) return null;

  if (isArabic(firstNameRaw)) {
    const firstName = firstNameRaw.replace(/^(ال)/, ''); // إسقاط "ال" التعريف لو موجودة أول الاسم
    if (firstName.startsWith('عبد')) return 'male';
    if (MALE_EXCEPTIONS_AR.has(firstName)) return 'male';
    if (FEMALE_NAMES_AR.has(firstName)) return 'female';
    // التاء المربوطة، وتهجئتها العامية بـ"ه"، وأغلب الأسماء المنتهية بـ"اء" علامة تأنيث قوية
    if (/[ةه]$/.test(firstName) && firstName.length > 2) return 'female';
    if (/اء$/.test(firstName)) return 'female';
    // الاسم منتهي بألف مقصورة (ى بس، مش ي العادية) غامض (مصطفى ولد، سلمى بنت) ومش موجود بالقاموس —
    // نسيبه غير محدد. الاسم المنتهي بـ"ي" العادية (زي علي، حسني) مش غامض بنفس الدرجة فبيكمّل تحت
    if (/ى$/.test(firstName) && firstName.length <= 6) return null;
    return 'male'; // مفيش علامة تأنيث ولا في قاموس البنات — الحالة الافتراضية لغويًا هي المذكّر
  }

  // اسم مكتوب بالحروف اللاتينية (شائع في بيانات المنصة)
  const lower = firstNameRaw.toLowerCase().replace(/[^a-z]/g, '');
  if (!lower) return null;
  if (MALE_NAMES_LATIN.has(lower)) return 'male';
  if (FEMALE_NAMES_LATIN.has(lower)) return 'female';
  if (/(a|ah)$/.test(lower) && lower.length > 2) return 'female'; // أسماء كتير بتاعة بنات بتخلص a
  return null; // اسم أجنبي/لاتيني مش في القاموس — مانخمّنش غلط، نسيبه غير محدد
}

module.exports = { inferGenderFromName, extractFirstNameToken };
