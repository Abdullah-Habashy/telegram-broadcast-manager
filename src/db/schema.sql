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

-- تيم الموظف المتخصص: NULL معناها موظف متابعة عادي، و'science' أو 'tech' معناها إنه بيستقبل
-- التذاكر المحوّلة لتيمه بس. **التيمات المتخصصة مستثناة من التوزيع التلقائي للتذاكر الجديدة**
-- (utils/ticketAssignment.js) — سارين مختلفين وموظفين مختلفين، فلو دخلوا الدور العادي كانوا
-- هيلاقوا نفسهم مسؤولين عن متابعة طلاب مالهاش علاقة بشغلهم.
--
-- عمود واحد بقيمة بدل راية لكل تيم: إضافة تيم تالت بقت صف في TEAMS جوه الكود مش عمود جديد
-- في القاعدة وهجرة ومسار وزرار
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_science_team BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS team VARCHAR(20);
-- نقل الرايات القديمة للعمود الجديد. الشرط بيخلّيها تنفّذ مرة واحدة فعليًا
UPDATE users SET team = 'science' WHERE is_science_team AND team IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_team ON users (team) WHERE team IS NOT NULL;
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

-- علامة "عاجل" جنب اسم الطالب. متخزّنة على الجهتين لأن ولا واحدة بتغطي كل الحالات: 498 طالب
-- في المتابعة مالهمش صف في contacts (مش مرتبطين بتليجرام)، وفيه تذاكر لأشخاص مش طلاب منصة.
-- التبديل بيكتب على الاتنين لو الربط موجود، والقراءة OR بينهم — فهي علامة واحدة منطقيًا
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT FALSE;

-- إمتى بعتنا لجهة الاتصال دي طلب مشاركة الرقم. **بيتسجّل عشان نسأل مرة واحدة بس** — الطالب
-- اللي مايشاركش رقمه مش عايز يشاركه، وتكرار الطلب كل رسالة بيتحوّل لمضايقة
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_request_sent_at TIMESTAMPTZ;

-- نص مخصّص لرسالة المتابعة التلقائية القادمة لهذه التذكرة وحدها. فاضي = استخدم القالب العام
-- من الإعدادات. بيتمسح بعد الإرسال عشان يفضل "الرسالة القادمة" مش قالب دائم للطالب ده
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS next_follow_up_message TEXT;
ALTER TABLE tafra_students ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_contacts_urgent ON contacts (is_urgent) WHERE is_urgent;
CREATE INDEX IF NOT EXISTS idx_tafra_students_urgent ON tafra_students (is_urgent) WHERE is_urgent;

-- طلاب بدأوا محادثة مع "بوت طفرة" (بوت منفصل تمامًا، شغّال بالتوازي مع بوت المتابعة).
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
-- بوت طفرة هو نفسه بوت منصة طفرة الرسمي، فكتير من الطلاب أصلاً ضغطوا Start عليه قبل ما نضيف
-- الهاندلر بتاعنا إحنا — started_at بقى اختياري لأننا مش عارفين تاريخ البدء الحقيقي بتاعهم،
-- وsource بيفرّق بين "start" (ضغط Start فعليًا على الهاندلر بتاعنا) و"platform_link" (اتأكد إنه
-- قابل للمراسلة عن طريق فحص getChat، مش من ضغطه Start عندنا)
ALTER TABLE new_bot_contacts ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE new_bot_contacts ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'start';
-- آخر مرة اتبعتله رسالة جماعية عن طريق بوت طفرة نفسه — يُستخدم في فلتر "استبعاد من أُرسل له اليوم"
ALTER TABLE new_bot_contacts ADD COLUMN IF NOT EXISTS last_broadcast_at TIMESTAMPTZ;

