const pool = require('../config/db');
const { UNREACHED_NAMES_SQL, INVALID_NUMBER_SQL, REACHED_CONDITION_SQL } = require('../utils/callOutcomes');

// ===================== متابعة الأداء =====================
// شاشة تحليلية للمنصة كلها وللموظفين. كل الأرقام هنا **قراءة بس** — مفيش أي كتابة على قاعدة
// البيانات من الملف ده.
//
// قاعدة أساسية: قاعدة البيانات شغالة بتوقيت UTC (SHOW TimeZone → Etc/UTC)، والتقارير بتتقري
// بتوقيت القاهرة. فأي تقسيم لليوم أو الساعة لازم يعدّي على AT TIME ZONE صراحةً — من غيرها
// رسايل بعد منتصف الليل بتتحسب على اليوم اللي فات. نفس الكلام على حدود الفترة نفسها.
const TZ = 'Africa/Cairo';
const DEFAULT_RANGE_DAYS = 30;
// سقف طول الفترة — بيحمي المخططات من إنها ترسم آلاف النقط لو حد كتب تاريخ قديم جدًا بالغلط.
// بيتبلّغ للواجهة في range.capped عشان الرقم ما يبانش كأنه كل البيانات
const MAX_RANGE_DAYS = 366;

// رسايل الموظف اللي بينها أقل من ٥ دقايق بتتحسب "دفعة واحدة" مش تواصلين منفصلين — الموظف
// بيقسّم كلامه على ٢-٣ رسايل ورا بعض كتير، ومن غير الحد ده متوسط "المسافة بين رسالتين" بينزل
// لثواني ويبقى بلا معنى. المكالمات معندهاش الحد ده عن قصد: كل مكالمة متسجّلة محاولة حقيقية،
// حتى لو اتعادت بعد دقيقتين
const MESSAGE_BURST_SECONDS = 300;

const RANGE_START = `(($1::date)::timestamp AT TIME ZONE '${TZ}')`;
const RANGE_END = `((($2::date + INTERVAL '1 day'))::timestamp AT TIME ZONE '${TZ}')`;
const dayOf = (column) => `((${column} AT TIME ZONE '${TZ}')::date)`;
const inRange = (column) => `${column} >= ${RANGE_START} AND ${column} < ${RANGE_END}`;

// رد حقيقي من موظف: مش إرسال جماعي (broadcast_recipient_id) ومش رسالة تلقائية (sent_by IS NULL)
const AGENT_REPLY_CONDITION = 'sm.deleted_at IS NULL AND sm.sent_by IS NOT NULL AND sm.broadcast_recipient_id IS NULL';

// آخر رسالة واردة وآخر رسالة صادرة لكل تذكرة — بتتحسب مرة واحدة هنا بدل ما كل عدّاد يعيد نفس
// الاستعلامات المتداخلة على كل تذكرة (ده كان الفرق بين ثانيتين وجزء من الثانية)
const TICKET_EDGES_CTE = `
  ticket_edges AS (
    SELECT t.id, t.contact_id, t.status, t.priority, t.assigned_to, t.unread_count,
      t.next_follow_up_at, t.current_idea_number, t.subtitle_id,
      (SELECT MAX(im.received_at) FROM incoming_messages im WHERE im.contact_id = t.contact_id) AS last_incoming_at,
      (SELECT MAX(sm.sent_at) FROM support_messages sm
        WHERE sm.ticket_id = t.id AND sm.deleted_at IS NULL) AS last_outgoing_at
    FROM tickets t
  )`;

// تذكرة مفتوحة وآخر حركة فيها من الطالب — نفس تعريف فلتر "مفتوحة ولم يُرد عليها" في صندوق الدعم
// بالظبط، عشان الرقم هنا يطابق اللي الأدمن بيشوفه لما يفلتر هناك.
// "مفيش أي رد اتبعت أصلًا" = last_outgoing_at IS NULL، وهي نفس NOT EXISTS بتاعة الصندوق
const AWAITING_REPLY_CONDITION = `
  te.status NOT IN ('resolved', 'closed')
  AND (te.last_outgoing_at IS NULL OR te.last_incoming_at > te.last_outgoing_at)`;

