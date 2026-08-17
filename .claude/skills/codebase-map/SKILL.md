---
name: codebase-map
description: خريطة مشروع Telegram Broadcast Manager (لوحة دعم بوت تليجرام لمنصة طفرة) — الستاك، بنية الملفات، نموذج البيانات، أعراف الكود، مصائد الإنتاج، وطريقة النشر والتحقق. اقرأها قبل أي تعديل على الكود في هذا المستودع، وقبل أي شغل على التذاكر أو المراسلة الجماعية أو البوت أو مزامنة طفرة أو المتابعة التليفونية أو قاعدة البيانات. تُغني عن استكشاف المشروع من الصفر في كل مرة. Read this before editing any file in this repository.
---

# Telegram Broadcast Manager — خريطة المشروع

لوحة تحكم عربية لإدارة بوت دعم طلاب منصة **طفرة**: تذاكر ومحادثات، مراسلة جماعية، مزامنة بيانات الطلاب، ومتابعة تليفونية.

## الستاك

Node.js (CommonJS) + Express **5** + Telegraf + PostgreSQL 16 + EJS + `node-cron`.

**مفيش خطوة build ومفيش أي framework في الواجهة.** الواجهة EJS + JavaScript عادي. **مفيش تستات** — `package.json` مافيهاش سكربت test، فالتحقق يدوي (تفاصيل تحت).

```
npm run dev       # nodemon
npm start         # node src/server.js
npm run migrate   # يطبّق src/db/schema.sql
```

## ⚠️ اقرأ ده الأول — مصائد بتوقّع الإنتاج

**١. Webhook واحد بس للبوت.** التطبيق منشور على VPS برابط ثابت `https://support.arabiccoders.com` (Cloudflare Named Tunnel). لو شغّلت نسخة محلية و`PUBLIC_URL` فيها رابط عام، تليجرام **هيسحب الـ webhook من الإنتاج** والبوت يبطّل يستقبل رسايل على الموقع الفعلي. `PUBLIC_URL` في `.env` المحلي **مسيّب فاضي عن قصد** — متحطّش فيه حاجة.

**٢. الإنتاج مش git repo.** `/root/app` على السيرفر ملفات منسوخة يدويًا، مفيش `.git` ومفيش `git pull` ومفيش rollback. **الكود المنشور ممكن يسبق اللي متكوميت** — حصل فعلًا. التحقق الوحيد الموثوق: مقارنة `md5sum` على السيرفر بـ `Get-FileHash` محلي. متفترضش إن `git log` أو GitHub بيقولك إيه المنشور.

**٣. بورت 3000 مقفول محليًا وده طبيعي** — الموقع بيتخدم من السيرفر. أي تشخيص لمشكلة إنتاج يبدأ من السيرفر عبر SSH.

**٤. `trust proxy` مطلوب.** التطبيق ورا التانل (HTTPS بيتفكّ عند Cloudflare، الداخلي HTTP). لولا `app.set('trust proxy', 1)` كوكي الجلسة `secure` مش بتتبعت والدخول يرجع للوجين بدون أي رسالة خطأ.

**٥. نسخة واحدة بس تشتغل.** السيرفر بيموت فورًا على `EADDRINUSE` بدل ما يفضل نسخة شبح تعمل نفس الجدولة — لأن نسختين معناها إرسال جماعي ومتابعات **مكررة**. متحاولش تتحايل على ده.

**٦. بيانات الدخول في `ACCOUNTS.md`** جوه المستودع — متجاهل في `.gitignore` ومش مرفوع، لأن **الريبو public**. متكتبش أي IP أو مفتاح أو باسورد في أي ملف متتبَّع.

## البنية

```
src/server.js          نقطة البداية: الجلسات، مسارات الـ webhook، mounting الـ routes، تشغيل الـ jobs
src/config/env.js      تحقق من متغيرات البيئة — بيتحمّل أول سطر عشان يفشل بسرعة
src/config/db.js       pg Pool
src/bot/
  botManager.js        بوت الدعم الأساسي (@Dr_Abdullah_Habashy_FollowUp_bot)
  newBotManager.js     بوت تاني منفصل، webhook على /bot2/webhook — تتبّع Start بس
  broadcastSender.js   تنفيذ الإرسال الجماعي
  handlers/            start.js · message.js · forwarding.js · staffLink.js
src/routes/            13 راوتر رقيق
src/controllers/       كل المنطق هنا
src/jobs/              scheduler · welcomeMessageSender · tafraSyncScheduler
                       · staffActivityDigest · callAutoAssign   (كلهم node-cron)
src/integrations/tafraClient.js   عميل API منصة طفرة
src/db/schema.sql      الـ schema كامل (اقرأ قسم الأعراف)
src/utils/             crypto · workingHours · telegramErrors · genderInference
                       · messagePersonalization · ticketAssignment · push · reportExport ...
src/views/dashboard.ejs  ⚠️ 348KB — اللوحة كلها في ملف واحد
```