-- حالة فحص "الوصول الفعلي" لطلاب طفرة المرتبطين على بوت طفرة (اللي لسه مش مسجّلين في new_bot_contacts)
CREATE TABLE IF NOT EXISTS new_bot_reachability_sync_status (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    status VARCHAR(30) NOT NULL DEFAULT 'never',
    checked_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    found_reachable INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO new_bot_reachability_sync_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

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

-- الرسالة اللي الطالب عمل عليها Reply في تليجرام. بنخزّن رقم تليجرام الخام مش مفتاح داخلي، لأن
-- الطالب ممكن يرد على أي حاجة في الشات: رسالة بعتها موظف، أو رسالة حملة جماعية، أو رسالة هو
-- نفسه بعتها قبل كده — ولو ربطناها بجدول واحد بمفتاح أجنبي كنا هنضطر نرمي الحالات التانية.
-- الربط بيتم وقت العرض بمطابقة telegram_message_id في الجدولين، والرقم الخام بيفضل محفوظ حتى
-- لو الرسالة الأصلية مش عندنا (رسايل قديمة اتبعتت قبل ما نسجّل أرقامها)
ALTER TABLE incoming_messages ADD COLUMN IF NOT EXISTS reply_to_telegram_message_id BIGINT;

-- أرقام تليجرام فريدة داخل الشات الواحد مش عالميًا، فالمطابقة لازم تبقى مقيّدة بالتذكرة/جهة
-- الاتصال. الفهرسين دول بيخلّوا البحث عن الرسالة الأصلية وقت العرض lookup مش scan
CREATE INDEX IF NOT EXISTS idx_support_messages_telegram
    ON support_messages (ticket_id, telegram_message_id)
    WHERE telegram_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incoming_messages_telegram
    ON incoming_messages (contact_id, telegram_message_id)
    WHERE telegram_message_id IS NOT NULL;
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

-- آخر مرة اتنبّه فيها الموظف إن التذكرة دي عليها رسالة واردة من غير رد. بيتقارن بميعاد آخر
-- رسالة واردة مش بـ NOW()، عشان التنبيه يتبعت مرة واحدة لكل رسالة مهملة: لو الطالب بعت تاني
-- وفضل من غير رد، بيتنبّه تاني؛ ولو مبعتش، مايفضلش ينق كل ساعة على نفس الحاجة
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS unanswered_alert_at TIMESTAMPTZ;

-- تحويل التذكرة للتيم العلمي. assigned_to **مابيتغيّرش**: موظف المتابعة بيفضل صاحب التذكرة
-- وشايف كل الرسايل وعنده زرار التحويل طول الوقت، والعمود ده بيزوّد موظف تاني مؤقتًا بدل ما
-- ينقل الملكية. عشان كده مفيش أي استعلام قائم اتأثر بالميزة دي
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS science_agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS science_since TIMESTAMPTZ;
-- الأعمدة العامة اللي حلّت محل science_* لما التحويل بقى لأكتر من تيم. transfer_team بيقول
-- التذكرة مع أنهي تيم دلوقتي، وده اللي بيحدد اللون والزرار ومين بيشوفها
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transfer_team VARCHAR(20);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transfer_agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS transfer_since TIMESTAMPTZ;
UPDATE tickets SET transfer_team = 'science', transfer_agent_id = science_agent_id,
                   transfer_since = science_since
 WHERE science_agent_id IS NOT NULL AND transfer_agent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_transfer_agent
    ON tickets (transfer_agent_id, last_message_at DESC)
    WHERE transfer_agent_id IS NOT NULL;

-- توحيد علامة "عاجل" مع أولوية التذكرة. الاتنين كانوا حقلين منفصلين بنفس المعنى عند المستخدم،
-- فمحادثة موسومة 🚨 مكانتش بتطلع في فلتر "الأولويات: عاجلة" خالص. من هنا ورايح الكتابة على
-- الاتنين مربوطة في الكود (src/utils/urgentFlag.js و updateTicket)، والجُمل دي بتلحّق الصفوف
-- القديمة اللي اتوسمت قبل الربط. الشرط في كل جملة بيخليها تنفّذ مرة واحدة فعليًا: بعد أول
-- تطبيق مافيش صفوف مطابقة، فإعادة تشغيل migrate مابتعملش حاجة
UPDATE tickets t SET priority = 'urgent'
FROM contacts c
WHERE c.id = t.contact_id AND c.is_urgent AND t.priority <> 'urgent';

UPDATE contacts c SET is_urgent = TRUE
FROM tickets t
WHERE t.contact_id = c.id AND t.priority = 'urgent' AND NOT c.is_urgent;

UPDATE tafra_students s SET is_urgent = TRUE
FROM contacts c
WHERE c.chat_id = s.telegram_chat_id AND c.is_urgent AND NOT s.is_urgent;

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
-- علامة صريحة على "رد أول دخول" (رسالة الترحيب). من غيرها الطريقة الوحيدة لمعرفتها كانت مطابقة نص
-- الرسالة بقالب الترحيب الحالي — وده بيقع أول ما الأدمن يغيّر صيغة الترحيب، فالرسايل اللي اتبعتت
-- بالصيغة القديمة تبقى مش متعرّف عليها. من هنا ورايح البوت هو اللي بيعلّمها وقت الإرسال.
-- مسار الرسالة الصوتية اللي الموظف سجّلها وبعتها للطالب. عمود منفصل عن image_path عشان
-- العرض يعرف يفرّق: الصورة بتتعرض <img> والصوت <audio controls>، والاتنين ممكن يبقوا فاضيين
-- (رسالة نصية عادية). الاتجاه ده واحد بس — الطالب مابيبعتش صوت، بيتردّ عليه يبعت مكتوب أو صورة
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS voice_path TEXT;

ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_welcome BOOLEAN NOT NULL DEFAULT FALSE;
-- ترحيل لمرة واحدة للرسايل اللي اتبعتت قبل وجود العمود. الرسايل التلقائية (sent_by IS NULL) نوعين بس:
-- رد أول دخول، ورسايل المتابعة التلقائية — فبنعلّم الأول وبنستثني التاني صراحةً.
UPDATE support_messages sm
SET is_welcome = TRUE
WHERE sm.is_welcome = FALSE
  AND sm.sent_by IS NULL
  AND sm.broadcast_recipient_id IS NULL
  -- حد زمني ثابت: العمود اتضاف يوم 2026-08-17، ومن ساعتها البوت بيعلّم الترحيب بنفسه وقت
  -- الإرسال. فالترحيل ده مالوش شغل إلا بالرسايل الأقدم منه.
  --
  -- من غير الحد ده الترحيل بيفضل يشتغل على رسايل جديدة في كل migrate، وبيتعرّف على المتابعة
  -- بمطابقة نصها — يعني أول ما حد يغيّر قالب المتابعة من الإعدادات، أو يكتب متابعة مخصّصة
  -- لتذكرة، الرسالة مابتطابقش وبتتعلّم "ترحيب" غلط. اتقاس على الإنتاج قبل الإصلاح: ٦٠ متابعة
  -- مخصّصة كانت مترشّحة للقلب الغلط في أول migrate جاي.
  AND sm.sent_at < '2026-08-17'::timestamptz
  -- الاستثناءات النصية باقية للرسايل اللي قبل الحد — الصيغتين دول هما اللي كانوا مستخدمين وقتها
  AND sm.content NOT LIKE '%نذكّرك بموعد المتابعة%'
  AND sm.content NOT LIKE '%كنا متفقين نخلص%';
CREATE INDEX IF NOT EXISTS idx_support_messages_welcome
    ON support_messages (ticket_id) WHERE is_welcome AND deleted_at IS NULL;

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

-- حضور وانصراف التيم العلمي. الصف المفتوح (ended_at فاضي) معناه إن الموظف حاضر دلوقتي،
-- والصفوف المقفولة بتفضل كسجل للحضور. التوزيع بيختار من الحاضرين بس — وده معنى إن الموظف
-- "يشتغل" على النظام ده: مايتحوّلوش تذاكر وهو مش موجود
CREATE TABLE IF NOT EXISTS science_attendance (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);
-- فهرس جزئي فريد: مستحيل يبقى للموظف الواحد أكتر من وردية مفتوحة في نفس الوقت، حتى لو
-- اتضغط زرار الحضور مرتين بسرعة أو من تبويبين
CREATE UNIQUE INDEX IF NOT EXISTS idx_science_attendance_open
    ON science_attendance (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_science_attendance_user_time
    ON science_attendance (user_id, started_at DESC);
-- الجدول بقى بيخدم كل التيمات المتخصصة مش العلمي بس. الاسم القديم كان هيكدب على اللي يقراه،
-- والتغيير ده إعادة تسمية مش حذف — البيانات كلها بتتنقل معاها. الحارس بيخلّيها تنفّذ مرة واحدة
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'science_attendance')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'team_attendance')
  THEN
    ALTER TABLE science_attendance RENAME TO team_attendance;
  END IF;