// زمن الرد بيتقاس على "موجات" مش على كل رسالة لوحدها: لو الطالب بعت ٥ رسايل ورا بعض والموظف رد
// مرة، دي موجة واحدة بتتقاس من أول رسالة فيها لحد أول رد — مش ٥ قياسات. نفس تعريف شاشة "سرعة
// الرد" الموجودة، متكرر هنا لأنه محتاج تجميعات مختلفة (توزيع، تقسيم يومي، لكل موظف).
//
// الحساب بيمشي على مجرى واحد مرتّب من كل الأحداث (وارد + رد) جوه كل تذكرة، وبيرقّم الردود
// تصاعديًا بنافذة. الرسايل الواردة اللي ليها نفس رقم الرد السابق = موجة واحدة، واللي بيقفلها هو
// الرد اللي رقمه بعده بواحد. الطريقة دي بتلف على البيانات مرة واحدة، بدل استعلام متداخل لكل
// رسالة واردة على حدة.
//
// مفيش فلتر تاريخ على الأحداث عن قصد: الجدولين صغيرين، والقراءة الكاملة بتخلّي بداية الموجة
// مضبوطة حتى لو ابتدت قبل الفترة بكتير. الفلترة بتحصل على started_at في الآخر
const RESPONSE_WAVES_CTE = `
  events AS (
    SELECT t.id AS ticket_id, im.received_at AS at, 0 AS is_reply, NULL::int AS user_id
    FROM incoming_messages im
    JOIN tickets t ON t.contact_id = im.contact_id
    UNION ALL
    SELECT sm.ticket_id, sm.sent_at AS at, 1 AS is_reply, sm.sent_by AS user_id
    FROM support_messages sm
    WHERE ${AGENT_REPLY_CONDITION}
  ),
  numbered AS (
    -- عدد الردود اللي حصلت لحد الصف ده (شامله). الترتيب بيحط الوارد قبل الرد لو التوقيت واحد،
    -- عشان رسالة وصلت في نفس اللحظة تتحسب على الموجة اللي الرد ده بيقفلها مش اللي بعدها
    SELECT ticket_id, at, is_reply, user_id,
      SUM(is_reply) OVER (PARTITION BY ticket_id ORDER BY at, is_reply
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS reply_seq
    FROM events
  ),
  waves AS (
    SELECT ticket_id, reply_seq, MIN(at) AS started_at
    FROM numbered WHERE is_reply = 0
    GROUP BY ticket_id, reply_seq
  ),
  closing_replies AS (
    SELECT ticket_id, reply_seq, at AS replied_at, user_id
    FROM numbered WHERE is_reply = 1
  ),
  responses AS (
    SELECT r.user_id, w.started_at,
      EXTRACT(EPOCH FROM (r.replied_at - w.started_at)) AS seconds
    FROM waves w
    JOIN closing_replies r ON r.ticket_id = w.ticket_id AND r.reply_seq = w.reply_seq + 1
    WHERE w.started_at >= ${RANGE_START} AND w.started_at < ${RANGE_END}
  )`;

// شرايح زمن الرد — نفس الحدود في الملخص العام وفي تقرير الموظف عشان المقارنة تبقى عادلة
const RESPONSE_BUCKETS_SQL = `
  COUNT(*) FILTER (WHERE seconds < 300)::int AS under_5m,
  COUNT(*) FILTER (WHERE seconds >= 300 AND seconds < 900)::int AS under_15m,
  COUNT(*) FILTER (WHERE seconds >= 900 AND seconds < 3600)::int AS under_1h,
  COUNT(*) FILTER (WHERE seconds >= 3600 AND seconds < 14400)::int AS under_4h,
  COUNT(*) FILTER (WHERE seconds >= 14400 AND seconds < 86400)::int AS under_24h,
  COUNT(*) FILTER (WHERE seconds >= 86400)::int AS over_24h`;

const RESPONSE_AGGREGATES_SQL = `
  COUNT(*)::int AS count,
  ROUND(AVG(seconds))::int AS avg_seconds,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds))::int AS median_seconds,
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY seconds))::int AS p90_seconds,
  ROUND(MAX(seconds))::int AS max_seconds`;

const RESPONSE_BUCKET_LABELS = [
  ['under_5m', 'أقل من ٥ دقايق'],
  ['under_15m', '٥ – ١٥ دقيقة'],
  ['under_1h', '١٥ دقيقة – ساعة'],
  ['under_4h', 'ساعة – ٤ ساعات'],
  ['under_24h', '٤ – ٢٤ ساعة'],
  ['over_24h', 'أكتر من يوم'],
];

// ---------- أدوات الفترة ----------

function todayInCairo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

// بيرجّع فترة صالحة دايمًا: التواريخ الغلط بتتجاهل، والمقلوبة بتتظبط، والطويلة بتتقص من ناحية
// البداية (الأحدث أهم من الأقدم) مع علامة capped عشان الواجهة تقول للمستخدم إن الفترة اتقصّت
function parseRange(query) {
  const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  const today = todayInCairo();
  let to = isDate(query.to) ? query.to : today;
  let from = isDate(query.from) ? query.from : shiftDate(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) [from, to] = [to, from];
  let capped = false;
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    from = shiftDate(to, -(MAX_RANGE_DAYS - 1));
    capped = true;
  }
  return { from, to, days: daysBetween(from, to), capped };
}

