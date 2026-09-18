/**
 * الجزء اللي بيشتغل **جوه بريمير** (ExtendScript).
 *
 * الواجهة (index.html) بتقرا ملف الماركرز وبتبعت هنا نص واحد، والدالة دي بتحط ماركر
 * عند كل توقيت على السيكوينس المفتوحة.
 *
 * ⚠️ **ExtendScript مش جافاسكريبت حديث (ES3):** مفيش `JSON` ومفيش `let` ومفيش دوال سهم
 * ومفيش `Array.prototype.indexOf` على كل الإصدارات. الكود هنا مكتوب بالقديم عن قصد —
 * أي تحديث بأسلوب حديث هيرمي خطأ وقت التشغيل جوه بريمير من غير رسالة مفهومة.
 *
 * **صيغة الحمولة** (الواجهة بتبنيها): سجلات مفصولة بـ`;` وكل سجل حقوله مفصولة بـ`|`:
 *
 *     id|seconds|colorIndex|encodedName|encodedComment ; id|seconds|...
 *
 * النصوص متمرّرة بـ`encodeURIComponent` — ودي مش زينة: بتضمن إن التعليق (اللي فيه عربي
 * وعلامات اقتباس وأسطر جديدة) مايكسرش النص، ومايقدرش يدخل كود جوه النداء.
 */

// ألوان الماركر في بريمير بالترتيب: 0 أخضر · 1 أحمر · 2 بنفسجي · 3 برتقالي · 4 أصفر
// · 5 أبيض · 6 أزرق · 7 سماوي.
// ⚠️ **لو الألوان طلعت غير المتوقّع عندك، الترتيب ده هو اللي يتظبّط** — الواجهة بتبعت
// الرقم زي ما هو.
function vrPing() {
  return 'ok';
}

// بترجّع أسماء الماركرز الموجودة عشان مانكررش نفس الغلطة لو السكربت اتشغّل مرتين
function vrExistingNames(sequence) {
  var names = {};
  var marker = sequence.markers.getFirstMarker();
  while (marker) {
    names[String(marker.name)] = true;
    marker = sequence.markers.getNextMarker(marker);
  }
  return names;
}

function vrAddMarkers(payload) {
  var sequence = app.project.activeSequence;
  if (!sequence) {
    return 'ERR|افتح السيكوينس اللي هتشتغل عليها الأول';
  }
  if (!payload) {
    return 'ERR|الملف فاضي';
  }

  var existing = vrExistingNames(sequence);
  var records = String(payload).split(';');
  var added = 0;
  var skipped = 0;
  var failed = 0;

  for (var i = 0; i < records.length; i++) {
    if (!records[i]) { continue; }
    var field = records[i].split('|');
    if (field.length < 5) { failed++; continue; }

    var seconds = parseFloat(field[1]);
    var colorIndex = parseInt(field[2], 10);
    var name = decodeURIComponent(field[3]);
    var comment = decodeURIComponent(field[4]);

    // **الاسم هو اللي بيمنع التكرار.** تشغيل اللوحة مرتين على نفس السيكوينس (وده
    // بيحصل: المونتير بيصلّح نص الملاحظات وبيرجع) كان هيحط نسختين من كل ماركر
    if (existing[name]) { skipped++; continue; }

    try {
      var marker = sequence.markers.createMarker(seconds);
      marker.name = name;
      marker.comments = comment;
      if (!isNaN(colorIndex)) {
        marker.setColorByIndex(colorIndex);
      }
      existing[name] = true;
      added++;
    } catch (error) {
      // ماركر واحد فشل مايوقّفش الباقي — المونتير محتاج اللي نفع، والرقم بيقوله فيه ناقص
      failed++;
    }
  }

  return 'OK|' + added + '|' + skipped + '|' + failed;
}
