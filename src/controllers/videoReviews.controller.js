const pool = require('../config/db');
const { storeFile } = require('../utils/objectStorage');
const { buildVideoReviewPdf, formatTimecode, toSeconds } = require('../utils/videoReviewExport');

// ---------- مراجعة الفيديوهات ----------
//
// التيم العلمي بيتفرّج على الفيديو المصوَّر ويسجّل كل غلطة: الفيديو، التوقيت بالساعة
// والدقيقة والثانية، صورة الشاشة، وتعليق بالعربي. والمونتير بيفتح نفس الشاشة (أو
// الـPDF) ويعدّل على بريمير وبيعلّم الغلطة إنها اتصلّحت.
//
// **الصلاحية واحدة للتبويب كله** (`requireQuizAccessApi` — الأدمن والعلمي والفني)،
// والفرق بين اللي بيسجّل واللي بيصلّح مش صلاحيات: أي حد داخل يقدر يسجّل ويقدر يعلّم.
// تعقيد صلاحيات تانية هنا كان هيقفل الباب على المونتير لو حسابه اتعمل بتيم مختلف.

const STATUSES = ['open', 'fixed', 'rejected'];

// ملاحظة الموظف بتتعدّل من صاحبها أو من الأدمن. الأدمن مستثنى في كل حتة في المشروع
function canEditNote(note, req) {
  return req.session.userRole === 'admin' || note.created_by === req.session.userId;
}

// ---------- الكتب ----------

async function listBooks(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.sort_order, b.is_active,
              COUNT(v.id)::int AS videos_count
         FROM video_books b
         LEFT JOIN review_videos v ON v.book_id = b.id
        GROUP BY b.id
        ORDER BY b.sort_order, b.name`
    );
    res.json({ books: rows });
  } catch (error) {
    console.error('❌ Failed to list video books:', error.message);
    res.status(500).json({ error: 'تعذر قراءة قايمة الكتب' });
  }
}

async function createBook(req, res) {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اكتب اسم الكتاب' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO video_books (name, sort_order)
       VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM video_books), 1))
       RETURNING id, name, sort_order, is_active`,
      [name]
    );
    res.json({ book: { ...rows[0], videos_count: 0 } });
  } catch (error) {
    // 23505 = تكرار على UNIQUE. الرسالة العامة كانت هتخلي المستخدم يجرّب نفس الاسم تاني
    if (error.code === '23505') return res.status(409).json({ error: 'فيه كتاب بنفس الاسم بالفعل' });
    console.error('❌ Failed to create a video book:', error.message);
    res.status(500).json({ error: 'تعذر إضافة الكتاب' });
  }
}

async function updateBook(req, res) {
  const id = Number(req.params.id);
  const name = req.body?.name === undefined ? null : String(req.body.name || '').trim();
  if (name !== null && !name) return res.status(400).json({ error: 'اكتب اسم الكتاب' });
  try {
    const { rows } = await pool.query(
      `UPDATE video_books
          SET name = COALESCE($2, name),
              is_active = COALESCE($3, is_active)
        WHERE id = $1
        RETURNING id, name, sort_order, is_active`,
      [id, name, req.body?.is_active === undefined ? null : Boolean(req.body.is_active)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'الكتاب مش موجود' });
    res.json({ book: rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'فيه كتاب بنفس الاسم بالفعل' });
    console.error('❌ Failed to update a video book:', error.message);
    res.status(500).json({ error: 'تعذر تعديل الكتاب' });
  }
}

async function deleteBook(req, res) {
  const id = Number(req.params.id);
  try {
    // الحذف ممنوع لو تحته فيديوهات (ON DELETE RESTRICT في القاعدة). بنسبق القاعدة
    // برسالة مفهومة بدل ما الموظف يشوف خطأ سيرفر، وبنقترح عليه الأرشفة
    const used = await pool.query('SELECT COUNT(*)::int AS count FROM review_videos WHERE book_id = $1', [id]);
    if (used.rows[0].count > 0) {
      return res.status(409).json({
        error: `الكتاب ده تحته ${used.rows[0].count} فيديو. أرشفه بدل ما تمسحه عشان الملاحظات ماتضيعش.`,
      });
    }
    const { rowCount } = await pool.query('DELETE FROM video_books WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'الكتاب مش موجود' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete a video book:', error.message);
    res.status(500).json({ error: 'تعذر حذف الكتاب' });
  }
}