**الـ API كله تحت `/api/*`** ومحمي بـ `requireAuth`، **ما عدا `/api/public`** — مفتوح بدون مصادقة أو مفتاح، **بطلب صريح من المستخدم**. متقفلهوش من نفسك.

توكن البوت **مش** في `.env` — متخزّن مشفّر (AES-256-GCM) في قاعدة البيانات، بيتسجّل من صفحة الإعدادات.

### التنقّل في `dashboard.ejs`

348KB في ملف واحد — **متقراهوش كله**، هيبلع الـ context. استخدم Grep على معرّف العنصر أو اسم الدالة. الأعراف: الفلاتر بمعرّفات زي `tafra-<name>-filter`، ومسجّلة في `registerFilterGroup(...)` وفي خريطة الـ query params، وفي دالة التصفير، وفي مصفوفة مستمعي `change`. **أي فلتر جديد لازم يتحدّث في الأربع أماكن دي** وإلا يشتغل نص شغل بدون أي خطأ ظاهر.

## نموذج البيانات

٣٣ جدول. المهم منها:

| المجموعة | الجداول |
|---|---|
| المستخدمون | `users` (admin/agent + صلاحيات `can_view_tickets` / `can_view_calls` / `can_assign_calls`) |
| جهات الاتصال | `contacts`, `tags`, `contact_tags`, `incoming_messages` |
| الدعم | `tickets`, `ticket_subtitles`, `support_messages`, `pending_welcome_sends` |
| المراسلة | `broadcasts`, `broadcast_recipients`, `templates` |
| طفرة | `tafra_students`, `tafra_bootcamps`, `tafra_enrollments`, `tafra_exams`, `tafra_exam_marks` + جداول `*_sync_status` |
| المكالمات | `student_call_assignments`, `call_logs`, `call_outcomes`, `call_auto_assign_config` |
| متنوع | `settings` (مفتاح/قيمة)، `push_subscriptions`، `session` |

### مفاهيم لازم تفهمها قبل ما تعدّل

**«أول تواصل» بيتحدد بوجود تذكرة، مش بصف جهة اتصال جديد.** طلاب طفرة عندهم صف `contacts` جاهز من المزامنة (`source='tafra'`) قبل ما يتكلموا مع البوت خالص. الاعتماد على «صف جديد» كان بيفوّت الترحيب والتذكرة لكل واحد منهم. الشرط الصح: هل فيه `tickets` row للـ contact ده.

**رسالة الترحيب بتستنى وقت العمل، التذكرة والإسناد لأ.** التذكرة بتتعمل فورًا وتاخد دور في التوزيع بالتبادل، والرسالة بتتسجّل في `pending_welcome_sends` و`welcomeMessageSender` (كل دقيقتين) بيبعتها لما يدخل الوقت المسموح. بيتم تجهيزها من **`/start` ومن أول رسالة عادية كمان** — مش كل طالب بيبدأ بالأمر.

**`support_messages.is_welcome`** علامة صريحة بيحطها البوت وقت الإرسال. قبلها كان التعرّف على الترحيب بمطابقة نصه بالقالب الحالي، وده بيقع أول ما الأدمن يغيّر الصيغة. **لو ضفت أي مسار جديد يبعت ترحيب، علّم `is_welcome = TRUE`** وإلا فلتر `welcome_status` هيفوّته.

**«تم الرد» = رسالة واردة بعد إرسال الترحيب** — مش أي رسالة واردة. الترحيب بيستنى وقت العمل، فالطالب ممكن يكون بعت قبله.

**أخطاء تليجرام: دائمة ضد مؤقتة.** `src/utils/telegramErrors.js` → `isPermanentSendError(error)`. الدائم (حاظر البوت، حساب محذوف، محادثة مش موجودة) **متعيدش المحاولة أبدًا** — تذكرة #466 فضلت تحاول كل ٥ دقايق لشهور على `403 bot was blocked`. المطابقة بنص الوصف مش بكود الحالة، لأن 403 و 400 بيرجعوا في الحالتين. **استخدم الدالة دي في أي كود إرسال جديد.**

## أعراف الكود

**التعليقات بالعربي وبتشرح «ليه» مش «إيه».** ده أهم عُرف في المشروع — التعليقات الموجودة بتسجّل قرارات ومصائد اتحرق فيها وقت. حافظ على نفس الكثافة والأسلوب، ومتحوّلهاش لإنجليزي.

