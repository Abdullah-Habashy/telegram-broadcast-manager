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
CREATE INDEX IF NOT EXISTS idx_incoming_messages_contact_received
    ON incoming_messages (contact_id, received_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_sent
    ON support_messages (ticket_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_messages_broadcast_recipient
    ON support_messages (broadcast_recipient_id)
    WHERE broadcast_recipient_id IS NOT NULL;

-- إظهار عمليات الإرسال الجماعي الناجحة القديمة داخل محادثات صندوق الدعم
INSERT INTO support_messages
    (ticket_id, sent_by, content, image_path, broadcast_recipient_id, sent_at)
SELECT t.id, b.created_by, b.message_content, b.image_path, br.id, br.sent_at
FROM broadcast_recipients br
JOIN broadcasts b ON b.id = br.broadcast_id
JOIN tickets t ON t.contact_id = br.contact_id
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
    ('auto_reply_enabled', 'false'),
    ('auto_reply_message', 'شكرًا لتواصلك معنا، هنرد عليك في أقرب وقت.'),
    ('forwarding_enabled', 'false'),
    ('forward_chat_id', NULL),
    ('forward_chat_name', NULL),
    ('forward_setup_code', NULL),
    ('follow_up_auto_enabled', 'false'),
    ('follow_up_auto_message', 'مرحبًا، نذكّرك بموعد المتابعة. يسعدنا معرفة إذا كنت تحتاج إلى أي مساعدة إضافية.'),
    ('agent_intro_enabled', 'false'),
    ('agent_intro_message', 'السلام عليكم، معاكي "{name}" من منصة دكتور عبدالله حبشي.'),
    ('max_idea_number', '20'),
    ('tafra_identifier_encrypted', NULL),
    ('tafra_password_encrypted', NULL)
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

-- تحويل التوكن القديم تلقائيًا إلى أول ملف بوت محفوظ عند ترقية مشروع قائم
INSERT INTO bot_profiles (label, token_encrypted, is_active, activated_at)
SELECT 'البوت الحالي', value, TRUE, NOW()
FROM settings
WHERE key = 'bot_token_encrypted' AND value IS NOT NULL AND value <> ''
  AND NOT EXISTS (SELECT 1 FROM bot_profiles)
ON CONFLICT DO NOTHING;