// ---------- الفيديوهات ----------

// كارت الفيديو بيعرض عدّاد لكل حالة. الحساب هنا بـFILTER مش بتلات استعلامات — القايمة
// بتتفتح مع كل دخول للتبويب
async function listVideos(req, res) {
  const bookId = Number(req.query.book_id) || null;
  const search = String(req.query.q || '').trim();
  const includeArchived = req.query.include_archived === '1';
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.title, v.video_number, v.file_name, v.is_active, v.created_at,
              v.book_id, b.name AS book_name,
              COUNT(n.id)::int AS notes_count,
              COUNT(n.id) FILTER (WHERE n.status = 'open')::int AS open_count,
              COUNT(n.id) FILTER (WHERE n.status = 'fixed')::int AS fixed_count,
              COUNT(n.id) FILTER (WHERE n.status = 'rejected')::int AS rejected_count
         FROM review_videos v
         JOIN video_books b ON b.id = v.book_id
         LEFT JOIN video_review_notes n ON n.video_id = v.id
        WHERE ($1::int IS NULL OR v.book_id = $1)
          AND ($2::boolean OR v.is_active)
          AND ($3 = '' OR v.title ILIKE '%' || $3 || '%' OR COALESCE(v.file_name, '') ILIKE '%' || $3 || '%')
        GROUP BY v.id, b.name
        ORDER BY v.is_active DESC, b.name, v.video_number NULLS LAST, v.title`,
      [bookId, includeArchived, search]
    );
    res.json({ videos: rows });
  } catch (error) {
    console.error('❌ Failed to list review videos:', error.message);
    res.status(500).json({ error: 'تعذر قراءة قايمة الفيديوهات' });
  }
}

async function createVideo(req, res) {
  const bookId = Number(req.body?.book_id);
  const title = String(req.body?.title || '').trim();
  if (!bookId) return res.status(400).json({ error: 'اختار الكتاب' });
  if (!title) return res.status(400).json({ error: 'اكتب اسم الفيديو' });
  const videoNumber = req.body?.video_number === '' || req.body?.video_number === undefined || req.body?.video_number === null
    ? null : Number(req.body.video_number);
  if (videoNumber !== null && !Number.isFinite(videoNumber)) {
    return res.status(400).json({ error: 'رقم الفيديو لازم يكون رقم' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO review_videos (book_id, title, video_number, file_name, created_by)
       VALUES ($1, $2, $3, NULLIF($4, ''), $5)
       RETURNING id`,
      [bookId, title, videoNumber, String(req.body?.file_name || '').trim(), req.session.userId]
    );
    res.json({ id: rows[0].id });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'فيه فيديو بنفس الاسم تحت نفس الكتاب' });
    if (error.code === '23503') return res.status(400).json({ error: 'الكتاب المختار مش موجود' });
    console.error('❌ Failed to create a review video:', error.message);
    res.status(500).json({ error: 'تعذر إضافة الفيديو' });
  }
}

