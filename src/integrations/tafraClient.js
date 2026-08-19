const BASE_URL = 'https://api.abdullah-habashy.com/v1/academy/admin';
const USER_AGENT = 'TelegramBroadcastManager-Tafra/1.0';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// انتهاء الجلسة مش دايمًا بييجي بحالة 401: منصة طفرة بترجّع HTTP 200 ومعاه success:false
// والرسالة "يجب أن تكون مسجل الدخول للقيام بذلك."، فالفحص بالحالة لوحدها كان بيفوّتها والطلب
// يفشل نهائيًا بدل ما يعيد تسجيل الدخول. حصل فعليًا في مزامنة 18 أغسطس: التوكن خلص في نص
// عملية بتاخد ~40 دقيقة، فضاعت درجات اختبار كامل. بنفحص الحالة **والرسالة** مع بعض
const SESSION_EXPIRED_HINTS = [
  'يجب أن تكون مسجل الدخول',
  'unauthenticated',
  'unauthorized',
  'token has expired',
];

function isSessionExpiredError(error) {
  if (!error) return false;
  if (error.status === 401) return true;
  const message = String(error.message || '').toLowerCase();
  return SESSION_EXPIRED_HINTS.some((hint) => message.includes(hint.toLowerCase()));
}

class TafraReadOnlyClient {
  constructor(identifier, password) {
    this.identifier = identifier;
    this.password = password;
    this.accessToken = null;
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
    try {
      const response = await fetch(url, {
        ...options,
        timeoutMs: undefined,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          ...(options.headers || {}),
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) {
        const error = new Error(payload?.message || `Tafra request failed (${response.status})`);
        error.status = response.status;
        // المنصة بترجّع أحيانًا **200** ومعاها success:false ونص خطأ PHP داخلي (شوفنا
        // "Attempt to read property \"name\" on null" على صفحات درجات في نص المزامنة).
        // ده خلل لحظي عندهم بيعدّي لو أعدنا المحاولة، لكن الحالة دي كانت بتفلت من إعادة
        // المحاولة تمامًا لأن شرطها status >= 500 و 200 مش أكبر من 500 — فالمزامنة كانت
        // بتسيب الاختبار ناقص من غير ما تحاول تاني
        error.platformFailure = response.ok && payload?.success === false;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async login() {
    const payload = await this.request(`${BASE_URL}/login`, {
      method: 'POST',
      body: JSON.stringify({ identifier: this.identifier, password: this.password }),
    });
    this.accessToken = payload.data?.token;
    if (!this.accessToken) throw new Error('لم تُرجع المنصة رمز دخول صالحًا');
    return payload.data?.user || null;
  }

  async ensureLogin() {
    if (!this.accessToken) await this.login();
  }

  // هذه هي عملية قراءة الطلاب الوحيدة المتاحة من هذا العميل.
  async getStudentsPage(page, perPage = 100) {
    await this.ensureLogin();
    const safePage = Math.max(1, Number(page) || 1);
    const safePerPage = Math.min(100, Math.max(1, Number(perPage) || 100));
    const url = `${BASE_URL}/students?page=${safePage}&per_page=${safePerPage}`;
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.request(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      } catch (error) {
        lastError = error;
        if (error.status === 401) {
          this.accessToken = null;
          await this.ensureLogin();
        } else if (attempt < 4 && (error.name === 'AbortError' || error.status === 429
          || error.status >= 500 || error.platformFailure)) {
          await delay(attempt * 1500);
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }

  async waitForRateLimit() {
    await delay(210);
  }

  async getBootcamps() {
    await this.ensureLogin();
    return this.request(`${BASE_URL}/filterData/bootcamps`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  async getBootcampEnrollmentsPage(bootcampId, page) {
    await this.ensureLogin();
    const safeBootcampId = Number(bootcampId);
    const safePage = Math.max(1, Number(page) || 1);
    if (!Number.isInteger(safeBootcampId) || safeBootcampId <= 0) throw new Error('رقم الباب غير صالح');
    const url = `${BASE_URL}/bootcamps/${safeBootcampId}/enrollments?page=${safePage}`;
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.request(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      } catch (error) {
        lastError = error;
        if (error.status === 401) {
          this.accessToken = null;
          await this.ensureLogin();
        } else if (attempt < 4 && (error.name === 'AbortError' || error.status === 429
          || error.status >= 500 || error.platformFailure)) {
          await delay(attempt * 1500);
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }

  // طلب GET مع نفس منطق إعادة المحاولة المستخدم في باقي العميل (تجديد التوكن عند 401، تأجيل عند 429/5xx)
  async getWithRetry(url) {
    await this.ensureLogin();
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.request(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      } catch (error) {
        lastError = error;
        if (isSessionExpiredError(error)) {
          this.accessToken = null;
          await this.ensureLogin();
        } else if (attempt < 4 && (error.name === 'AbortError' || error.status === 429
          || error.status >= 500 || error.platformFailure)) {
          await delay(attempt * 1500);
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }

  // ⚠ اكتشاف مؤكّد: filterData/online-exams و filterData/offline-exams بدون فلتر بيرجّعوا
  // أحدث 10 نتائج بس (سلوك غير موثّق في دليل المنصة) — مش كل الاختبارات فعليًا.
  // filter[id]=N لوحده بيعمل بحث مباشر بالمعرّف من غير القيد ده، فبنستخدمه للمسح الكامل بدل القائمة المبتورة.
  async findExamById(examType, examId) {
    const path = examType === 'online' ? 'online-exams' : 'offline-exams';
    const response = await this.getWithRetry(`${BASE_URL}/filterData/${path}?filter[id]=${examId}`);
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows[0] || null;
  }

  async getOnlineExamStudentsPage(examId, page) {
    const safeExamId = Number(examId);
    const safePage = Math.max(1, Number(page) || 1);
    if (!Number.isInteger(safeExamId) || safeExamId <= 0) throw new Error('رقم الاختبار غير صالح');
    return this.getWithRetry(`${BASE_URL}/online-exams/${safeExamId}/students?page=${safePage}`);
  }

  // كل دروس المنصة بمعرّفاتها ومددها. مافيهاش meta فالترقيم بيقف لما صفحة ترجع أقل من ١٥ صف.
  // مابتربطش الدرس بكورس (الفلتر المسموح search و material_id بس)، فبنستخدمها للمعرّف والترتيب
  // بس، والربط بالكورس بييجي من سجل المشاهدات
  async getAllOnlineLessons(maxPages = 40) {
    const rows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.getWithRetry(`${BASE_URL}/online-lessons?page=${page}`);
      const pageRows = Array.isArray(response.data?.data) ? response.data.data : [];
      rows.push(...pageRows);
      if (pageRows.length < 15) break;
      await delay(110);
    }
    return rows;
  }

  // مشاهدات كورس كامل (كل الطلاب) — filter[bootcamp_id] مدعوم هنا، على عكس /online-lessons
  // اللي مابيقبلش غير search و material_id. ده المصدر الوحيد اللي بيربط الدرس بالكورس
  async getBootcampLessonViewsPage(bootcampId, page) {
    const safeBootcampId = Number(bootcampId);
    const safePage = Math.max(1, Number(page) || 1);
    if (!Number.isInteger(safeBootcampId) || safeBootcampId <= 0) throw new Error('رقم الكورس غير صالح');
    return this.getWithRetry(
      `${BASE_URL}/online-lessons/views/index?filter[bootcamp_id]=${safeBootcampId}&sort=-viewed_at&page=${safePage}`);
  }

  // ملاحظة: filter[search] معطّل على هذا المسار من طرف المنصة نفسها (خطأ 500) — لا تضِفه أبدًا هنا
  async getOfflineExamMarksPage(examId, page) {
    const safeExamId = Number(examId);
    const safePage = Math.max(1, Number(page) || 1);
    if (!Number.isInteger(safeExamId) || safeExamId <= 0) throw new Error('رقم الاختبار غير صالح');
    return this.getWithRetry(`${BASE_URL}/offline-exams/${safeExamId}/marks?page=${safePage}`);
  }

  // سجل مشاهدات دروس طالب واحد. مفيش مسار مستقل للطالب على المنصة — نفس نقطة المجموعة الكاملة
  // مع filter[user_id]، والترقيم 15 صف للصفحة (ثابت من المنصة، مفيش per_page).
  // بنحدّ عدد الصفحات لأن ده بيتنادى لحظيًا وقت ما الموظف يفتح البروفايل، فمينفعش يستنى دقايق
  async getStudentLessonViews(studentId, maxPages = 10) {
    const safeStudentId = Number(studentId);
    if (!Number.isInteger(safeStudentId) || safeStudentId <= 0) throw new Error('رقم الطالب غير صالح');

    const rows = [];
    let total = 0;
    let lastPage = 1;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.getWithRetry(
        `${BASE_URL}/online-lessons/views/index?filter[user_id]=${safeStudentId}&sort=-viewed_at&page=${page}`
      );
      const pageRows = Array.isArray(response.data?.data) ? response.data.data : [];
      rows.push(...pageRows);
      const meta = response.data?.meta || {};
      total = Number(meta.total) || rows.length;
      lastPage = Number(meta.last_page) || 1;
      if (page >= lastPage || !pageRows.length) break;
      await delay(120);
    }
    // truncated بيقول للواجهة إن فيه مشاهدات أقدم ما اتجابتش، عشان متعرضش رقم ناقص كأنه الكل
    return { rows, total, truncated: lastPage > maxPages };
  }

  // بيرجّع اسم الكورس اللي الاختبار الأونلاين ده تابع له — متاح للأونلاين بس (قيد من المنصة نفسها)
  async getStudentExamMarksHistory(studentId, examId) {
    const safeStudentId = Number(studentId);
    const safeExamId = Number(examId);
    if (!Number.isInteger(safeStudentId) || safeStudentId <= 0) throw new Error('رقم الطالب غير صالح');
    if (!Number.isInteger(safeExamId) || safeExamId <= 0) throw new Error('رقم الاختبار غير صالح');
    return this.getWithRetry(`${BASE_URL}/online-exams/student/${safeStudentId}/marksHistory?filter[online_exam_id]=${safeExamId}`);
  }
}

module.exports = { TafraReadOnlyClient, BASE_URL };