const toInt = (value) => (value === null || value === undefined ? 0 : Number(value));
const toIntOrNull = (value) => (value === null || value === undefined ? null : Number(value));

function shapeResponse(row = {}) {
  return {
    count: toInt(row.count),
    avg_seconds: toIntOrNull(row.avg_seconds),
    median_seconds: toIntOrNull(row.median_seconds),
    p90_seconds: toIntOrNull(row.p90_seconds),
    max_seconds: toIntOrNull(row.max_seconds),
    buckets: RESPONSE_BUCKET_LABELS.map(([key, label]) => ({ label, count: toInt(row[key]) })),
  };
}

// زمن الرد مجمّع لكل موظف. الاستعلام مابياخدش user_id جوه الـ CTE عن قصد: تمرير الفلتر جوّه
// بيخلّي المخطِّط يختار خطة أسوأ بكتير (٦ ثواني مقابل جزء من الثانية على نفس البيانات)، فبنجمّع
// للكل ونختار الصف المطلوب في الجافاسكربت. وده كمان بيضمن إن رقم التقرير الفردي مايختلفش أبدًا
// عن رقم نفس الموظف في جدول المقارنة، لأنهم حرفيًا نفس الاستعلام
async function responsesByUser(from, to) {
  const result = await pool.query(`WITH ${RESPONSE_WAVES_CTE}
    SELECT user_id, ${RESPONSE_AGGREGATES_SQL}, ${RESPONSE_BUCKETS_SQL}
    FROM responses WHERE user_id IS NOT NULL GROUP BY user_id`, [from, to]);
  return new Map(result.rows.map((row) => [Number(row.user_id), row]));
}

function emptyHeatmap() {
  return Array.from({ length: 7 }, () => new Array(24).fill(0));
}

// ---------- الملخص العام للمنصة ----------