async function updateVideo(req, res) {
  const id = Number(req.params.id);
  const title = req.body?.title === undefined ? null : String(req.body.title || '').trim();
  if (title !== null && !title) return res.status(400).json({ error: 'اكتب اسم الفيديو' });
  const rawNumber = req.body?.video_number;
  const videoNumber = rawNumber === undefined ? undefined : (rawNumber === '' || rawNumber === null ? null : Number(rawNumber));
  if (videoNumber !== undefined && videoNumber !== null && !Number.isFinite(videoNumber)) {
    return res.status(400).json({ error: 'رقم الفيديو لازم يكون رقم' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE review_videos
          SET title = COALESCE($2, title),
              book_id = COALESCE($3, book_id),
              -- الرقم واسم الملف بيتشالوا بقيمة فاضية، فـCOALESCE مابينفعش معاهم:
              -- بنبعت علم منفصل يقول "الحقل ده اتبعت أصلًا ولا لأ"
              video_number = CASE WHEN $4 THEN $5 ELSE video_number END,
              file_name = CASE WHEN $6 THEN NULLIF($7, '') ELSE file_name END,
              is_active = COALESCE($8, is_active)
        WHERE id = $1
        RETURNING id`,
      [
        id, title,
        req.body?.book_id === undefined ? null : Number(req.body.book_id),
        videoNumber !== undefined, videoNumber === undefined ? null : videoNumber,
        req.body?.file_name !== undefined, String(req.body?.file_name || '').trim(),
        req.body?.is_active === undefined ? null : Boolean(req.body.is_active),
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'الفيديو مش موجود' });
    res.json({ ok: true });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'فيه فيديو بنفس الاسم تحت نفس الكتاب' });
    console.error('❌ Failed to update a review video:', error.message);
    res.status(500).json({ error: 'تعذر تعديل الفيديو' });
  }
}

// حذف الفيديو بيمسح ملاحظاته وصورها معاه (CASCADE) ومفيش رجوع. **بيتنفّذ بتأكيد تاني
// صريح** — نفس نمط حذف اختبار عليه محاولات بالظبط: الرفض الأول بيقول العدد وبيقترح
// الأرشفة، والتأكيد بيمشّي الحذف. الأرشفة بتخفيه من القوايم من غير ما تضيّع شغل حد
async function deleteVideo(req, res) {
  const id = Number(req.params.id);
  try {
    const notes = await pool.query('SELECT COUNT(*)::int AS count FROM video_review_notes WHERE video_id = $1', [id]);
    if (notes.rows[0].count > 0 && req.body?.confirm !== true) {
      return res.status(409).json({
        error: `الفيديو ده عليه ${notes.rows[0].count} ملاحظة وحذفه هيمسحها كلها. أرشفه بدل ما تمسحه، أو أكّد الحذف.`,
        needs_confirmation: true,
        notes_count: notes.rows[0].count,
      });
    }
    const { rowCount } = await pool.query('DELETE FROM review_videos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'الفيديو مش موجود' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete a review video:', error.message);
    res.status(500).json({ error: 'تعذر حذف الفيديو' });
  }
}

// ---------- الملاحظات (الأغلاط) ----------

const NOTE_SELECT = `
  SELECT n.id, n.video_id, n.timecode_seconds, n.screenshot_path, n.comment, n.status,
         n.created_at, n.updated_at, n.resolved_at, n.resolution_note,
         n.created_by, u.name AS created_by_name, r.name AS resolved_by_name
    FROM video_review_notes n
    LEFT JOIN users u ON u.id = n.created_by
    LEFT JOIN users r ON r.id = n.resolved_by`;

async function listNotes(req, res) {
  const videoId = Number(req.params.id);
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  try {
    const video = await pool.query(
      `SELECT v.id, v.title, v.video_number, v.file_name, v.is_active, b.name AS book_name
         FROM review_videos v JOIN video_books b ON b.id = v.book_id WHERE v.id = $1`,
      [videoId]
    );
    if (!video.rows[0]) return res.status(404).json({ error: 'الفيديو مش موجود' });

    // الترتيب بالتوقيت مش بوقت التسجيل: المونتير بيمشي على الفيديو من أوله لآخره مرة واحدة
    const { rows } = await pool.query(
      `${NOTE_SELECT} WHERE n.video_id = $1 AND ($2::text IS NULL OR n.status = $2)
        ORDER BY n.timecode_seconds, n.id`,
      [videoId, status]
    );
    res.json({
      video: video.rows[0],
      notes: rows.map((note) => ({ ...note, timecode: formatTimecode(note.timecode_seconds) })),
    });
  } catch (error) {
    console.error('❌ Failed to list video review notes:', error.message);
    res.status(500).json({ error: 'تعذر قراءة الملاحظات' });
  }
}

// الواجهة بتبعت ساعة/دقيقة/ثانية، والاستيراد أو أي نداء تاني ممكن يبعت الثواني جاهزة
function readTimecode(body) {
  if (body?.timecode_seconds !== undefined && body.timecode_seconds !== null && body.timecode_seconds !== '') {
    const value = Number(body.timecode_seconds);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  const { hours, minutes, seconds } = body || {};
  if ([hours, minutes, seconds].every((part) => part === undefined || part === null || part === '')) return null;
  const parts = [hours, minutes, seconds].map((part) => (part === '' || part === undefined || part === null ? 0 : Number(part)));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return toSeconds({ hours: parts[0], minutes: parts[1], seconds: parts[2] });
}

async function createNote(req, res) {
  const videoId = Number(req.params.id);
  const comment = String(req.body?.comment || '').trim();
  const timecode = readTimecode(req.body);
  if (timecode === null) return res.status(400).json({ error: 'حدّد توقيت الغلطة (ساعة/دقيقة/ثانية)' });
  if (!comment) return res.status(400).json({ error: 'اكتب تعليق يشرح الغلطة' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO video_review_notes (video_id, timecode_seconds, screenshot_path, comment, created_by)
       VALUES ($1, $2, NULLIF($3, ''), $4, $5)
       RETURNING id`,
      [videoId, timecode, String(req.body?.screenshot_path || '').trim(), comment, req.session.userId]
    );
    res.json({ id: rows[0].id });
  } catch (error) {
    if (error.code === '23503') return res.status(404).json({ error: 'الفيديو مش موجود' });
    console.error('❌ Failed to create a video review note:', error.message);
    res.status(500).json({ error: 'تعذر حفظ الملاحظة' });
  }
}

async function updateNote(req, res) {
  const id = Number(req.params.noteId);
  const comment = req.body?.comment === undefined ? null : String(req.body.comment || '').trim();
  if (comment !== null && !comment) return res.status(400).json({ error: 'اكتب تعليق يشرح الغلطة' });
  const timecode = req.body?.timecode_seconds !== undefined || req.body?.hours !== undefined
    ? readTimecode(req.body) : undefined;
  if (timecode === null) return res.status(400).json({ error: 'توقيت غير صحيح' });
  try {
    const existing = await pool.query('SELECT created_by FROM video_review_notes WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'الملاحظة مش موجودة' });
    if (!canEditNote(existing.rows[0], req)) {
      return res.status(403).json({ error: 'الملاحظة دي مش بتاعتك — تقدر تعلّم عليها بس' });
    }
    await pool.query(
      `UPDATE video_review_notes
          SET comment = COALESCE($2, comment),
              timecode_seconds = COALESCE($3, timecode_seconds),
              screenshot_path = CASE WHEN $4 THEN NULLIF($5, '') ELSE screenshot_path END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        id, comment, timecode === undefined ? null : timecode,
        req.body?.screenshot_path !== undefined, String(req.body?.screenshot_path || '').trim(),
      ]
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to update a video review note:', error.message);
    res.status(500).json({ error: 'تعذر تعديل الملاحظة' });
  }
}

// ---------- تعليم الغلطة ----------
//
// **التعليق إجباري مع الرفض** — نفس قاعدة رفض تظلم الطالب بالظبط: «مش غلطة» من غير سبب
// بترجع تاني في صورة نفس الملاحظة، والتيم يفتكر إن محدش بص.
async function setNoteStatus(req, res) {
  const id = Number(req.params.noteId);
  const status = String(req.body?.status || '');
  const note = String(req.body?.resolution_note || '').trim();
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'حالة غير معروفة' });
  if (status === 'rejected' && !note) {
    return res.status(400).json({ error: 'اكتب سبب إنها مش غلطة — التيم محتاج يعرف ليه' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE video_review_notes
          SET status = $2,
              resolution_note = NULLIF($3, ''),
              -- الرجوع لـ"مفتوحة" بيصفّر اللي حسمها: الاسم والتاريخ القديم كانوا
              -- هيفضلوا يقولوا إنها اتقفلت وهي مفتوحة.
              --
              -- ⚠️ **"هل رجعت مفتوحة" بيتبعت براميتر منطقي لوحده ($4) مش مقارنة على
              -- $2.** استخدام نفس البراميتر مرة كقيمة للعمود (varchar) ومرة في
              -- مقارنة نصية بيخلي Postgres يرفض الاستعلام كله:
              -- "inconsistent types deduced for parameter $2" — والكاست الصريح
              -- مابيحلّهاش. اتكشف بتشغيل الدالة على القاعدة فعلًا، والفحص النحوي
              -- عدّى عليها عادي
              -- و$5::int لأن CASE مع NULL في الفرع التاني بيخلي نوع البراميتر
              -- يتحدد نصًا، والعمود integer
              resolved_by = CASE WHEN $4 THEN NULL ELSE $5::int END,
              resolved_at = CASE WHEN $4 THEN NULL ELSE NOW() END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [id, status, note, status === 'open', req.session.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'الملاحظة مش موجودة' });
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to change a video review note status:', error.message);
    res.status(500).json({ error: 'تعذر تغيير الحالة' });
  }
}

async function deleteNote(req, res) {
  const id = Number(req.params.noteId);
  try {
    const existing = await pool.query('SELECT created_by FROM video_review_notes WHERE id = $1', [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'الملاحظة مش موجودة' });
    if (!canEditNote(existing.rows[0], req)) {
      return res.status(403).json({ error: 'الملاحظة دي مش بتاعتك' });
    }
    await pool.query('DELETE FROM video_review_notes WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Failed to delete a video review note:', error.message);
    res.status(500).json({ error: 'تعذر حذف الملاحظة' });
  }
}

// صورة الشاشة. **نفس مجلد وحدود صور الأسئلة** — ومحتاجة تفضل متاحة للتصدير، فبتتخزّن
// زي أي مرفق تاني: على القرص، أو على التخزين السحابي لو مفعّل
async function uploadScreenshot(req, res) {
  if (!req.file) return res.status(400).json({ error: 'مفيش صورة مرفوعة' });
  const stored = await storeFile(req.file.path, `uploads/${req.file.filename}`);
  res.json({ path: stored.startsWith('http') ? stored : `/${stored}` });
}

// ---------- تصدير PDF ----------
//
// الفلتر هو نفسه فلتر الشاشة: فيديو واحد، أو كتاب كامل، أو حالة معيّنة. المونتير في
// الغالب بياخد «المفتوح في الفيديو ده» ويقعد يشتغل عليه
async function exportNotes(req, res) {
  const videoId = Number(req.query.video_id) || null;
  const bookId = Number(req.query.book_id) || null;
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  try {
    // **استعلام صريح مش معمول من `NOTE_SELECT`** — التصدير محتاج أعمدة الفيديو والكتاب
    // في نفس الصف، والتركيب على ثابت جاهز بيخلي أي تعديل عليه يكسر ده من غير ما يبان
    const { rows } = await pool.query(
      `SELECT n.id, n.video_id, n.timecode_seconds, n.screenshot_path, n.comment, n.status,
              n.created_at, n.resolved_at, n.resolution_note,
              u.name AS created_by_name, r.name AS resolved_by_name,
              v.title AS video_title, v.video_number, v.file_name, b.name AS book_name
         FROM video_review_notes n
         JOIN review_videos v ON v.id = n.video_id
         JOIN video_books b ON b.id = v.book_id
         LEFT JOIN users u ON u.id = n.created_by
         LEFT JOIN users r ON r.id = n.resolved_by
        WHERE ($1::int IS NULL OR n.video_id = $1)
          AND ($2::int IS NULL OR v.book_id = $2)
          AND ($3::text IS NULL OR n.status = $3)
        ORDER BY b.sort_order, b.name, v.video_number NULLS LAST, v.title, n.timecode_seconds`,
      [videoId, bookId, status]
    );

    // تجميع الملاحظات تحت فيديوهاتها بالترتيب اللي رجع من الاستعلام — الـPDF بيطبع
    // عنوان لكل فيديو مرة واحدة
    const videos = [];
    rows.forEach((row) => {
      const last = videos[videos.length - 1];
      if (!last || last.id !== row.video_id) {
        videos.push({
          id: row.video_id,
          title: row.video_title,
          video_number: row.video_number,
          file_name: row.file_name,
          book_name: row.book_name,
          notes: [],
        });
      }
      videos[videos.length - 1].notes.push(row);
    });

    const title = videos.length === 1
      ? `أغلاط: ${videos[0].book_name} — ${videos[0].title}`
      : 'أغلاط مراجعة الفيديوهات';
    const buffer = await buildVideoReviewPdf(videos, { title, generatedBy: req.session.userName || '' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="video-review-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(buffer);
  } catch (error) {
    console.error('❌ Failed to export video review notes:', error.message);
    res.status(500).json({ error: 'تعذر إنشاء ملف الـPDF' });
  }
}

module.exports = {
  listBooks, createBook, updateBook, deleteBook,
  listVideos, createVideo, updateVideo, deleteVideo,
  listNotes, createNote, updateNote, setNoteStatus, deleteNote,
  uploadScreenshot, exportNotes,
};
