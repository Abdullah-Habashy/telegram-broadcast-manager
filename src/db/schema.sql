-- ============================================================
-- Telegram Broadcast Manager — Database Schema
-- ============================================================

-- مستخدمو لوحة التحكم (تسجيل دخول لأكتر من مستخدم)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'agent',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'agent';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
-- صلاحيات عرض تخص الموظف (agent) بس — الأدمن دايمًا عنده الاتنين بغض النظر عن القيمة هنا
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_tickets BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_calls BOOLEAN NOT NULL DEFAULT TRUE;
-- صلاحية "مسند" — موظف (مش أدمن) يقدر يسند/يلغي إسناد طلاب متابعة المكالمات لغيره من الموظفين،
-- بدل ما ده يفضل مقصور على الأدمن بس. افتراضيًا متعطّلة (صلاحية أعلى من الموظف العادي)
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_assign_calls BOOLEAN NOT NULL DEFAULT FALSE;
-- ربط حساب الموظف الشخصي على تيليجرام (مرة واحدة عبر أمر /linkstaff) — يُستخدم لإرسال إشعارات تشغيلية
-- زي رابط Tunnel الجديد تلقائيًا لكل الموظفين، من غير ما نعتمد على قائمة ثابتة في .env
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code VARCHAR(20);

-- بوتات تيليجرام المحفوظة للتبديل المرن بينها
CREATE TABLE IF NOT EXISTS bot_profiles (
    id SERIAL PRIMARY KEY,
    label VARCHAR(100) NOT NULL,
    telegram_bot_id BIGINT UNIQUE,
    bot_username VARCHAR(255),
    bot_name VARCHAR(255),
    token_encrypted TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    last_verified_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_profiles_one_active
    ON bot_profiles (is_active) WHERE is_active = TRUE;

-- ضمان وجود مدير واحد على الأقل عند ترقية مشروع قائم
UPDATE users SET role = 'admin'
WHERE id = (SELECT MIN(id) FROM users)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

-- جدول الجلسات (يُدار تلقائيًا بواسطة connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
    "sid" VARCHAR NOT NULL COLLATE "default",
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
) WITH (OIDS=FALSE);
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_pkey";
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- جهات الاتصال
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT UNIQUE NOT NULL,
    telegram_username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    phone VARCHAR(50),
    source VARCHAR(20) NOT NULL DEFAULT 'bot', -- 'bot' (تسجيل تلقائي عند /start) أو 'csv_import'
    last_contacted_at TIMESTAMPTZ,             -- يتحدّث عند أي إرسال/استقبال رسالة — أساس فلتر "أكتر من أسبوع"
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON contacts (last_contacted_at);

-- طلاب بدأوا محادثة مع "البوت الجديد" (بوت منفصل تمامًا، شغّال بالتوازي مع بوت الدعم الحالي).
-- chat_id بيتطابق مع نفس chat_id بتاع تليجرام العادي بتاع المستخدم (مش خاص بالبوت)، فبيتربط
-- مباشرة بـ tafra_students.telegram_chat_id من غير أي حاجة زيادة — عشان نعرف مين لسه ما بدأش
CREATE TABLE IF NOT EXISTS new_bot_contacts (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT UNIQUE NOT NULL,
    telegram_username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- التصنيفات (Tags)
CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    color VARCHAR(20) NOT NULL DEFAULT '#6b7280'
);

-- ربط جهات الاتصال بالتصنيفات (Many-to-Many)
CREATE TABLE IF NOT EXISTS contact_tags (
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (contact_id, tag_id)
);

-- قوالب الرسائل الجاهزة (Templates)
CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- عمليات الإرسال الجماعي (فورية أو مجدولة)
CREATE TABLE IF NOT EXISTS broadcasts (
    id SERIAL PRIMARY KEY,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    message_content TEXT NOT NULL,
    filter_tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL, -- NULL = كل جهات الاتصال
    selected_contact_ids INTEGER[],     -- NULL = الكل/حسب التصنيف، وإلا جهات محددة يدويًا
    image_path TEXT,                    -- مسار صورة اختيارية داخل public/uploads
    scheduled_for TIMESTAMPTZ,          -- NULL = إرسال فوري
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | sending | completed | failed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS selected_contact_ids INTEGER[];
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS image_path TEXT;
-- ربط اختياري باختبار معيّن — يفعّل استبدال كلمتي "اختبار"/"الدرجة" باسم الاختبار ودرجة كل طالب عند الإرسال
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS context_exam_type VARCHAR(10);
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS context_exam_id BIGINT;
-- زرار اختياري تحت الرسالة (Inline Keyboard) — مفيد مثلاً لتوجيه الطالب لبوت تاني بضغطة واحدة
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS button_text VARCHAR(64);
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS button_url TEXT;
CREATE INDEX IF NOT EXISTS idx_broadcasts_pending_schedule ON broadcasts (status, scheduled_for);

-- تقرير نجاح/فشل كل رسالة داخل عملية الإرسال (سجل الرسائل المُرسلة)
CREATE TABLE IF NOT EXISTS broadcast_recipients (
    id SERIAL PRIMARY KEY,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | sent | failed
    error_message TEXT,
    sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_broadcast ON broadcast_recipients (broadcast_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact_sent
    ON broadcast_recipients (contact_id, sent_at DESC)
    WHERE status = 'sent';

-- الرسائل الواردة من المستخدمين للبوت (أساس الرد التلقائي + الإحصائيات)
CREATE TABLE IF NOT EXISTS incoming_messages (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    content TEXT,
    image_path TEXT,
    telegram_file_id TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE incoming_messages ADD COLUMN IF NOT EXISTS image_path TEXT;
ALTER TABLE incoming_messages ADD COLUMN IF NOT EXISTS telegram_file_id TEXT;
-- تمييز رسائل الطالب (star = رسالة حلوة/إشادة، complaint = شكوى) عشان تتجمّع في مكان واحد بدل ما
-- تتوه وسط باقي المحادثات
ALTER TABLE incoming_messages ADD COLUMN IF NOT EXISTS flag VARCHAR(20);
-- معرّف رسالة تيليجرام — لازم عشان الموظف يقدر يعمل reply فعلي (quote) على رسالة الطالب دي بالذات،
-- وكمان عشان نقدر نحط عليها reaction (إيموجي) من حساب البوت
ALTER TABLE incoming_messages ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
-- الإيموجي اللي الموظف حطّه كـ reaction على رسالة الطالب دي (لو موجود) — بيتزامن مع reaction حقيقي
-- على تيليجرام نفسه عن طريق setMessageReaction
ALTER TABLE incoming_messages ADD COLUMN IF NOT EXISTS agent_reaction VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_incoming_messages_contact_received
    ON incoming_messages (contact_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_incoming_messages_flag ON incoming_messages (flag) WHERE flag IS NOT NULL;

-- عناوين فرعية مرنة لتنظيم محادثات صندوق الدعم
CREATE TABLE IF NOT EXISTS ticket_subtitles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ticket_subtitles (name)
VALUES ('مطلوب المتابعة')
ON CONFLICT (name) DO NOTHING;

-- صندوق الدعم: تذكرة دائمة واحدة لكل جهة اتصال
CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER UNIQUE NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'new',
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    category VARCHAR(50) NOT NULL DEFAULT 'general',
    subtitle_id INTEGER REFERENCES ticket_subtitles(id) ON DELETE SET NULL,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    unread_count INTEGER NOT NULL DEFAULT 0,
    next_follow_up_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_idea_number SMALLINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS subtitle_id INTEGER REFERENCES ticket_subtitles(id) ON DELETE SET NULL;
UPDATE tickets
SET subtitle_id = (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة')
WHERE subtitle_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_subtitle ON tickets (subtitle_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_inbox
    ON tickets (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee
    ON tickets (assigned_to, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_follow_up
    ON tickets (next_follow_up_at)
    WHERE next_follow_up_at IS NOT NULL;

-- الردود التي يرسلها موظفو الدعم من لوحة التحكم
CREATE TABLE IF NOT EXISTS support_messages (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    image_path TEXT,
    telegram_message_id BIGINT,
    broadcast_recipient_id INTEGER REFERENCES broadcast_recipients(id) ON DELETE SET NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS image_path TEXT;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS broadcast_recipient_id INTEGER REFERENCES broadcast_recipients(id) ON DELETE SET NULL;
-- لو الموظف عمل reply (quote) على رسالة معينة من الطالب، بنحتفظ بمرجعها هنا عشان نعرض اقتباسها
-- في واجهة المحادثة، وكمان بنبعتها فعليًا كـ reply حقيقي على تيليجرام (reply_parameters)
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS reply_to_incoming_message_id INTEGER REFERENCES incoming_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_sent
    ON support_messages (ticket_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_messages_broadcast_recipient
    ON support_messages (broadcast_recipient_id)
    WHERE broadcast_recipient_id IS NOT NULL;

-- تعديل/حذف ردود الموظفين — الحذف soft delete عشان يفضل في سجل للمراجعة
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_support_messages_active
    ON support_messages (ticket_id, sent_at)
    WHERE deleted_at IS NULL;

-- طابور رسالة الترحيب الموحدة (settings.welcome_message_text) — التذكرة والإسناد بالتبادل بيحصلوا
-- فورًا وقت أول Start، لكن الإرسال الفعلي على تيليجرام بيستنى لحد ما يدخل وقت العمل المحدد
-- (settings.working_hours_start/end)، فبيتسجّل هنا لحد ما جدولة welcomeMessageSender.js تبعته
CREATE TABLE IF NOT EXISTS pending_welcome_sends (
    contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pending_welcome_sends_created ON pending_welcome_sends (created_at);

-- اشتراكات إشعارات المتصفح (Web Push) لكل موظف — بتوصله إشعار على تليفونه حتى لو المتصفح مقفول
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

-- إنشاء تذاكر لجهات الاتصال اللي استلمت رسائل جماعية ناجحة قبل ما يكون عندها تذكرة أصلًا
-- (مثلاً طلاب دوسوا Start بس واحنا اللي بادرنا بمراسلتهم) — وإلا الرسالة تفضل من غير أي أثر في صندوق الدعم
INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, created_at, updated_at)
SELECT br.contact_id, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'),
  0, MAX(br.sent_at), MIN(br.sent_at), NOW()
FROM broadcast_recipients br
WHERE br.status = 'sent' AND br.sent_at IS NOT NULL
GROUP BY br.contact_id
ON CONFLICT (contact_id) DO NOTHING;

-- إظهار عمليات الإرسال الجماعي الناجحة القديمة داخل محادثات صندوق الدعم — بنستبدل كلمة "الاسم" بالاسم
-- الفعلي هنا كمان (زي ما بيحصل وقت الإرسال الحقيقي)، وإلا النص المحفوظ يفضل الـ Placeholder الخام.
-- بنفضّل اسم الطالب المسجّل على منصة طفرة (tafra_students.name) لأنه الاسم الحقيقي، وإلا بنرجع لبيانات
-- تيليجرام لو الطالب مش مرتبط بحساب على المنصة. LATERAL + LIMIT 1 لأن الفهرس على telegram_chat_id مش UNIQUE.
-- ملحوظة: الاستبدال ده بيغطي "الاسم" بس؛ لو broadcast قديم استخدم "اختبار"/"الدرجة" (سياق اختبار)،
-- النص المحفوظ هنا هيفضل خام لحد ما حد يصلحه يدويًا — حالة نادرة جدًا وقت الكتابة.
INSERT INTO support_messages
    (ticket_id, sent_by, content, image_path, broadcast_recipient_id, sent_at)
SELECT t.id, b.created_by,
  REPLACE(b.message_content, 'الاسم',
    COALESCE(
      NULLIF(split_part(trim(COALESCE(tafra_match.name, c.first_name, c.telegram_username, '')), ' ', 1), ''),
      'صديقنا'
    )),
  b.image_path, br.id, br.sent_at
FROM broadcast_recipients br
JOIN broadcasts b ON b.id = br.broadcast_id
JOIN tickets t ON t.contact_id = br.contact_id
JOIN contacts c ON c.id = br.contact_id
LEFT JOIN LATERAL (
  SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
) tafra_match ON true
WHERE br.status = 'sent' AND br.sent_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- ربط التذاكر القديمة غير المعيّنة بأول موظف أرسل ردًا يدويًا للعميل
UPDATE tickets t
SET assigned_to = first_human_reply.sent_by,
    updated_at = NOW()
FROM (
    SELECT DISTINCT ON (ticket_id) ticket_id, sent_by
    FROM support_messages
    WHERE sent_by IS NOT NULL AND broadcast_recipient_id IS NULL
    ORDER BY ticket_id, sent_at ASC, id ASC
) first_human_reply
WHERE t.id = first_human_reply.ticket_id
  AND t.assigned_to IS NULL;

-- يمنع تكرار رسالة تعريف نفس الموظف لنفس الطالب خلال اليوم
CREATE TABLE IF NOT EXISTS agent_contact_introductions (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    introduction_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticket_id, user_id, introduction_date)
);

-- سجل تتبع تقدم الطالب في الأفكار (idea progress tracking)
CREATE TABLE IF NOT EXISTS idea_progress_log (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    idea_number SMALLINT NOT NULL,
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idea_progress_log_ticket
    ON idea_progress_log (ticket_id, changed_at DESC);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS current_idea_number SMALLINT;

-- إنشاء تذاكر للرسائل القديمة الموجودة قبل إضافة صندوق الدعم
INSERT INTO tickets (contact_id, status, subtitle_id, unread_count, last_message_at, created_at, updated_at)
SELECT im.contact_id, 'new', (SELECT id FROM ticket_subtitles WHERE name = 'مطلوب المتابعة'),
  COUNT(*)::int, MAX(im.received_at), MIN(im.received_at), MAX(im.received_at)
FROM incoming_messages im
GROUP BY im.contact_id
ON CONFLICT (contact_id) DO NOTHING;

-- إعدادات عامة (key/value) — توكن البوت (مشفّر)، تفعيل الرد التلقائي، نص الرد التلقائي
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT
);

INSERT INTO settings (key, value) VALUES
    ('bot_token_encrypted', NULL),
    ('new_bot_token_encrypted', NULL),
    ('auto_reply_enabled', 'false'),
    ('auto_reply_message', 'شكرًا لتواصلك معنا، هنرد عليك في أقرب وقت.'),
    ('forwarding_enabled', 'false'),
    ('forward_chat_id', NULL),
    ('forward_chat_name', NULL),
    ('forward_setup_code', NULL),
    ('follow_up_auto_enabled', 'false'),
    ('follow_up_auto_message', 'ازيك يا الاسم، كنا متفقين نخلص رقم الفكرة النهارده. إيه الأخبار، طمّني خلصتها ولا لسه؟'),
    -- رسالة ثابتة تتبعت أول ما طالب جديد يضغط Start لأول مرة مطلقًا — كلمة "الاسم" بتتستبدل باسمه
    ('welcome_message_enabled', 'false'),
    ('welcome_message_text', 'أهلاً بيك يا الاسم! 👋 يسعدنا انضمامك، وهيتواصل معاك أحد فريقنا قريبًا.'),
    ('agent_intro_enabled', 'false'),
    ('agent_intro_message', 'السلام عليكم، معاكي "{name}" من منصة دكتور عبدالله حبشي.'),
    ('max_idea_number', '20'),
    ('tafra_identifier_encrypted', NULL),
    ('tafra_password_encrypted', NULL),
    ('tafra_auto_sync_interval_hours', '12'),
    ('working_hours_enabled', 'false'),
    ('working_hours_start', '09:00'),
    ('working_hours_end', '22:00'),
    ('outside_hours_reply_message', 'شكرًا لتواصلك معنا. مواعيد العمل من {start} إلى {end}، وهنرد عليك أول ما نرجع.'),
    -- آخر موظف اتاخدله دور في توزيع التذاكر الجديدة بالتبادل (دور بالتبادل حسب رقم الحساب)
    ('ticket_distribution_last_assigned_user_id', NULL)
ON CONFLICT (key) DO NOTHING;

-- نسخة محلية مقروءة فقط من طلاب منصة طفرة. لا تُرسل أي تعديلات إلى المنصة.
CREATE TABLE IF NOT EXISTS tafra_students (
    tafra_student_id BIGINT PRIMARY KEY,
    name VARCHAR(500),
    phone VARCHAR(100),
    parent_phone VARCHAR(100),
    status VARCHAR(100),
    rate VARCHAR(100),
    student_code VARCHAR(255),
    educational_level JSONB,
    telegram_linked BOOLEAN NOT NULL DEFAULT FALSE,
    telegram_username VARCHAR(255),
    telegram_chat_id BIGINT,
    registration_review_status VARCHAR(100),
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tafra_students_chat_id ON tafra_students (telegram_chat_id)
    WHERE telegram_chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tafra_students_phone ON tafra_students (phone);
-- نوع الطالب (ولد/بنت) متخمّن من اسمه على المنصة بالاعتماد على التسمية الشائعة في مصر (src/utils/genderInference.js)
-- — تخمين وليس بيانات مؤكدة من المنصة نفسها، وممكن يفضل NULL لو الاسم غامض أو أجنبي غير معروف
ALTER TABLE tafra_students ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_tafra_students_gender ON tafra_students (gender) WHERE gender IS NOT NULL;

-- الصف الدراسي المبسّط (1ث/2ث/3ث) — منصة طفرة بترجع نص حر غير موحّد في educational_level
-- (مثلاً "الصف الثالث الثانوي" و"تالتة ثانوي (ازهر)" لنفس الصف)، فبنستنتج منه الصف الموحّد تلقائيًا.
-- الحقل ده قابل للتعديل اليدوي من شاشة المتابعة التليفونية، والاستنتاج التلقائي بيحصل بس لو لسه NULL
-- (مايكتبش فوق أي تعديل يدوي) عشان الموظفين يقدروا يصححوه للطلاب اللي بيانات المنصة عندهم ناقصة.
ALTER TABLE tafra_students ADD COLUMN IF NOT EXISTS grade_level VARCHAR(4) CHECK (grade_level IN ('1ث', '2ث', '3ث'));

CREATE OR REPLACE FUNCTION tafra_derive_grade_level(level_text TEXT)
RETURNS VARCHAR AS $$
  SELECT CASE
    WHEN level_text IS NULL THEN NULL
    WHEN level_text ~* '(الثالث|تالتة|ثالثة)' THEN '3ث'
    WHEN level_text ~* '(الثاني|تانية|ثانية)' THEN '2ث'
    WHEN level_text ~* '(الأول|الاول|اولى|أولى)' THEN '1ث'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

UPDATE tafra_students SET grade_level = tafra_derive_grade_level(educational_level #>> '{}')
WHERE grade_level IS NULL;

CREATE TABLE IF NOT EXISTS tafra_sync_status (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status VARCHAR(30) NOT NULL DEFAULT 'never',
    total_students INTEGER NOT NULL DEFAULT 0,
    synced_students INTEGER NOT NULL DEFAULT 0,
    telegram_students INTEGER NOT NULL DEFAULT 0,
    current_page INTEGER NOT NULL DEFAULT 0,
    total_pages INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tafra_sync_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tafra_bootcamps (
    tafra_bootcamp_id BIGINT PRIMARY KEY,
    name VARCHAR(500) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_available BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE tafra_bootcamps ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS tafra_enrollments (
    tafra_bootcamp_id BIGINT NOT NULL REFERENCES tafra_bootcamps(tafra_bootcamp_id) ON DELETE CASCADE,
    tafra_student_id BIGINT NOT NULL,
    tafra_enrollment_id BIGINT,
    enrollment_type VARCHAR(30) NOT NULL DEFAULT 'enroll',
    enrolled_at TIMESTAMPTZ,
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tafra_bootcamp_id, tafra_student_id)
);
CREATE INDEX IF NOT EXISTS idx_tafra_enrollments_student ON tafra_enrollments (tafra_student_id);
CREATE INDEX IF NOT EXISTS idx_tafra_enrollments_date ON tafra_enrollments (enrolled_at);

CREATE TABLE IF NOT EXISTS tafra_enrollment_sync_status (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status VARCHAR(30) NOT NULL DEFAULT 'never',
    current_bootcamp INTEGER NOT NULL DEFAULT 0,
    total_bootcamps INTEGER NOT NULL DEFAULT 0,
    synced_enrollments INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tafra_enrollment_sync_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- تحديث اشتراكات أبواب معيّنة بس (مختارة يدويًا)، بدل تحديث كل بيانات المنصة أو كل الأبواب مرة واحدة
CREATE TABLE IF NOT EXISTS tafra_selective_sync_status (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status VARCHAR(30) NOT NULL DEFAULT 'never',
    current_bootcamp INTEGER NOT NULL DEFAULT 0,
    total_bootcamps INTEGER NOT NULL DEFAULT 0,
    synced_enrollments INTEGER NOT NULL DEFAULT 0,
    bootcamp_names TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tafra_selective_sync_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- أسماء الاختبارات (أونلاين وورقي) المسحوبة من منصة طفرة — مفهوم منفصل عن الأبواب/الكورسات
CREATE TABLE IF NOT EXISTS tafra_exams (
    exam_type VARCHAR(10) NOT NULL CHECK (exam_type IN ('online', 'offline')),
    tafra_exam_id BIGINT NOT NULL,
    name VARCHAR(500) NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (exam_type, tafra_exam_id)
);
-- اسم الكورس اللي الاختبار تابع له على منصة طفرة — متاح للاختبارات الأونلاين بس (القيد من المنصة نفسها)
ALTER TABLE tafra_exams ADD COLUMN IF NOT EXISTS bootcamp_name TEXT;

-- درجات الطلاب في كل اختبار — صف واحد لكل طالب لكل اختبار (آخر محاولة بالنسبة للأونلاين)
CREATE TABLE IF NOT EXISTS tafra_exam_marks (
    exam_type VARCHAR(10) NOT NULL,
    tafra_exam_id BIGINT NOT NULL,
    tafra_student_id BIGINT NOT NULL,
    mark NUMERIC,
    percentage NUMERIC,
    finished BOOLEAN,
    attempt_number INTEGER,
    taken_at TIMESTAMPTZ,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (exam_type, tafra_exam_id, tafra_student_id),
    FOREIGN KEY (exam_type, tafra_exam_id) REFERENCES tafra_exams (exam_type, tafra_exam_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tafra_exam_marks_student ON tafra_exam_marks (tafra_student_id);

CREATE TABLE IF NOT EXISTS tafra_exam_sync_status (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status VARCHAR(30) NOT NULL DEFAULT 'never',
    current_exam INTEGER NOT NULL DEFAULT 0,
    total_exams INTEGER NOT NULL DEFAULT 0,
    synced_marks INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO tafra_exam_sync_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- المتابعة التليفونية: إسناد الطلاب للموظفين وتسجيل نتائج المكالمات
-- ============================================================

-- نتائج المكالمات القابلة للتخصيص من لوحة التحكم (نفس فكرة ticket_subtitles)
CREATE TABLE IF NOT EXISTS call_outcomes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) UNIQUE NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO call_outcomes (name, sort_order) VALUES
    ('تم الرد', 1),
    ('لم يرد', 2),
    ('الخط مشغول', 3),
    ('رقم غير صحيح', 4),
    ('هيرجع يتصل لاحقًا', 5),
    ('مهتم', 6),
    ('غير مهتم', 7)
ON CONFLICT (name) DO NOTHING;

-- إسناد كل طالب لموظف مسؤول عن التواصل التليفوني معه — صف واحد لكل طالب، يفضل مسند
-- لحد ما حد يغيّره يدويًا (زي assigned_to في التذاكر، مفيش رجوع تلقائي لـ"غير مسند")
CREATE TABLE IF NOT EXISTS student_call_assignments (
    tafra_student_id BIGINT PRIMARY KEY REFERENCES tafra_students(tafra_student_id) ON DELETE CASCADE,
    assigned_to INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_call_assignments_assigned_to ON student_call_assignments (assigned_to);

-- سجل دائم لكل عملية إسناد/إلغاء إسناد — batch_id بيجمع الطلاب اللي اتأثروا بنفس العملية (فردية أو جماعية)
-- مع نسخة من الفلاتر اللي كانت مفعّلة وقتها، عشان أي عملية تفضل قابلة للمراجعة والرجوع إليها لاحقًا.
-- previous_assigned_to بيحفظ مين كان مسؤول عن الطالب قبل العملية، فالتاريخ الكامل يفضل واضح حتى لو حصل تعديل بالغلط.
CREATE TABLE IF NOT EXISTS call_assignment_log (
    id SERIAL PRIMARY KEY,
    batch_id UUID NOT NULL,
    tafra_student_id BIGINT NOT NULL REFERENCES tafra_students(tafra_student_id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK (action IN ('assign', 'unassign')),
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    previous_assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    filters JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_assignment_log_batch ON call_assignment_log (batch_id);
CREATE INDEX IF NOT EXISTS idx_call_assignment_log_student ON call_assignment_log (tafra_student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_assignment_log_created ON call_assignment_log (created_at DESC);

-- إسناد تلقائي بالتبادل لطلاب متابعة المكالمات — أي طالب جديد يشترك في الكورس المحدد وملوش إسناد
-- بيتوزع بالتبادل على الموظفين المختارين هنا (نفس فكرة التوزيع بالتبادل للتذاكر). قاعدة دائمة (مش
-- مرة واحدة)، والطالب المُسند مايتحركش تاني تلقائيًا مهما اتكرر تشغيل الجدولة (INSERT ... DO NOTHING)
CREATE TABLE IF NOT EXISTS call_auto_assign_config (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    bootcamp_id BIGINT REFERENCES tafra_bootcamps(tafra_bootcamp_id) ON DELETE SET NULL,
    employee_ids INTEGER[] NOT NULL DEFAULT '{}',
    last_assigned_user_id INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO call_auto_assign_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- سمحنا باختيار أكتر من كورس مستهدف مرة واحدة (بدل كورس واحد بس) — bootcamp_id القديم متسيّب
-- من غير استخدام (مش محذوف) عشان نتفادى DROP COLUMN، وبيانه بتترحّل مرة واحدة هنا لحد ما تتصفر
ALTER TABLE call_auto_assign_config ADD COLUMN IF NOT EXISTS bootcamp_ids BIGINT[] NOT NULL DEFAULT '{}';
UPDATE call_auto_assign_config SET bootcamp_ids = ARRAY[bootcamp_id]
  WHERE bootcamp_id IS NOT NULL AND bootcamp_ids = '{}';

-- سجل نتائج المكالمات — كل مكالمة صف مستقل، يبني عليه بروفايل الطالب بالكامل
CREATE TABLE IF NOT EXISTS call_logs (
    id SERIAL PRIMARY KEY,
    tafra_student_id BIGINT NOT NULL REFERENCES tafra_students(tafra_student_id) ON DELETE CASCADE,
    called_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    outcome_id INTEGER REFERENCES call_outcomes(id) ON DELETE SET NULL,
    notes TEXT,
    next_follow_up_at TIMESTAMPTZ,
    called_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_logs_student ON call_logs (tafra_student_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_follow_up ON call_logs (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

-- تحويل التوكن القديم تلقائيًا إلى أول ملف بوت محفوظ عند ترقية مشروع قائم
INSERT INTO bot_profiles (label, token_encrypted, is_active, activated_at)
SELECT 'البوت الحالي', value, TRUE, NOW()
FROM settings
WHERE key = 'bot_token_encrypted' AND value IS NOT NULL AND value <> ''
  AND NOT EXISTS (SELECT 1 FROM bot_profiles)
ON CONFLICT DO NOTHING;