async function getSummary(req, res) {
  const range = parseRange(req.query);
  const params = [range.from, range.to];

  try {
    const [
      volume, tickets, responses, replyGaps, calls, callGaps,
      outcomes, funnel, ideas, ideaMoves, timeseries, hourly, subtitles,
    ] = await Promise.all([
      // حجم الشغل في الفترة
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM incoming_messages im WHERE ${inRange('im.received_at')}) AS incoming_messages,
          (SELECT COUNT(DISTINCT im.contact_id)::int FROM incoming_messages im WHERE ${inRange('im.received_at')}) AS active_students,
          (SELECT COUNT(*)::int FROM support_messages sm WHERE ${AGENT_REPLY_CONDITION} AND ${inRange('sm.sent_at')}) AS agent_replies,
          (SELECT COUNT(DISTINCT sm.ticket_id)::int FROM support_messages sm WHERE ${AGENT_REPLY_CONDITION} AND ${inRange('sm.sent_at')}) AS conversations_touched,
          (SELECT COUNT(*)::int FROM support_messages sm
            WHERE sm.deleted_at IS NULL AND sm.is_welcome AND ${inRange('sm.sent_at')}) AS welcome_messages,
          (SELECT COUNT(*)::int FROM support_messages sm
            WHERE sm.deleted_at IS NULL AND sm.sent_by IS NULL AND NOT sm.is_welcome
              AND sm.broadcast_recipient_id IS NULL AND ${inRange('sm.sent_at')}) AS auto_follow_ups,
          (SELECT COUNT(*)::int FROM broadcast_recipients br
            WHERE br.status = 'sent' AND ${inRange('br.sent_at')}) AS broadcast_sent,
          (SELECT COUNT(*)::int FROM broadcast_recipients br
            WHERE br.status = 'failed' AND ${inRange('br.sent_at')}) AS broadcast_failed,
          (SELECT COUNT(*)::int FROM sms_logs sl WHERE ${inRange('sl.sent_at')}) AS sms_sent,
          (SELECT COUNT(*)::int FROM tickets t WHERE ${inRange('t.created_at')}) AS new_conversations
      `, params),

      // حالة صندوق الدعم دلوقتي — لقطة اللحظة مش الفترة، لأن السؤال "إيه المتعلّق عليّ دلوقتي؟"
      pool.query(`
        WITH ${TICKET_EDGES_CTE}
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE te.status = 'new')::int AS status_new,
          COUNT(*) FILTER (WHERE te.status = 'in_progress')::int AS status_in_progress,
          COUNT(*) FILTER (WHERE te.status = 'waiting_student')::int AS status_waiting_student,
          COUNT(*) FILTER (WHERE te.status = 'resolved')::int AS status_resolved,
          COUNT(*) FILTER (WHERE te.status = 'closed')::int AS status_closed,
          COUNT(*) FILTER (WHERE te.assigned_to IS NULL)::int AS unassigned,
          COUNT(*) FILTER (WHERE te.priority = 'urgent')::int AS urgent,
          COUNT(*) FILTER (WHERE te.unread_count > 0)::int AS unread,
          COUNT(*) FILTER (WHERE ${AWAITING_REPLY_CONDITION})::int AS awaiting_reply,
          COUNT(*) FILTER (WHERE te.next_follow_up_at IS NOT NULL
            AND te.next_follow_up_at <= NOW() AND te.status NOT IN ('resolved', 'closed'))::int AS follow_up_due,
          ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - te.last_incoming_at)))
            FILTER (WHERE ${AWAITING_REPLY_CONDITION}))::int AS oldest_waiting_seconds
        FROM ticket_edges te
      `),

      pool.query(`WITH ${RESPONSE_WAVES_CTE}
        SELECT ${RESPONSE_AGGREGATES_SQL}, ${RESPONSE_BUCKETS_SQL} FROM responses`, params),

      // المسافة بين رسالتين متتاليتين لنفس المحادثة (بعد استبعاد الدفعة الواحدة)
      pool.query(`
        WITH ordered AS (
          SELECT sm.ticket_id, sm.sent_at,
            LAG(sm.sent_at) OVER (PARTITION BY sm.ticket_id ORDER BY sm.sent_at) AS prev_sent_at
          FROM support_messages sm
          WHERE ${AGENT_REPLY_CONDITION}
        ),
        gaps AS (
          SELECT EXTRACT(EPOCH FROM (sent_at - prev_sent_at)) AS seconds
          FROM ordered
          WHERE prev_sent_at IS NOT NULL AND ${inRange('sent_at')}
        )
        SELECT COUNT(*)::int AS count,
          ROUND(AVG(seconds))::int AS avg_seconds,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds))::int AS median_seconds
        FROM gaps WHERE seconds >= ${MESSAGE_BURST_SECONDS}
      `, params),

      pool.query(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS reached,
          COUNT(*) FILTER (WHERE co.name IN ${UNREACHED_NAMES_SQL})::int AS unreached,
          COUNT(*) FILTER (WHERE co.name = ${INVALID_NUMBER_SQL})::int AS invalid_number,
          COUNT(*) FILTER (WHERE co.name IS NULL)::int AS no_outcome,
          COUNT(DISTINCT cl.tafra_student_id)::int AS students_called,
          COUNT(*) FILTER (WHERE cl.next_follow_up_at IS NOT NULL)::int AS with_follow_up,
          COUNT(*) FILTER (WHERE COALESCE(TRIM(cl.notes), '') <> '')::int AS with_notes
        FROM call_logs cl
        LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
        WHERE ${inRange('cl.called_at')}
      `, params),

      // المسافة بين مكالمتين لنفس الطالب — من غير حد أدنى: كل مكالمة متسجّلة محاولة حقيقية
      pool.query(`
        WITH ordered AS (
          SELECT cl.tafra_student_id, cl.called_at,
            LAG(cl.called_at) OVER (PARTITION BY cl.tafra_student_id ORDER BY cl.called_at) AS prev_called_at
          FROM call_logs cl
        ),
        gaps AS (
          SELECT EXTRACT(EPOCH FROM (called_at - prev_called_at)) AS seconds
          FROM ordered
          WHERE prev_called_at IS NOT NULL AND ${inRange('called_at')}
        )
        SELECT COUNT(*)::int AS count,
          ROUND(AVG(seconds))::int AS avg_seconds,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds))::int AS median_seconds
        FROM gaps
      `, params),

      pool.query(`
        SELECT COALESCE(co.name, 'بدون نتيجة مسجّلة') AS name, COUNT(*)::int AS count
        FROM call_logs cl
        LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
        WHERE ${inRange('cl.called_at')}
        GROUP BY 1 ORDER BY 2 DESC, 1
      `, params),

      // الوصول للطلاب — لقطة تراكمية مش مقيّدة بالفترة: السؤال "وصلنا لكام طالب من أول المشوار؟".
      // مسارين منفصلين مش قمع واحد: البوت والتليفون مستقلين تمامًا، وفيه طلاب اتكلمنا معاهم
      // تليفونيًا وهما أصلًا ما دخلوش البوت — فعرضهم كقمع واحد نازل هيبقى غلط
      pool.query(`
        WITH welcomed AS (
          SELECT t.contact_id, MIN(sm.sent_at) AS first_welcome_at
          FROM tickets t
          JOIN support_messages sm ON sm.ticket_id = t.id AND sm.deleted_at IS NULL AND sm.is_welcome
          GROUP BY t.contact_id
        ),
        replied AS (
          SELECT w.contact_id
          FROM welcomed w
          WHERE EXISTS (
            SELECT 1 FROM incoming_messages im
            WHERE im.contact_id = w.contact_id AND im.received_at > w.first_welcome_at
          )
        ),
        call_stats AS (
          SELECT cl.tafra_student_id,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS reached
          FROM call_logs cl LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
          GROUP BY cl.tafra_student_id
        )
        SELECT
          COUNT(*)::int AS students_total,
          COUNT(*) FILTER (WHERE s.telegram_chat_id IS NOT NULL)::int AS linked_telegram,
          COUNT(*) FILTER (WHERE c.last_contacted_at IS NOT NULL)::int AS started_bot,
          COUNT(*) FILTER (WHERE w.contact_id IS NOT NULL)::int AS got_welcome,
          COUNT(*) FILTER (WHERE r.contact_id IS NOT NULL)::int AS replied_after_welcome,
          COUNT(*) FILTER (WHERE sca.tafra_student_id IS NOT NULL)::int AS assigned_for_calls,
          COUNT(*) FILTER (WHERE cs.calls > 0)::int AS called_at_least_once,
          COUNT(*) FILTER (WHERE cs.reached > 0)::int AS reached_by_phone,
          COUNT(*) FILTER (WHERE c.last_contacted_at IS NOT NULL OR cs.reached > 0)::int AS reached_any_channel
        FROM tafra_students s
        LEFT JOIN contacts c ON c.chat_id = s.telegram_chat_id
        LEFT JOIN welcomed w ON w.contact_id = c.id
        LEFT JOIN replied r ON r.contact_id = c.id
        LEFT JOIN student_call_assignments sca ON sca.tafra_student_id = s.tafra_student_id
        LEFT JOIN call_stats cs ON cs.tafra_student_id = s.tafra_student_id
      `),

      // توزيع الطلاب على الأفكار — 0 معناها "لم يُحدَّد بعد"
      pool.query(`
        SELECT COALESCE(t.current_idea_number, 0)::int AS idea_number, COUNT(*)::int AS conversations
        FROM tickets t GROUP BY 1 ORDER BY 1
      `),

      // تحرّكات الأفكار في الفترة — كام مرة اتنقل طالب لفكرة جديدة
      pool.query(`
        SELECT ipl.idea_number::int AS idea_number, COUNT(*)::int AS moves,
          COUNT(DISTINCT ipl.ticket_id)::int AS students
        FROM idea_progress_log ipl
        WHERE ${inRange('ipl.changed_at')}
        GROUP BY 1 ORDER BY 1
      `, params),

      // السلسلة الزمنية اليومية — الأيام الفاضية بتتولّد من generate_series عشان المخطط ما يقفزش
      pool.query(`
        WITH days AS (SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day),
        incoming AS (
          SELECT ${dayOf('im.received_at')} AS day, COUNT(*)::int AS n
          FROM incoming_messages im WHERE ${inRange('im.received_at')} GROUP BY 1
        ),
        replies AS (
          SELECT ${dayOf('sm.sent_at')} AS day, COUNT(*)::int AS n
          FROM support_messages sm WHERE ${AGENT_REPLY_CONDITION} AND ${inRange('sm.sent_at')} GROUP BY 1
        ),
        calls AS (
          SELECT ${dayOf('cl.called_at')} AS day, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS reached
          FROM call_logs cl LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
          WHERE ${inRange('cl.called_at')} GROUP BY 1
        ),
        opened AS (
          SELECT ${dayOf('t.created_at')} AS day, COUNT(*)::int AS n
          FROM tickets t WHERE ${inRange('t.created_at')} GROUP BY 1
        )
        SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(incoming.n, 0) AS incoming,
          COALESCE(replies.n, 0) AS replies,
          COALESCE(calls.n, 0) AS calls,
          COALESCE(calls.reached, 0) AS calls_reached,
          COALESCE(opened.n, 0) AS new_conversations
        FROM days d
        LEFT JOIN incoming ON incoming.day = d.day
        LEFT JOIN replies ON replies.day = d.day
        LEFT JOIN calls ON calls.day = d.day
        LEFT JOIN opened ON opened.day = d.day
        ORDER BY d.day
      `, params),

      // خريطة الساعات × أيام الأسبوع — بتوضّح فجوات التغطية: امتى الطلاب بيبعتوا وامتى بنرد
      pool.query(`
        SELECT 'incoming' AS kind,
          EXTRACT(DOW FROM (im.received_at AT TIME ZONE '${TZ}'))::int AS dow,
          EXTRACT(HOUR FROM (im.received_at AT TIME ZONE '${TZ}'))::int AS hour,
          COUNT(*)::int AS n
        FROM incoming_messages im WHERE ${inRange('im.received_at')} GROUP BY 1, 2, 3
        UNION ALL
        SELECT 'replies' AS kind,
          EXTRACT(DOW FROM (sm.sent_at AT TIME ZONE '${TZ}'))::int AS dow,
          EXTRACT(HOUR FROM (sm.sent_at AT TIME ZONE '${TZ}'))::int AS hour,
          COUNT(*)::int AS n
        FROM support_messages sm WHERE ${AGENT_REPLY_CONDITION} AND ${inRange('sm.sent_at')} GROUP BY 1, 2, 3
      `, params),

      // توزيع المحادثات على العناوين الفرعية — بيوضّح نوع الشغل الغالب
      pool.query(`
        SELECT COALESCE(ts.name, 'بدون عنوان') AS name, COUNT(*)::int AS count
        FROM tickets t LEFT JOIN ticket_subtitles ts ON ts.id = t.subtitle_id
        GROUP BY 1 ORDER BY 2 DESC, 1
      `),
    ]);

    const heatmap = { incoming: emptyHeatmap(), replies: emptyHeatmap() };
    hourly.rows.forEach((row) => {
      const grid = heatmap[row.kind];
      if (grid) grid[Number(row.dow)][Number(row.hour)] = Number(row.n);
    });

    res.json({
      range,
      volume: volume.rows[0],
      tickets: tickets.rows[0],
      response: shapeResponse(responses.rows[0]),
      reply_gap: replyGaps.rows[0],
      calls: calls.rows[0],
      call_gap: callGaps.rows[0],
      call_outcomes: outcomes.rows,
      reach: funnel.rows[0],
      ideas: ideas.rows,
      idea_moves: ideaMoves.rows,
      timeseries: timeseries.rows,
      heatmap,
      subtitles: subtitles.rows,
      burst_threshold_seconds: MESSAGE_BURST_SECONDS,
    });
  } catch (error) {
    console.error('❌ Failed to load performance summary:', error.message);
    res.status(500).json({ error: 'تعذر تحميل ملخص الأداء' });
  }
}