END $$;
-- التيم بيتسجّل مع الوردية عشان سجل الحضور يفضل مقروء لو الموظف اتنقل بين التيمات
ALTER TABLE team_attendance ADD COLUMN IF NOT EXISTS team VARCHAR(20);
UPDATE team_attendance SET team = 'science' WHERE team IS NULL;

-- ---------- الردود الجاهزة ----------
-- نصوص بيستخدمها الموظف كتير. الضغط بيحطها في مربع الرد **مش بيبعتها** — الموظف بيعدّل
-- عليها الأول (اسم الطالب، تفصيلة في السؤال) وبعدين يبعت. الإرسال المباشر كان هيخلّي أي
-- دوسة غلط رسالة راحت للطالب
CREATE TABLE IF NOT EXISTS quick_replies (
    id SERIAL PRIMARY KEY,
    title VARCHAR(120) NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_order ON quick_replies (sort_order, id) WHERE is_active;
-- صاحب الرد: NULL معناها رد عام يشوفه كل الفريق (الأدمن بيضيفه)، والرقم معناه رد شخصي
-- للموظف ده وحده. الموظف بيشوف بتوعه + العامة، وبيعدّل في بتوعه بس — عشان حد مايمسحش
-- ردود زميله، والأدمن مايتحملش إدارة اختصارات كل واحد
ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_quick_replies_user ON quick_replies (user_id) WHERE user_id IS NOT NULL;

-- ---------- قاعدة معرفة الرد الآلي ----------
-- المصدر الوحيد اللي النموذج مسموح له يجاوب منه. مش "تدريب": المحتوى بيتبعت مع كل سؤال
-- وبيتقري لحظتها، فتعديل أي صف هنا بيطبّق فورًا من غير إعادة تدريب ولا نشر.
--
-- الصفوف المعطّلة (is_active = FALSE) بتتشال من السياق فورًا — الطريقة السريعة لسحب معلومة
-- غلط من غير ما تحذفها وتفقد نصّها
CREATE TABLE IF NOT EXISTS ai_knowledge (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_active ON ai_knowledge (id) WHERE is_active;
-- منين جت المعلومة: manual (اتكتبت بالإيد) · chat (اتحصدت من محادثة تجريبية) · file (من ملف
-- مرفوع). مهم عند المراجعة: المعلومة اللي النموذج اقترحها من محادثة تستاهل نظرة تانية أكتر
-- من اللي الأدمن كتبها بنفسه
ALTER TABLE ai_knowledge ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';

-- سجل كل نداء للنموذج: السؤال، الرد، اتبعت ولا لأ والسبب. من غيره مفيش طريقة تعرف بيها
-- النموذج بيرفض ليه، ولا تراجع صح إيه اللي اتقال للطلاب وانت نايم
CREATE TABLE IF NOT EXISTS ai_reply_log (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    incoming_message_id INTEGER REFERENCES incoming_messages(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    answer TEXT,
    -- sent · no_answer (مش في المصدر) · blocked (موضوع ممنوع) · error
    outcome VARCHAR(20) NOT NULL,
    detail TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_reply_log_time ON ai_reply_log (created_at DESC);
-- توكنز الكاش: قراءة بعُشر السعر، وكتابة بمرة وربع. من غير تسجيلهم مفيش طريقة تعرف بيها
-- التكلفة الحقيقية ولا نسبة إصابة الكاش — والتقدير هنا بيفرق أضعاف
ALTER TABLE ai_reply_log ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
ALTER TABLE ai_reply_log ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
-- أي مزوّد رد — من غيره مفيش طريقة تقارن أداء المجاني بالمدفوع على بيانات حقيقية
ALTER TABLE ai_reply_log ADD COLUMN IF NOT EXISTS provider VARCHAR(20);

-- علامة إن الرسالة دي مولّدة آليًا — الموظف لازم يفرّقها عن كلام زمايله وهو بيراجع الصبح
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO settings (key, value) VALUES
    ('bot_token_encrypted', NULL),
    ('new_bot_token_encrypted', NULL),
    ('auto_reply_enabled', 'false'),
    ('auto_reply_message', 'شكرًا لتواصلك معنا، هنرد عليك في أقرب وقت.'),
    -- بتتبعت للطالب لما موظف المتابعة يحاول يحوّل سؤاله للتيم العلمي ومفيش حد منهم مسجّل حضور
    ('science_offline_message', 'فريق الأسئلة العلمية مش متاح دلوقتي 🧪
ابعت سؤالك تاني في مواعيد العمل من ١٠ صباحًا لحد ١٢ بالليل وهنجاوبك على طول.'),
    -- بتتبعت للطالب لما يبعت فيديو أو رسالة صوتية — البوت مابيقراش الوسائط دي، والرسالة دي
    -- بتخلّيه يعيد السؤال بصيغة الموظف يقدر يشوفها
    ('tech_offline_message', 'فريق الدعم الفني مش متاح دلوقتي 🛠️
ابعت مشكلتك تاني في مواعيد العمل من ١٠ صباحًا لحد ١٢ بالليل وهنحلّها على طول.'),
    -- الرد الآلي بالذكاء الصناعي — مقفول لحد ما الأدمن يشغّله بعد ما يملا قاعدة المعرفة
    ('ai_reply_enabled', 'false'),
    -- المزوّد المستخدم فعليًا: anthropic (مدفوع وأدق) أو groq (مجاني). التبديل من اللوحة
    ('ai_provider', 'anthropic'),
    -- تعليمات عامة للسلوك: نبرة، ترتيب الكلام، أسئلة توضيحية. **مش معلومات** — المعلومات
    -- مكانها ai_knowledge. التعليمات دي بتتحط في السياق تحت القواعد الصارمة ومابتلغيهاش:
    -- تعليمة زي "وضّحله طرق الاشتراك" مابتخليش النموذج يخترعها لو مش في المصدر
    ('ai_general_instructions', ''),
    -- بيتحط في أول كل رد آلي. الطالب لازم يعرف إنه بيكلم آلة مش موظف
    ('ai_reply_prefix', '🤖 رد آلي — لو محتاج حاجة تانية سيبها وهيرد عليك الفريق في مواعيد العمل.'),
    -- مواضيع النموذج ممنوع يقربها مهما كان اللي في قاعدة المعرفة: فلوس، استرداد، شكاوى،
    -- وأي حاجة نفسية. الرسالة بتروح للموظف زي ما هي بدون أي محاولة رد
    ('ai_blocked_topics', 'استرداد الفلوس، الخصومات، الشكاوى من موظف، أي حاجة نفسية أو صحية، الوعود بمواعيد أو نتائج امتحانات'),
    ('media_not_supported_message', 'معلش، مش بنقدر نستقبل صوت أو فيديو هنا 🙏
ابعت سؤالك مكتوب أو صورة وهنجاوبك على طول.'),
    -- رابط المنصة اللي زرار "ابدأ الدرس الجاي" في تقرير الطالب بيوّدي له. متاخد من الروابط
    -- اللي الفريق فعلًا بيبعتها للطلاب في المحادثات. لو اتفضّى، الزرار بيتحوّل لاسم الدرس
    -- من غير رابط — معلومة مفيدة بدل زرار مكسور
    -- طلب مشاركة الرقم من الطلاب اللي البوت مايعرفهمش. تيليجرام مابيدّيناش الرقم عند /start،
    -- فالطالب اللي ما ربطش تيليجرام على المنصة بيفضل مجهول مهما كلّمنا — واسمه المعروض
    -- ممكن يكون لقب أو إيموجي. الزرار بيحلّها بضغطة واحدة من غير كتابة
    ('phone_request_enabled', 'true'),
    ('phone_request_message', 'عشان نقدر نتابعك صح ونطلّعلك تقريرك، محتاجين نعرف حسابك على المنصة 🙌
اضغط الزرار تحت وهيتبعت رقمك تلقائيًا — مش هتكتب حاجة.'),
    ('platform_url', 'https://abdullah-habashy.com'),
    ('forwarding_enabled', 'false'),
    ('forward_chat_id', NULL),
    ('forward_chat_name', NULL),
    ('forward_setup_code', NULL),
    ('follow_up_auto_enabled', 'false'),
    ('follow_up_auto_message', 'ازيك يا الاسم، إيه الأخبار؟ طمّني على رقم الفكرة، خلصتها ولا لسه؟'),
    -- رسالة ثابتة تتبعت أول ما طالب جديد يضغط Start لأول مرة مطلقًا — كلمة "الاسم" بتتستبدل باسمه
    ('welcome_message_enabled', 'false'),
    ('welcome_message_text', 'أهلاً بيك يا الاسم! 👋 يسعدنا انضمامك، وهيتواصل معاك أحد فريقنا قريبًا.'),
    -- رد فوري للطالب اللي يدخل البوت خارج مواعيد العمل. رسالة الترحيب نفسها بتستنى الوقت المسموح،
    -- فالطالب كان بيقعد لحد الصبح من غير أي رد — وده اللي الرد ده بيغطيه. {when} بتتستبدل بأول
    -- موعد فتح جاي بصيغة مقروءة ("بكرة الساعة ٩:٠٠ صباحًا")، و"الاسم" باسم الطالب
    ('outside_hours_ack_enabled', 'false'),
    ('outside_hours_ack_text', 'أهلاً بيك يا الاسم! ✅ تم تسجيلك بنجاح.

إحنا خارج مواعيد العمل حاليًا، وفريق المتابعة هيتواصل معاك {when} — في انتظارك 🌷'),
    -- قالب رسالة SMS للطالب اللي مردّش على المكالمة. الزرار في بروفايل المتابعة التليفونية بيفتح
    -- تطبيق الرسائل على تليفون الموظف والنص جاهز — مفيش إرسال من السيرفر، فمفيش مزوّد ولا تكلفة.
    -- كلمة "الاسم" بتتستبدل بالاسم الأول للطالب
    ('sms_template_enabled', 'false'),
    ('sms_template_text', 'أهلاً يا الاسم، معاك فريق متابعة د. عبدالله حبشي. حاولنا نتصل بيك ومعرفناش نوصلك. لو تحب نكلمك في وقت تاني ابعتلنا رد على الرسالة دي.'),
    ('agent_intro_enabled', 'false'),
    ('agent_intro_message', 'السلام عليكم، معاكي "{name}" من منصة دكتور عبدالله حبشي.'),
    ('max_idea_number', '20'),
    ('tafra_identifier_encrypted', NULL),
    ('tafra_password_encrypted', NULL),
    ('tafra_auto_sync_interval_hours', '12'),
    -- مزامنة الاختبارات والدرجات منفصلة عن مزامنة الطلاب بفاصل زمني خاص بيها: بتاخد وقت أطول
    -- بكتير (حوالي 17 دقيقة لـ 31 اختبار) وبتضرب على API طفرة بكثافة، فمش منطقي تمشي بنفس وتيرة
    -- تحديث بيانات الطلاب الخفيف
    ('tafra_exam_auto_sync_interval_hours', '12'),
    -- **مزامنة الاشتراكات مكانتش مجدولة خالص** — كانت بتتشغّل بإيد الموظف بس، فالبيانات
    -- بتقعد أيام قديمة، والطالب اللي اشترك امبارح يفضل "مش مشترك" ويتحوّل لموظف الواتساب
    -- غلط (jobs/whatsappRouting.js بيعتمد عليها كل ٥ دقايق).
    -- ٦ ساعات مش ١٢ زي التانيين: دي أخف مزامنة (٦ دقايق لـ١٠ أبواب و٧٤٥٧ اشتراك)، وهي
    -- اللي بيتبني عليها قرار توجيه بيشوفه الطالب
    ('tafra_enrollment_auto_sync_interval_hours', '6'),
    ('working_hours_enabled', 'false'),
    -- **النهاية '00:00' مش خطأ.** التحقق بيقبل 00:00 لحد 23:59 بس، و'24:00' مرفوضة. لما
    -- البداية أكبر من النهاية، isWithinWorkingHours بيتعامل معاها كنطاق بيعدّي منتصف الليل:
    -- (now >= '10:00' OR now < '00:00') — والشق التاني مستحيل يتحقق، فالنتيجة ١٠ صباحًا لحد
    -- ١١:٥٩ بالليل بالظبط، وهو المقصود بـ"لحد ١٢ بالليل"
    ('working_hours_start', '10:00'),
    ('working_hours_end', '00:00'),
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

-- **فهرس على آخر ١٠ أرقام من التليفون — مش على التليفون نفسه.**
-- تلات مسارات بتدوّر بيه: دخول الطالب للاختبار، وربط الرقم من البوت، وتقرير الطالب.
-- وكلهم بيستخدموا نفس التعبير (utils/phone.js → SQL_TRANSLATE_DIGITS) لأن الرقم متخزّن
-- على المنصة بأشكال مختلفة (+٢٠، ٠٠٢٠، بأرقام عربية أو فارسية).
--
-- الفهرس العادي على (phone) **مابينفعش معاهم**: الشرط على ناتج دالة مش على العمود، فالخطة
-- بتبقى Seq Scan. اتقاس على الإنتاج: **١٢٥ مللي لكل بحث على ٢٤٦٠٤ طالب** — يعني نص ثانية
-- على ١٠٠ ألف، لكل طالب بيدخل الاختبار. امتحان بآلاف الطلاب في نفس الساعة معناه إن
-- بوابة الدخول لوحدها بتاكل السيرفر.
--
-- التعبير هنا لازم يطابق الاستعلامات **حرف بحرف** — أي فرق في قايمة الأرقام المترجمة
-- بيخلي الفهرس موجود ومش مستخدم، وده أسوأ من إنه مش موجود لأنه بيبان في القايمة
CREATE INDEX IF NOT EXISTS idx_tafra_students_phone_last10
    ON tafra_students (RIGHT(REGEXP_REPLACE(translate(phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 10));
-- نوع الطالب (ولد/بنت) متخمّن من اسمه على المنصة بالاعتماد على التسمية الشائعة في مصر (src/utils/genderInference.js)
-- — تخمين وليس بيانات مؤكدة من المنصة نفسها، وممكن يفضل NULL لو الاسم غامض أو أجنبي غير معروف
ALTER TABLE tafra_students ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_tafra_students_gender ON tafra_students (gender) WHERE gender IS NOT NULL;

-- توكن صفحة تقرير الطالب — رابط عام (/r/<token>) يفتحه ولي الأمر أو الطالب من غير تسجيل دخول.
-- ٣٢ بايت عشوائية كـ hex فمافيش تخمين، وواحد لكل طالب. التجديد بيكتب توكن جديد فوق القديم،
-- فالرابط اللي اتشارك قبل كده بيموت فورًا — دي الطريقة الوحيدة لقفل رابط اتسرّب.
-- NULL معناها مفيش رابط اتعمل (أو اتلغى)، والصفحة وقتها بترد ٤٠٤
ALTER TABLE tafra_students ADD COLUMN IF NOT EXISTS report_token VARCHAR(64);
ALTER TABLE tafra_students ADD COLUMN IF NOT EXISTS report_token_created_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tafra_students_report_token
    ON tafra_students (report_token) WHERE report_token IS NOT NULL;

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
-- كتالوج دروس كل كورس — إجابة سؤال "الكورس ده فيه كام فيديو وبكام دقيقة؟".
--
-- المنصة مافيهاش نقطة بترجّع محتوى الكورس: /online-lessons بترجّع كل دروس المادة (الكيمياء
-- كلها) من غير أي ربط بالكورس، و bootcamps/:id.duration_in_seconds طلعت مدة إتاحة مش مجموع
-- الفيديوهات (٢٤٣١ دقيقة لكورس دروسه الحقيقية ٩٨١). الربط الوحيد المتاح بين الدرس والكورس
-- موجود في سجل المشاهدات، فبنبني الكتالوج منه: بنمسح مشاهدات الكورس (كل الطلاب مش طالب واحد)
-- ونجمع أسماء الدروس ومددها. الاتحاد ده بيستقر بسرعة — كورس الباب الأول وصل ٤٠ درس بعد ١٥
-- صفحة وفضل ثابت لحد ٦٠.
--
-- ليه محتاجينه: سجل مشاهدات الطالب الواحد بيرجّع الدروس اللي **هو** فتحها بس، فالطالب اللي
-- فتح ٩ فيديو كان تقريره بيقول "٩ من ٩" يعني ١٠٠% وهو لسه في أول الكورس
CREATE TABLE IF NOT EXISTS tafra_bootcamp_lessons (
    tafra_bootcamp_id BIGINT NOT NULL REFERENCES tafra_bootcamps(tafra_bootcamp_id) ON DELETE CASCADE,
    lesson_name TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    is_video BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tafra_bootcamp_id, lesson_name)
);
CREATE INDEX IF NOT EXISTS idx_tafra_bootcamp_lessons_video
    ON tafra_bootcamp_lessons (tafra_bootcamp_id) WHERE is_video;
-- معرّف الدرس على المنصة — أساس ترتيب الفيديوهات في التقرير بنفس ترتيب الكورس.
-- سجل المشاهدات مابيسمحش بترتيب غير viewed_at، لكن /online-lessons بيدّي id لكل درس والترتيب
-- التصاعدي بيطلع ترتيب الكورس بالظبط (شرح فكرة ١ ← حل اختبار فكرة ١ ← شرح فكرة ٢ ...).
-- بيفضل NULL للدرس اللي اسمه مااتلاقاش في القايمة، وساعتها بيتعرض في الآخر
ALTER TABLE tafra_bootcamp_lessons ADD COLUMN IF NOT EXISTS platform_lesson_id INTEGER;

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

-- سجل رسايل SMS اللي الموظف بعتها للطالب. جدول منفصل عن call_logs عن قصد: فلاتر نتيجة المكالمة
-- و"معرفناش نوصله" بتعدّ صفوف call_logs، فأي صف SMS جواه كان هيفسد حسابها. النص بيتخزن نسخة
-- مستقلة (مش إشارة للقالب) عشان السجل يفضل صحيح لو الأدمن عدّل القالب بعد كده.
-- ملحوظة: ده بيسجّل إن الموظف ضغط الزرار وتطبيق الرسائل اتفتح بالنص ده — تليجرام مش في الصورة
-- وإحنا مش بنبعت من السيرفر، فمفيش تأكيد توصيل من شبكة المحمول
CREATE TABLE IF NOT EXISTS sms_logs (
    id SERIAL PRIMARY KEY,
    tafra_student_id BIGINT NOT NULL REFERENCES tafra_students(tafra_student_id) ON DELETE CASCADE,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    phone VARCHAR(20) NOT NULL,
    body TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_logs_student ON sms_logs (tafra_student_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_follow_up ON call_logs (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;



-- نموذج تصحيح الأسئلة المقالية. **منفصل عن ai_provider بتاع الرد الآلي عن قصد**: الرد الآلي
-- بيتكلم مع طالب ومحتاج أخف وأسرع، والتصحيح بيحط درجة في ورقة وبيتحاسب عليها — فاللي يختار
-- Haiku للرد مش لازم يبقى مجبر يختاره للتصحيح. فاضي أو قيمة مش معروفة = يرجع لـ ai_provider
-- **وضع التصحيح: فوري ولا طابور.**
-- التصحيح أصلًا بيمشي في طابور في الحالتين — الفرق إن "فوري" بيشغّل الطابور في نفس
-- لحظة التسليم عشان الطالب ياخد درجته في ثواني، و"طابور" بيسيب الكرون (كل دقيقة)
-- يلقطها. وقت الزحمة، آلاف التسليمات في نفس النص ساعة معناها إن كل تسليم بيحاول
-- يشغّل الطابور جنب خدمة الطلبات — والوضع التاني بيشيل الحمل ده عن أسوأ لحظة في اليوم.
INSERT INTO settings (key, value) VALUES ('quiz_grading_mode', 'instant')
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES ('quiz_grading_provider', 'anthropic')
ON CONFLICT (key) DO NOTHING;

-- أبواب شرط المتابعة في /api/public/student-status — قايمة معرّفات مفصولة بفاصلة، بتتظبط
-- من تبويب "بوت طفرة ← شروط الـ API". فاضية معناها الشرط مقفول والـ API بيرد زي الأول
-- (يعني على دخول البوت بس)، مش معناها "مفيش طالب مشترك" — الفرق ده بيقلب النتيجة لكل الطلاب
INSERT INTO settings (key, value) VALUES ('api_follow_up_bootcamps', '')
ON CONFLICT (key) DO NOTHING;

-- تحويل التوكن القديم تلقائيًا إلى أول ملف بوت محفوظ عند ترقية مشروع قائم
INSERT INTO bot_profiles (label, token_encrypted, is_active, activated_at)
SELECT 'البوت الحالي', value, TRUE, NOW()
FROM settings
WHERE key = 'bot_token_encrypted' AND value IS NOT NULL AND value <> ''
  AND NOT EXISTS (SELECT 1 FROM bot_profiles)
ON CONFLICT DO NOTHING;

-- ===================== الاختبارات (اختياري + مقالي) =====================
--
-- **الرابط هو الاختبار.** توكن عشوائي واحد لكل اختبار (زي report_token بالظبط)، بيتبعت
-- للطلاب كلهم في رسالة واحدة، والهوية بتتحدد جوه الصفحة برقم التليفون — مش برابط شخصي لكل
-- طالب. السبب: الإرسال الجماعي في اللوحة بيبعت نفس النص للمئات، فرابط لكل طالب كان معناه
-- مسار إرسال جديد بالكامل.
CREATE TABLE IF NOT EXISTS quizzes (
    id SERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    token VARCHAR(64) NOT NULL UNIQUE,
    -- NULL = من غير مؤقت. بالدقايق، وبيتحسب من لحظة ما الطالب يدخل مش من وقت النشر
    time_limit_minutes INTEGER,
    -- مقفول = الرابط بيفتح صفحة "الاختبار قفل" بدل الأسئلة. الحذف بيضيّع الإجابات، والقفل لأ
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    -- الطالب بيشوف رقم درجته. عرض الأسئلة الصح والغلط مفتاح منفصل (show_answers_to_student
    -- تحت) عشان تقدر توري الدرجة من غير التصحيح
    show_score_to_student BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quizzes_token ON quizzes (token);

-- رابط مختصر بديل للتوكن الطويل: /q/olom1 بدل ٦٤ حرف. الاتنين بيفتحوا نفس الاختبار، فأي
-- رابط اتبعت بالتوكن قبل كده مايكسرش.
-- **الرابط المختصر مش سر** — قصير عشان الموظف يقدر يكتبه أو يقوله في فيديو، والحماية
-- الحقيقية في قفل الاختبار (is_open) وفي إن الأسئلة مابتتبعتش قبل ما الطالب يدخل برقمه.
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS slug VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quizzes_slug ON quizzes (LOWER(slug)) WHERE slug IS NOT NULL;
-- تعبئة الاختبارات اللي اتعملت قبل الميزة دي بكود قصير. الشرط بيخلي الجملة تنفّذ مرة
-- واحدة فعليًا مهما اتطبّق الـ schema كام مرة
UPDATE quizzes SET slug = SUBSTRING(MD5(RANDOM()::text || id::text) FROM 1 FOR 6) WHERE slug IS NULL;

-- **الطالب بيشوف تصحيح ورقته**: إجابته، والإجابة الصح، وليه اتحسبت كده — نفس اللي الموظف
-- بيشوفه في مراجعة المحاولة، ما عدا اسم اللي عدّل الدرجة (ده شغل داخلي).
--
-- التعليق فوق على show_score_to_student كان بيقول إن ده مقفول عن قصد لأن نفس الرابط بيتحل
-- على مدى أيام وأول طالب يشوف الإجابات ينشرها. **القرار اتغيّر بطلب صاحب المشروع** —
-- التصحيح فايدته للطالب أكبر من الضرر، والمفتاح ده هو اللي بيسمح بقفله للاختبار اللي لسه
-- مفتوح لو الموقف اختلف. الافتراضي مفتوح.
--
-- التصحيح مابيتبعتش قبل ما المحاولة تتسلّم وتتصحّح — الطالب اللي لسه بيحل مابيشوفش حاجة
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS show_answers_to_student BOOLEAN NOT NULL DEFAULT TRUE;

-- التصحيح مايبانش غير لما الاختبار يتقفل. ده الحل الوسط بين "الطالب يتعلّم من غلطه"
-- و"الرابط بيتحل على مدى أيام وأول واحد يشوف الإجابات ينشرها": الاختبار مفتوح = مفيش
-- تصحيح، أول ما يتقفل يبان للكل مرة واحدة. بيشتغل فوق show_answers_to_student مش بدالها
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS answers_after_close BOOLEAN NOT NULL DEFAULT FALSE;

-- ترتيب عشوائي. **الاختيارات بتتخلط في العرض بس** — قيمة كل اختيار بتفضل رقمه الأصلي في
-- المصفوفة، عشان selected_option المتخزّن يفضل معناه واحد قبل الخلط وبعده. من غير كده كل
-- الإجابات القديمة كانت هتبقى غلط
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS shuffle_questions BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS shuffle_options BOOLEAN NOT NULL DEFAULT FALSE;

-- المعسكر اللي الاختبار موجّه له. اختياري: من غيره الاختبار شغّال زي ما هو، ومعاه بنعرف
-- **مين ماحلّش** (المشتركين ناقص اللي دخلوا) — وده اللي بيتبعت لتيم المكالمات
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS target_bootcamp_id BIGINT
    REFERENCES tafra_bootcamps(tafra_bootcamp_id) ON DELETE SET NULL;

-- الأسئلة نوعين في نفس الجدول: عمود kind هو الفارق، والأعمدة الخاصة بكل نوع NULL في التاني.
-- جدولين منفصلين كان هيخلي ترتيب الأسئلة في الصفحة (position) موزّع على جدولين
CREATE TABLE IF NOT EXISTS quiz_questions (
    id SERIAL PRIMARY KEY,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    kind VARCHAR(10) NOT NULL,
    text TEXT NOT NULL,
    points NUMERIC(6,2) NOT NULL DEFAULT 1,
    -- اختياري: مصفوفة نصوص. correct_option فهرس فيها (يبدأ من صفر)
    options JSONB NOT NULL DEFAULT '[]'::jsonb,
    correct_option INTEGER,
    -- مقالي: الإجابة المرجعية هي المعيار الوحيد للتصحيح الآلي
    reference_answer TEXT,
    -- تعليمات إضافية للمصحّح الآلي في السؤال ده بالذات (مثال: "لازم يذكر القانون بالاسم")
    grading_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz ON quiz_questions (quiz_id, position, id);

-- ---------- رأس السؤال وفروعه ----------
-- السؤال اللي ليه رأس وتحته أ/ب/ج/د بيتخزّن كصف أب (kind='group') وتحته صفوف أبناء.
-- **الفرع صف كامل مش حقل جوه JSON** عن قصد: كل فرع ليه درجته وإجابته المرجعية وبيتصحّح
-- لوحده، وquiz_answers أصلًا مربوط بـquestion_id — فالفروع بتشتغل في التصحيح والدرجات
-- والمراجعة من غير سطر كود جديد في أي منهم.
-- السؤال المقالي العادي (رأس بس من غير فروع) بيفضل صف واحد زي ما هو.
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES quiz_questions(id) ON DELETE CASCADE;
-- حرف الفرع زي ما الطالب بيشوفه. نص مش رقم عشان المدرّس يكتب أ أو 1 أو a زي ما يحب
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS label VARCHAR(20);
-- صورة السؤال (رسم بياني، معادلة، شكل). ممكن السؤال يبقى صورة من غير أي نص
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS image_path VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_parent ON quiz_questions (parent_id, position)
    WHERE parent_id IS NOT NULL;

-- **الاختيارات بقت كائنات مش نصوص**: ["القاهرة"] بقت [{"text":"القاهرة","image":null}]
-- عشان الاختيار يقدر يكون صورة. التحويل مرة واحدة، والشرط بيمنع تكراره
UPDATE quiz_questions
SET options = (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('text', value #>> '{}', 'image', NULL)), '[]'::jsonb)
  FROM jsonb_array_elements(options)
)
WHERE kind = 'mcq'
  AND jsonb_array_length(options) > 0
  AND jsonb_typeof(options -> 0) = 'string';

-- محاولة واحدة لكل طالب. الهوية = آخر ١٠ أرقام من التليفون (نفس تطبيع bot/handlers/studentReport.js)
-- + معرّف الطالب على طفرة لما يتلاقي. الطالب اللي رقمه مش على المنصة بيدخل برضه ويتسجّل
-- tafra_student_id = NULL — منعه من الامتحان أسوأ بكتير من صف محتاج ربط يدوي بعدين
CREATE TABLE IF NOT EXISTS quiz_attempts (
    id SERIAL PRIMARY KEY,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    tafra_student_id BIGINT REFERENCES tafra_students(tafra_student_id) ON DELETE SET NULL,
    student_name VARCHAR(500),
    phone VARCHAR(20) NOT NULL,
    -- سر بيترجع للمتصفح مرة واحدة عند الدخول وبيتبعت مع كل حفظ وتسليم. من غيره كان أي حد
    -- يعرف رقم تليفون زميله يقدر يبعت إجاباته بدله — الرقم لوحده مش سر
    attempt_key VARCHAR(64) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- بيتحسب مرة واحدة عند الدخول، فإعادة تحميل الصفحة مابتزوّدش الوقت
    deadline_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    is_late BOOLEAN NOT NULL DEFAULT FALSE,
    score NUMERIC(8,2),
    max_score NUMERIC(8,2),
    -- pending = لسه بيحل · graded = اتصحّح كامل · partial = المقالي فشل تصحيحه آليًا
    -- · regrading = في طابور إعادة التصحيح بعد ما الموظف عدّل إجابة مرجعية
    grading_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    grading_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- COALESCE مش عمود عادي: NULL في Postgres مابيتعارضش مع NULL، فبدونها كان أي واحد رقمه مش
-- على المنصة يقدر يعيد الامتحان عدد ما يحب. و٦٩ رقم على المنصة متكرر بين إخوات، فالمفتاح
-- بيشمل معرّف الطالب عشان الأخ التاني مايتمنعش
CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_attempts_one_per_student
    ON quiz_attempts (quiz_id, phone, COALESCE(tafra_student_id, 0));
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts (quiz_id, submitted_at DESC NULLS LAST);

-- **مفتاح المحاولة هو أكتر عمود بيتبحث بيه في الاختبار كله.** كل حفظ تلقائي، وكل تسليم،
-- وكل سؤال عن الدرجة (كل ٤ ثواني لمدة دقيقتين بعد التسليم) بيدوّر بيه. من غير فهرس، كل
-- نداء فيهم بيمسح جدول المحاولات كله — وامتحان بعشرين ألف طالب معناه عشرين ألف صف
-- بيتمسحوا آلاف المرات في الثانية.
-- UNIQUE مش عادي: المفتاح بيتولّد بـcrypto.randomBytes(24) فهو فريد أصلًا، والفهرس
-- بيثبّت الشرط ده بدل ما يفضل افتراض
CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_attempts_key ON quiz_attempts (attempt_key);

-- طابور التصحيح بيتقرا كل دقيقة من الكرون، وqueueLength بيتعرض في لوحة الأدمن. الفهرس
-- بيخلي الاتنين يقروا الصفوف المستنية بس بدل الجدول كله
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_grading_status ON quiz_attempts (grading_status);

-- إشعار الدرجة على تيليجرام: الوقت مش علم منطقي عشان نعرف امتى اتبعت، والفهرس الجزئي
-- بيخلي استعلام "مين لسه مستني إشعار" يمشي على الصفوف المستنية بس مهما كبر الجدول
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS result_notified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_pending_notify
    ON quiz_attempts (id) WHERE result_notified_at IS NULL;

-- المحاولات اللي اتصحّحت قبل الميزة دي بتتعلّم كإنها اتبعتت. من غير السطر ده، أول تشغيل
-- بعد النشر كان هيبعت لكل طالب حلّ من أسابيع إشعار بدرجة هو شايفها خلاص.
-- **الشرط بتاريخ ثابت مش IS NULL** عشان الجملة تنفّذ مرة واحدة فعليًا: الشرط المفتوح كان
-- هيسكّت إشعار أي محاولة مستنية لو حد شغّل migrate تاني في أي وقت بعدين
UPDATE quiz_attempts SET result_notified_at = NOW()
WHERE result_notified_at IS NULL
  AND submitted_at IS NOT NULL
  AND submitted_at < TIMESTAMPTZ '2026-09-01 04:00:00+00';

-- إعادة فتح المحاولة: مين فتحها وامتى وكام مرة. **مفيش Audit Log في المشروع**، والعملية
-- دي بتمسح إجابات طالب فعليًا — فالتسجيل هنا هو الأثر الوحيد لو حد سأل بعدين
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quiz_attempts ADD COLUMN IF NOT EXISTS reopen_count SMALLINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS quiz_answers (
    id SERIAL PRIMARY KEY,
    attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
    selected_option INTEGER,
    essay_text TEXT,
    awarded_points NUMERIC(6,2),
    is_correct BOOLEAN,
    -- correct | partial | incorrect — حقل منطقي صريح من النموذج، مش استنتاج من نص السبب
    ai_verdict VARCHAR(20),
    ai_reason TEXT,
    ai_provider VARCHAR(50),
    -- auto = المصحّح الآلي · staff = موظف عدّل الدرجة بإيده وقتها بتكسب دايمًا
    graded_by VARCHAR(10) NOT NULL DEFAULT 'auto',
    graded_by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
    graded_at TIMESTAMPTZ,
    UNIQUE (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_attempt ON quiz_answers (attempt_id);