**`schema.sql` ملف واحد idempotent، مفيش migrations مرقّمة.** `migrate.js` بيطبّقه كله بجملة واحدة، وكل الجُمل `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. **التعديل بإضافة جُمل idempotent في المكان المنطقي من نفس الملف** — متعملش ملف migration جديد ومتعدّلش جملة قديمة اتطبّقت على الإنتاج بالفعل. لو محتاج تعبئة بيانات قديمة، اكتب `UPDATE` بشرط `WHERE` يخليه ينفّذ مرة واحدة فعليًا (فيه مثال جاهز عند `is_welcome`).

**رسايل الكوميت إنجليزي، فعل أمر، وصفية بدون prefix**، مع body يشرح السبب. مثال: `Track welcome messages with is_welcome and queue them from any first contact`.

**نمط التذكرة الجديدة يتعمل جوه transaction** (`BEGIN` + `SELECT ... FOR UPDATE`) مش UPSERT، عشان يفرّق بدقة بين «تذكرة جديدة تمامًا» (تاخد دور في التوزيع) و«موجودة بالفعل» (تتحدّث بس وتفضل عند نفس الموظف). الأربع مسارات — `start.js` و `message.js` و `broadcastSender.js` — ماشيين على نفس النمط، **قلّده لو ضفت مسار خامس**.

الأدمن معفى دايمًا من صلاحيات العرض (`can_view_*`) — الصلاحيات دي للـ agent بس.

## النشر والتحقق

**انشر وادفع مباشرة بدون استئذان — موافقة دائمة من صاحب المشروع.** بعد التعديل والتحقق والكوميت، كمّل للنشر و`git push` على طول وبلّغ بالنتيجة بعد الفعل. متسألش «أدفعهم؟». الاستثناء الوحيد اللي بيتعرض قبل التنفيذ: تعديل schema **مدمّر أو غير قابل للرجوع** (`DROP TABLE` / `DROP COLUMN`، أو `UPDATE`/`DELETE` بيضيّع بيانات إنتاج فعلية) — إضافة أعمدة وفهارس بـ `IF NOT EXISTS` نشر عادي.

قبل الدفع افحص الدِف الخارج من أي أسرار (IP، مفتاح، باسورد، معرّفات تانل) — الريبو public، والملفات الحسّاسة (`.env`, `ACCOUNTS.md`) متجاهلة عن قصد. ده تدقيق مش استئذان.

مفيش تستات، فالتحقق: `node --check <file>` للـ syntax، و`ejs.compile()` للقوالب، ولوجيك خالص جرّبه بـ `node -e`. استعلامات فلترة جديدة **اختبرها على بيانات الإنتاج قراءة-فقط** قبل النشر (`SELECT` بس) — أسرع وأصدق دليل من أي حاجة تانية، وبيكشف حالات زي طالب عنده تاريخ مكالمات متعدد النتايج. وبعد النشر راقب اللوج.

النشر نسخ يدوي. `scp` ممكن يكون محجوب في وضع الأذونات — البديل الشغّال:

```powershell
$b64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($local))
ssh -i <key> root@<ip> "echo '$b64' | base64 -d > /root/app/<remote-path>"
```
الملفات أكبر من ~20KB لازم تتقطّع (حد طول سطر الأوامر في ويندوز)، ووقتها اكتب القطع بـ `printf '%s' '<chunk>' >> /tmp/f.b64` وبعدين `base64 -d`. **تحقق بالـ md5 بعد كل نقل.**

بعدها: `node --check` على السيرفر، ثم `systemctl restart telegram-broadcast-manager`، ثم `systemctl is-active` و `tail service-out.log`. لو غيّرت `schema.sql` شغّل `npm run migrate` على السيرفر قبل الـ restart.

الخدمات: `telegram-broadcast-manager` · `cloudflared-tunnel` · `postgresql`. اللوجز `/root/app/service-{out,err}.log` بدوران `logrotate` (`copytruncate` — ضروري لأن systemd ماسك الـ fd بـ `append:`).

تفاصيل الاتصال في `ACCOUNTS.md`.

## نقاط مفتوحة معروفة

- `welcomeMessageSender.js` بيشيل الرسالة من الطابور عند **أي** فشل، فخلل شبكة لحظي بيضيّع الترحيب نهائيًا. متعمّد وموثّق، بس بقى عندنا `isPermanentSendError` فينفع يتحسّن — محتاج عمود لعدّ المحاولات.
- المتابعة التلقائية بتعيد المحاولة للأخطاء المؤقتة بلا حد أعلى — محتاجة عمود عدّاد كمان.
- الصور على القرص المحلي، مفيش Object Storage.
- مفيش Queue خارجي (Redis/BullMQ)، ومفيش زر إيقاف لحملة بدأت، وحملتين متوازيتين بتجمع سرعتيهما.
- مفيش Audit Log ولا Rate limiting على تسجيل الدخول.
- `FEATURES_AR.md` (46KB) فيه توصيف تفصيلي لكل ميزة + قسم ٢٢ فيه خطة التحسينات — ارجع له للتفاصيل الوظيفية.
