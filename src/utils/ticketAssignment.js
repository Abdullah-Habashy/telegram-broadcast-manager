// توزيع التذاكر الجديدة بالتبادل (دور ثابت) على موظفي صندوق الدعم — يُستدعى فقط عند إنشاء تذكرة
// جديدة تمامًا (أول رسالة بيننا وبين الطالب مطلقًا)، مش عند أي تحديث لتذكرة موجودة أصلًا.
// لازم يتنفّذ جوّه نفس الـ transaction اللي بتنشئ التذكرة، وبنفس الـ client، عشان قفل الصف
// (FOR UPDATE) يمنع تسابق عمليتين بيحصلوا في نفس اللحظة على نفس الدور.
async function getNextTicketAssignee(client) {
  const eligibleResult = await client.query(
    `SELECT id FROM users
     WHERE is_active = TRUE AND role = 'agent' AND can_view_tickets = TRUE
       AND team IS NULL
     ORDER BY id ASC`
  );
  const eligibleIds = eligibleResult.rows.map((row) => row.id);
  if (!eligibleIds.length) return null;

  const settingResult = await client.query(
    "SELECT value FROM settings WHERE key = 'ticket_distribution_last_assigned_user_id' FOR UPDATE"
  );
  const lastAssignedId = settingResult.rows[0]?.value ? Number(settingResult.rows[0].value) : null;

  // لو آخر موظف اتاخدله دور بقى غير مؤهل دلوقتي (اتعطّل حسابه أو اتشالت منه الصلاحية)،
  // indexOf هترجع -1 فالدور يبدأ من أول موظف في الترتيب تلقائيًا من غير ما يبوّظ حاجة
  const lastIndex = lastAssignedId !== null ? eligibleIds.indexOf(lastAssignedId) : -1;
  const nextUserId = eligibleIds[(lastIndex + 1) % eligibleIds.length];

  await client.query(
    `INSERT INTO settings (key, value) VALUES ('ticket_distribution_last_assigned_user_id', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(nextUserId)]
  );

  return nextUserId;
}

// دور التيم المتخصص — نفس فكرة الدور اللي فوق بالظبط، بفرقين: المرشحين هما موظفين التيم
// المطلوب **الحاضرين دلوقتي بس** (عندهم صف مفتوح في team_attendance)، ولكل تيم دوره المستقل
// عشان تحويل للعلمي مايزحّش دور الدعم الفني.
//
// بيرجّع null لو مفيش حد حاضر — والمستدعي بيتصرف (بيبعت للطالب رسالة "بره المواعيد") بدل
// ما يحوّل التذكرة لطابور مخفي محدش بيبصله
async function getNextTeamAgent(client, teamKey) {
  const eligibleResult = await client.query(
    `SELECT u.id FROM users u
     JOIN team_attendance ta ON ta.user_id = u.id AND ta.ended_at IS NULL
     WHERE u.is_active = TRUE AND u.team = $1
     ORDER BY u.id ASC`,
    [teamKey]
  );
  const eligibleIds = eligibleResult.rows.map((row) => row.id);
  if (!eligibleIds.length) return null;

  const settingKey = `team_distribution_last_assigned_${teamKey}`;
  const settingResult = await client.query(
    'SELECT value FROM settings WHERE key = $1 FOR UPDATE', [settingKey]
  );
  const lastAssignedId = settingResult.rows[0]?.value ? Number(settingResult.rows[0].value) : null;
  // لو آخر واحد اتاخدله دور انصرف، indexOf بترجع -1 والدور يبدأ من أول حاضر — نفس سلوك الدور الأصلي
  const lastIndex = lastAssignedId !== null ? eligibleIds.indexOf(lastAssignedId) : -1;
  const nextUserId = eligibleIds[(lastIndex + 1) % eligibleIds.length];

  await client.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [settingKey, String(nextUserId)]
  );
  return nextUserId;
}

module.exports = { getNextTicketAssignee, getNextTeamAgent };
