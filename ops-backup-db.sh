#!/bin/bash
# ---------------------------------------------------------------------------
# نسخة احتياطية يومية لقاعدة بيانات لوحة المتابعة.
#
# الإنتاج مش git repo ومفيش rollback، والنسخة دي هي وسيلة الرجوع الوحيدة لو
# migration غلط أو DELETE بالخطأ ضيّع بيانات. بتشتغل من cron كل يوم.
#
# النسخ بيتكتب في ملف مؤقت الأول وبيتنقل مكانه النهائي بعد التأكد إنه سليم:
# dump فاضي أو مقطوع أخطر من مفيش dump خالص، لأنه بياخد دور في الاحتفاظ
# ويطرد نسخة كويسة من الـ 14 يوم. والحذف بيتم بعد نجاح النسخة الجديدة بس.
# ---------------------------------------------------------------------------
set -euo pipefail

DB="telegram_broadcast_manager"
DIR="/root/backups/db"
KEEP_DAYS=14
MIN_BYTES=1000000          # النسخة الطبيعية ~8 ميجا؛ أي حاجة تحت الميجا معناها dump مقطوع
LOG="/root/backups/backup.log"

mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%d-%H%M%S)
FINAL="$DIR/$DB-$STAMP.dump"
TMP="$FINAL.part"

log() { echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

fail() {
  log "❌ فشل: $*"
  rm -f "$TMP"
  exit 1
}

# -Fc = صيغة pg_dump المضغوطة، وهي اللي pg_restore بيقرأها ويسمح باستعادة جدول واحد
sudo -u postgres pg_dump -Fc --no-owner --no-acl "$DB" > "$TMP" 2>>"$LOG" \
  || fail "pg_dump رجع خطأ"

SIZE=$(stat -c %s "$TMP")
[ "$SIZE" -ge "$MIN_BYTES" ] || fail "حجم النسخة $SIZE بايت وده أقل من الحد الأدنى $MIN_BYTES"

# قراءة فهرس الـ dump: بتفشل لو الملف مقطوع، فدي أرخص تحقق حقيقي من سلامته
pg_restore --list "$TMP" > /dev/null 2>>"$LOG" \
  || fail "الملف مش dump سليم (pg_restore --list فشل)"

mv "$TMP" "$FINAL"
chmod 600 "$FINAL"

# الحذف بعد النجاح بس — لو النسخة النهاردة فشلت، النسخ القديمة بتفضل مكانها
DELETED=$(find "$DIR" -maxdepth 1 -name "$DB-*.dump" -type f -mtime +$KEEP_DAYS -print -delete | wc -l)

log "✅ $(basename "$FINAL") · $(numfmt --to=iec "$SIZE") · اتحذف $DELETED نسخة قديمة · الإجمالي $(find "$DIR" -name "$DB-*.dump" | wc -l) نسخة"