// ---------- مقارنة الموظفين ----------

async function getStaffPerformance(req, res) {
  const range = parseRange(req.query);
  const params = [range.from, range.to];

  try {
    const [users, responses, ticketLoad, replyActivity, callActivity, callLoad, ideaActivity, smsActivity] =
      await Promise.all([
        pool.query(`SELECT id, name, role, is_active, can_view_tickets, can_view_calls
                    FROM users ORDER BY (role = 'admin') DESC, name`),

        responsesByUser(range.from, range.to),

        // حِمل التذاكر + المستنية رد دلوقتي — الاتنين من نفس المرور على الجدول
        pool.query(`
          WITH ${TICKET_EDGES_CTE}
          SELECT te.assigned_to AS user_id, COUNT(*)::int AS tickets_total,
            COUNT(*) FILTER (WHERE te.status NOT IN ('resolved', 'closed'))::int AS tickets_open,
            COUNT(*) FILTER (WHERE te.status IN ('resolved', 'closed'))::int AS tickets_done,
            COUNT(*) FILTER (WHERE te.priority = 'urgent')::int AS tickets_urgent,
            COUNT(*) FILTER (WHERE te.current_idea_number IS NOT NULL)::int AS tickets_with_idea,
            COUNT(*) FILTER (WHERE ${AWAITING_REPLY_CONDITION})::int AS awaiting_tickets,
            ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - te.last_incoming_at)))
              FILTER (WHERE ${AWAITING_REPLY_CONDITION}))::int AS oldest_waiting_seconds
          FROM ticket_edges te
          WHERE te.assigned_to IS NOT NULL
          GROUP BY te.assigned_to`),

        pool.query(`
          SELECT sm.sent_by AS user_id, COUNT(*)::int AS replies_sent,
            COUNT(DISTINCT sm.ticket_id)::int AS conversations_touched,
            COUNT(DISTINCT ${dayOf('sm.sent_at')})::int AS active_days,
            MAX(sm.sent_at) AS last_reply_at
          FROM support_messages sm
          WHERE ${AGENT_REPLY_CONDITION} AND ${inRange('sm.sent_at')}
          GROUP BY sm.sent_by`, params),

        pool.query(`
          SELECT cl.called_by AS user_id, COUNT(*)::int AS calls_total,
            COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS calls_reached,
            COUNT(*) FILTER (WHERE co.name IN ${UNREACHED_NAMES_SQL})::int AS calls_unreached,
            COUNT(*) FILTER (WHERE co.name = ${INVALID_NUMBER_SQL})::int AS calls_invalid,
            COUNT(DISTINCT cl.tafra_student_id)::int AS students_called,
            COUNT(DISTINCT ${dayOf('cl.called_at')})::int AS call_days,
            COUNT(*) FILTER (WHERE COALESCE(TRIM(cl.notes), '') <> '')::int AS calls_with_notes,
            MAX(cl.called_at) AS last_call_at
          FROM call_logs cl
          LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
          WHERE cl.called_by IS NOT NULL AND ${inRange('cl.called_at')}
          GROUP BY cl.called_by`, params),

        // حِمل المتابعة التليفونية — تراكمي مش بالفترة: "كام طالب مسند ليك ولسه ما اتكلمتش معاه"
        pool.query(`
          SELECT sca.assigned_to AS user_id, COUNT(*)::int AS students_assigned,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM call_logs cl WHERE cl.tafra_student_id = sca.tafra_student_id
            ))::int AS students_done
          FROM student_call_assignments sca GROUP BY sca.assigned_to`),

        pool.query(`
          SELECT ipl.changed_by AS user_id, COUNT(*)::int AS idea_moves,
            COUNT(DISTINCT ipl.ticket_id)::int AS idea_students
          FROM idea_progress_log ipl
          WHERE ipl.changed_by IS NOT NULL AND ${inRange('ipl.changed_at')}
          GROUP BY ipl.changed_by`, params),

        pool.query(`
          SELECT sl.sent_by AS user_id, COUNT(*)::int AS sms_sent
          FROM sms_logs sl WHERE sl.sent_by IS NOT NULL AND ${inRange('sl.sent_at')}
          GROUP BY sl.sent_by`, params),
      ]);

    const byUser = (result) => new Map(result.rows.map((row) => [Number(row.user_id), row]));
    const responsesBy = responses;
    const ticketLoadBy = byUser(ticketLoad);
    const replyBy = byUser(replyActivity);
    const callBy = byUser(callActivity);
    const callLoadBy = byUser(callLoad);
    const ideaBy = byUser(ideaActivity);
    const smsBy = byUser(smsActivity);

    const staff = users.rows.map((user) => {
      const response = responsesBy.get(user.id) || {};
      const reply = replyBy.get(user.id) || {};
      const call = callBy.get(user.id) || {};
      const callLoadRow = callLoadBy.get(user.id) || {};
      const ticketRow = ticketLoadBy.get(user.id) || {};
      const idea = ideaBy.get(user.id) || {};
      const callsTotal = toInt(call.calls_total);
      const assigned = toInt(callLoadRow.students_assigned);
      const done = toInt(callLoadRow.students_done);
      const lastActivity = [reply.last_reply_at, call.last_call_at].filter(Boolean)
        .map((value) => new Date(value).toISOString()).sort().pop() || null;

      return {
        id: user.id,
        name: user.name,
        role: user.role,
        is_active: user.is_active,
        can_view_tickets: user.role === 'admin' || user.can_view_tickets,
        can_view_calls: user.role === 'admin' || user.can_view_calls,
        last_activity_at: lastActivity,
        chat: {
          replies_sent: toInt(reply.replies_sent),
          conversations_touched: toInt(reply.conversations_touched),
          active_days: toInt(reply.active_days),
          responses_measured: toInt(response.count),
          avg_seconds: toIntOrNull(response.avg_seconds),
          median_seconds: toIntOrNull(response.median_seconds),
          p90_seconds: toIntOrNull(response.p90_seconds),
          within_15m: toInt(response.under_5m) + toInt(response.under_15m),
          over_24h: toInt(response.over_24h),
          tickets_total: toInt(ticketRow.tickets_total),
          tickets_open: toInt(ticketRow.tickets_open),
          tickets_done: toInt(ticketRow.tickets_done),
          tickets_urgent: toInt(ticketRow.tickets_urgent),
          awaiting_tickets: toInt(ticketRow.awaiting_tickets),
          oldest_waiting_seconds: toIntOrNull(ticketRow.oldest_waiting_seconds),
        },
        calls: {
          total: callsTotal,
          reached: toInt(call.calls_reached),
          unreached: toInt(call.calls_unreached),
          invalid: toInt(call.calls_invalid),
          with_notes: toInt(call.calls_with_notes),
          students_called: toInt(call.students_called),
          active_days: toInt(call.call_days),
          reach_rate: callsTotal ? Math.round((toInt(call.calls_reached) / callsTotal) * 1000) / 10 : null,
          students_assigned: assigned,
          students_done: done,
          students_pending: assigned - done,
          coverage_rate: assigned ? Math.round((done / assigned) * 1000) / 10 : null,
        },
        ideas: {
          moves: toInt(idea.idea_moves),
          students: toInt(idea.idea_students),
        },
        sms_sent: toInt((smsBy.get(user.id) || {}).sms_sent),
      };
    });

    res.json({ range, staff });
  } catch (error) {
    console.error('❌ Failed to load staff performance:', error.message);
    res.status(500).json({ error: 'تعذر تحميل أداء الموظفين' });
  }
}

