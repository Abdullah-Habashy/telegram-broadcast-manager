#!/bin/bash
# ---------------------------------------------------------------------------
# مراقبة لوحة المتابعة — بتجاوب على سؤال واحد: «هي لسه شغّالة؟»
#
# systemd بيغطي حالة واحدة بس (العملية ماتت → Restart=always بيرجّعها). اللي مش
# بيغطيه وهو اللي بيوقّع الموقع فعلًا:
#   • الخدمة active لكن مبلوكة ومابتردش على أي طلب
#   • التانل واقع — الخدمة شغّالة والموقع مش بيفتح من بره
#   • postgres واقع — كل صفحة بترمي
#   • القرص اتملى — الكتابة بتفشل وكل حاجة بتقع ورا بعضها
#
# بيشتغل من cron كل ٥ دقايق وبيبعت على تيليجرام لحساب الأدمن.
#
# **التنبيه عند تغيّر الحالة بس** — مش كل ٥ دقايق. عطل ساعتين = رسالة عند الوقوع،
# وواحدة عند الرجوع، وتذكير كل ٦ ساعات لو فضل واقع. التنبيه اللي بيتكرر كل ٥
# دقايق بيتحوّل لضوضاء وبيتقفل، وساعتها المراقبة كلها مالهاش لازمة.
#
# **التوكن متخزّن مفكوك في /root/health-alert.env (600) عن قصد**: التنبيه لازم
# يشتغل والقاعدة واقعة، والتوكن مشفّر جوه القاعدة. اللي عنده root يقدر يفكه من
# `.env` + القاعدة أصلًا، فالكاش ده مش بيفتح باب جديد — وبيتحدّث لوحده لما
# القاعدة تكون شغّالة، فتغيير التوكن من اللوحة بيوصل هنا من غير أي خطوة يدوية.
#
# ⚠️ **الحارس ده بيموت مع السيرفر.** لو الجهاز نفسه وقع مفيش حد هيبعت. عشان كده
# فيه `PING_URL` اختياري (Healthchecks.io أو أي dead-man switch): السكربت بيدقّه
# بعد كل فحص ناجح، والخدمة الخارجية هي اللي بتصرخ لما الدق يقف.
# ---------------------------------------------------------------------------
set -uo pipefail

CONF="${CONF:-/root/health-alert.env}"
STATE="${STATE:-/root/.health-check-state}"
LOG="${LOG:-/root/health-check.log}"
SERVICE="${SERVICE:-telegram-broadcast-manager}"
TUNNEL_SERVICE="${TUNNEL_SERVICE:-cloudflared-tunnel}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:3000/login}"
SITE_URL="${SITE_URL:-https://habashy-follow-up.com/login}"
DISK_MAX_PCT="${DISK_MAX_PCT:-90}"
REMIND_SECONDS="${REMIND_SECONDS:-21600}"   # ٦ ساعات
DRY_RUN="${DRY_RUN:-0}"

TEST_MODE=0
[ "${1:-}" = "--test" ] && TEST_MODE=1

log() { echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# الفحص كل ٥ دقايق = ~٨٦٠٠ سطر في الشهر لو سجّلنا كل مرة. بنسجّل التغيّرات بس،
# والقص ده حماية أخيرة عشان اللوج مايتحوّلش لمشكلة قرص بنفسه
trim_log() {
  [ -f "$LOG" ] || return 0
  local lines
  lines=$(wc -l < "$LOG")
  if [ "$lines" -gt 2000 ]; then
    tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

BOT_TOKEN=""
ALERT_CHAT_ID=""
PING_URL=""
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"

# بيحدّث الكاش من القاعدة لما تكون شغّالة. فشله مش فشل للفحص — الكاش القديم
# بيفضل شغّال، وده بالظبط سبب وجوده
refresh_secrets() {
  [ -r /root/app/.env ] || return 0
  pg_isready -q 2>/dev/null || return 0
  local enc chat key token
  enc=$(sudo -u postgres psql -tAq -d telegram_broadcast_manager \
    -c "SELECT value FROM settings WHERE key = 'bot_token_encrypted'" 2>/dev/null) || return 0
  chat=$(sudo -u postgres psql -tAq -d telegram_broadcast_manager \
    -c "SELECT value FROM settings WHERE key = 'forward_chat_id'" 2>/dev/null) || return 0
  key=$(sed -n 's/^ENCRYPTION_KEY=//p' /root/app/.env | head -1 | tr -d '\r"')
  [ -n "$enc" ] && [ -n "$chat" ] && [ -n "$key" ] || return 0
  # فك AES-256-GCM بنفس صيغة src/utils/crypto.js (iv:authTag:data كلهم hex).
  # node لوحده من غير ما نحمّل كود التطبيق — env.js بيوقف العملية لو متغيّر ناقص
  token=$(ENC="$enc" KEY="$key" node -e '
    const c = require("crypto");
    const [iv, tag, data] = process.env.ENC.split(":");
    const d = c.createDecipheriv("aes-256-gcm", Buffer.from(process.env.KEY, "hex"), Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    process.stdout.write(Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8"));
  ' 2>/dev/null) || return 0
  [ -n "$token" ] || return 0
  if [ "$token" != "$BOT_TOKEN" ] || [ "$chat" != "$ALERT_CHAT_ID" ]; then
    umask 077
    printf 'BOT_TOKEN=%s\nALERT_CHAT_ID=%s\nPING_URL=%s\n' "$token" "$chat" "$PING_URL" > "$CONF"
    chmod 600 "$CONF"
    log "🔑 الكاش اتحدّث من القاعدة"
  fi
  BOT_TOKEN="$token"
  ALERT_CHAT_ID="$chat"
}

tg_send() {
  local text="$1"
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY_RUN] $text"
    return 0
  fi
  if [ -z "$BOT_TOKEN" ] || [ -z "$ALERT_CHAT_ID" ]; then
    log "❌ مفيش توكن أو chat_id في $CONF — التنبيه في اللوج بس: $text"
    return 1
  fi
  local code
  code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
    --data-urlencode "chat_id=$ALERT_CHAT_ID" \
    --data-urlencode "text=$text" \
    "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" 2>/dev/null)
  if [ "$code" != "200" ]; then
    log "❌ تيليجرام رجّع $code وإحنا بنبعت: $text"
    return 1
  fi
  return 0
}

# **محاولة تانية قبل ما نعلن عطل.** الموقع بيعدّي على Cloudflare، وطلب واحد فشل
# ممكن يكون بلبلة شبكة لحظية — والتنبيه الكذّاب بيخلّي التنبيه الحقيقي يتجاهَل
HTTP_CODE=""
http_ok() {
  local url="$1" timeout="$2" code
  code=$(curl -s -m "$timeout" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  HTTP_CODE="${code:-000}"
  if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 400 ] 2>/dev/null; then
    return 0
  fi
  sleep 5
  code=$(curl -s -m "$timeout" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  HTTP_CODE="${code:-000}"
  [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 400 ] 2>/dev/null
}

# ---------- الفحوصات ----------
problems=()

state=$(systemctl is-active "$SERVICE" 2>/dev/null)
[ "$state" = "active" ] || problems+=("الخدمة $SERVICE = ${state:-unknown}")

http_ok "$LOCAL_URL" 10 || problems+=("التطبيق مابيردش محليًا (رجع $HTTP_CODE)")

tunnel=$(systemctl is-active "$TUNNEL_SERVICE" 2>/dev/null)
[ "$tunnel" = "active" ] || problems+=("التانل $TUNNEL_SERVICE = ${tunnel:-unknown}")

http_ok "$SITE_URL" 25 || problems+=("الموقع مابيفتحش من بره (رجع $HTTP_CODE)")

pg_isready -q 2>/dev/null || problems+=("postgres مش رادّ")

pct=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
[ "${pct:-0}" -lt "$DISK_MAX_PCT" ] || problems+=("القرص على ${pct:-?}% (الحد $DISK_MAX_PCT%)")

# ---------- الحالة والتنبيه ----------
now=$(date +%s)
prev_status="ok"
prev_since="$now"
prev_alert=0
if [ -f "$STATE" ]; then
  # shellcheck source=/dev/null
  . "$STATE"
  prev_status="${STATUS:-ok}"
  prev_since="${SINCE:-$now}"
  prev_alert="${LAST_ALERT:-0}"
fi

human_duration() {
  local s=$1 h m
  h=$((s / 3600)); m=$(((s % 3600) / 60))
  if [ "$h" -gt 0 ]; then echo "${h} ساعة و${m} دقيقة"; else echo "${m} دقيقة"; fi
}

stamp=$(date -u +'%H:%M UTC · %Y-%m-%d')

if [ ${#problems[@]} -eq 0 ]; then
  refresh_secrets
  if [ "$prev_status" = "fail" ]; then
    tg_send "✅ لوحة المتابعة رجعت تشتغل
كانت واقعة $(human_duration $((now - prev_since)))
$stamp"
    log "✅ رجعت بعد $(human_duration $((now - prev_since)))"
  fi
  printf 'STATUS=ok\nSINCE=%s\nLAST_ALERT=0\n' "$now" > "$STATE"
  # الدق بعد النجاح بس — الفشل معناه إن الدق يقف والخدمة الخارجية تصرخ
  [ -n "$PING_URL" ] && curl -sS -m 10 -o /dev/null "$PING_URL" 2>/dev/null
  [ "$TEST_MODE" = "1" ] && tg_send "🧪 اختبار المراقبة — كل الفحوصات سليمة
الخدمة · التطبيق · التانل · الموقع · postgres · القرص ${pct}%
$stamp"
else
  body=$(printf '• %s\n' "${problems[@]}")
  if [ "$prev_status" != "fail" ]; then
    tg_send "🔴 لوحة المتابعة فيها مشكلة
$body
$stamp"
    log "🔴 عطل: ${problems[*]}"
    printf 'STATUS=fail\nSINCE=%s\nLAST_ALERT=%s\n' "$now" "$now" > "$STATE"
  elif [ $((now - prev_alert)) -ge "$REMIND_SECONDS" ]; then
    tg_send "🔴 لسه واقعة — بقالها $(human_duration $((now - prev_since)))
$body
$stamp"
    log "🔁 تذكير: ${problems[*]}"
    printf 'STATUS=fail\nSINCE=%s\nLAST_ALERT=%s\n' "$prev_since" "$now" > "$STATE"
  else
    printf 'STATUS=fail\nSINCE=%s\nLAST_ALERT=%s\n' "$prev_since" "$prev_alert" > "$STATE"
  fi
  [ "$TEST_MODE" = "1" ] && tg_send "🧪 اختبار المراقبة — لقى مشاكل:
$body
$stamp"
fi

trim_log
exit 0
