const BASE_URL = 'https://api.abdullah-habashy.com/v1/academy/admin';
const USER_AGENT = 'TelegramBroadcastManager-Tafra/1.0';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        } else if (attempt < 4 && (error.name === 'AbortError' || error.status === 429 || error.status >= 500)) {
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
        } else if (attempt < 4 && (error.name === 'AbortError' || error.status === 429 || error.status >= 500)) {
          await delay(attempt * 1500);
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

module.exports = { TafraReadOnlyClient, BASE_URL };