// ---------- تقرير موظف واحد (قابل للطباعة) ----------

async function getStaffMemberReport(req, res) {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'الموظف غير صالح' });
  const range = parseRange(req.query);
  const params = [range.from, range.to, userId];

  try {
    const userResult = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = $1', [userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'الموظف غير موجود' });

    const [responseMap, timeseries, outcomes, ideaMoves, subtitleMix, longestWaiting] = await Promise.all([
      responsesByUser(range.from, range.to),

      pool.query(`
        WITH days AS (SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day),
        replies AS (
          SELECT ${dayOf('sm.sent_at')} AS day, COUNT(*)::int AS n
          FROM support_messages sm
          WHERE ${AGENT_REPLY_CONDITION} AND sm.sent_by = $3::int AND ${inRange('sm.sent_at')} GROUP BY 1
        ),
        calls AS (
          SELECT ${dayOf('cl.called_at')} AS day, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE ${REACHED_CONDITION_SQL})::int AS reached
          FROM call_logs cl LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
          WHERE cl.called_by = $3::int AND ${inRange('cl.called_at')} GROUP BY 1
        ),
        ideas AS (
          SELECT ${dayOf('ipl.changed_at')} AS day, COUNT(*)::int AS n
          FROM idea_progress_log ipl
          WHERE ipl.changed_by = $3::int AND ${inRange('ipl.changed_at')} GROUP BY 1
        )
        SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(replies.n, 0) AS replies,
          COALESCE(calls.n, 0) AS calls,
          COALESCE(calls.reached, 0) AS calls_reached,
          COALESCE(ideas.n, 0) AS idea_moves
        FROM days d
        LEFT JOIN replies ON replies.day = d.day
        LEFT JOIN calls ON calls.day = d.day
        LEFT JOIN ideas ON ideas.day = d.day
        ORDER BY d.day
      `, params),

      pool.query(`
        SELECT COALESCE(co.name, 'بدون نتيجة مسجّلة') AS name, COUNT(*)::int AS count
        FROM call_logs cl LEFT JOIN call_outcomes co ON co.id = cl.outcome_id
        WHERE cl.called_by = $3::int AND ${inRange('cl.called_at')}
        GROUP BY 1 ORDER BY 2 DESC, 1
      `, params),

      pool.query(`
        SELECT ipl.idea_number::int AS idea_number, COUNT(*)::int AS moves
        FROM idea_progress_log ipl
        WHERE ipl.changed_by = $3::int AND ${inRange('ipl.changed_at')}
        GROUP BY 1 ORDER BY 1
      `, params),

      // نوعية المحادثات المسندة له دلوقتي
      pool.query(`
        SELECT COALESCE(ts.name, 'بدون عنوان') AS name, COUNT(*)::int AS count
        FROM tickets t LEFT JOIN ticket_subtitles ts ON ts.id = t.subtitle_id
        WHERE t.assigned_to = $1::int GROUP BY 1 ORDER BY 2 DESC, 1
      `, [userId]),

      // أطول ٥ محادثات مستنية رد عنده دلوقتي — أوضح مؤشر على حاجة محتاجة تدخّل فورًا
      pool.query(`
        WITH ${TICKET_EDGES_CTE}
        SELECT te.id,
          COALESCE(tsm.name, NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
                   c.telegram_username, c.chat_id::text) AS student_name,
          ROUND(EXTRACT(EPOCH FROM (NOW() - te.last_incoming_at)))::int AS waiting_seconds
        FROM ticket_edges te
        JOIN contacts c ON c.id = te.contact_id
        LEFT JOIN LATERAL (
          SELECT name FROM tafra_students WHERE telegram_chat_id = c.chat_id LIMIT 1
        ) tsm ON true
        WHERE te.assigned_to = $1::int AND ${AWAITING_REPLY_CONDITION}
        ORDER BY waiting_seconds DESC NULLS LAST
        LIMIT 5
      `, [userId]),
    ]);

    res.json({
      range,
      user: userResult.rows[0],
      response: shapeResponse(responseMap.get(userId)),
      timeseries: timeseries.rows,
      call_outcomes: outcomes.rows,
      idea_moves: ideaMoves.rows,
      subtitle_mix: subtitleMix.rows,
      longest_waiting: longestWaiting.rows,
    });
  } catch (error) {
    console.error('❌ Failed to load staff member report:', error.message);
    res.status(500).json({ error: 'تعذر تحميل تقرير الموظف' });
  }
}

module.exports = { getSummary, getStaffPerformance, getStaffMemberReport };
