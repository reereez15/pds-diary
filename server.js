const express = require('express');
const cors = require('cors');
const path = require('path');
const { pool, initSchema, uid } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const now = () => new Date().toISOString();

// 라우트 안 에러를 매번 try/catch 안 쓰고 한 번에 처리하기 위한 래퍼
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function one(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}
async function all(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function run(sql, params) {
  const [result] = await pool.query(sql, params);
  return result;
}

// ---------- 카드 1: 계획 (plans) ----------

app.get('/api/plans', ah(async (req, res) => {
  res.json(await all('SELECT * FROM plans ORDER BY period_start DESC, created_at DESC'));
}));

app.get('/api/plans/:id', ah(async (req, res) => {
  const row = await one('SELECT * FROM plans WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
}));

app.post('/api/plans', ah(async (req, res) => {
  const { title, period_start, period_end, priority, success_criteria, estimated_minutes } = req.body;
  if (!title || !period_start || !period_end || !priority || !success_criteria || estimated_minutes == null) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const id = uid();
  const t = now();
  await run(
    `INSERT INTO plans (id, title, period_start, period_end, priority, success_criteria, estimated_minutes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, title, period_start, period_end, priority, success_criteria, estimated_minutes, t, t]
  );
  res.status(201).json(await one('SELECT * FROM plans WHERE id = ?', [id]));
}));

app.put('/api/plans/:id', ah(async (req, res) => {
  const existing = await one('SELECT * FROM plans WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  // T06-C08: 고쳐도 이전 계획이 그대로 남아 있어야 함 -> 수정 전 스냅샷을 이력에 저장
  await run(
    'INSERT INTO plan_history (id, plan_id, snapshot, edited_at) VALUES (?,?,?,?)',
    [uid(), existing.id, JSON.stringify(existing), now()]
  );

  const { title, period_start, period_end, priority, success_criteria, estimated_minutes } = req.body;
  const merged = {
    title: title ?? existing.title,
    period_start: period_start ?? existing.period_start,
    period_end: period_end ?? existing.period_end,
    priority: priority ?? existing.priority,
    success_criteria: success_criteria ?? existing.success_criteria,
    estimated_minutes: estimated_minutes ?? existing.estimated_minutes,
  };
  await run(
    `UPDATE plans SET title=?, period_start=?, period_end=?, priority=?, success_criteria=?, estimated_minutes=?, updated_at=?
     WHERE id=?`,
    [merged.title, merged.period_start, merged.period_end, merged.priority, merged.success_criteria, merged.estimated_minutes, now(), existing.id]
  );
  res.json(await one('SELECT * FROM plans WHERE id = ?', [existing.id]));
}));

app.get('/api/plans/:id/history', ah(async (req, res) => {
  const rows = await all('SELECT * FROM plan_history WHERE plan_id = ? ORDER BY edited_at DESC', [req.params.id]);
  res.json(rows.map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) })));
}));

// ---------- 카드 2: 할 일 (tasks) ----------

app.get('/api/tasks', ah(async (req, res) => {
  const { plan_id, search, status, priority, tag, sort } = req.query;
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  if (plan_id) { sql += ' AND plan_id = ?'; params.push(plan_id); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (tag) { sql += ' AND tags LIKE ?'; params.push(`%${tag}%`); }
  if (search) { sql += ' AND title LIKE ?'; params.push(`%${search}%`); }

  const sortMap = {
    due_date: 'due_date ASC',
    priority: "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC",
    created_at: 'created_at DESC',
  };
  sql += ' ORDER BY ' + (sortMap[sort] || sortMap.created_at);

  res.json(await all(sql, params));
}));

app.post('/api/tasks', ah(async (req, res) => {
  const { plan_id, title, due_date, priority, tags, estimated_minutes } = req.body;
  if (!plan_id || !title) return res.status(400).json({ error: 'missing_fields' });
  const plan = await one('SELECT id FROM plans WHERE id = ?', [plan_id]);
  if (!plan) return res.status(400).json({ error: 'invalid_plan_id' });

  const id = uid();
  const t = now();
  await run(
    `INSERT INTO tasks (id, plan_id, title, due_date, priority, tags, estimated_minutes, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'todo', ?, ?)`,
    [id, plan_id, title, due_date || null, priority || 'medium', tags || '', estimated_minutes || 0, t, t]
  );
  res.status(201).json(await one('SELECT * FROM tasks WHERE id = ?', [id]));
}));

app.put('/api/tasks/:id', ah(async (req, res) => {
  const existing = await one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { title, due_date, priority, tags, estimated_minutes } = req.body;
  const merged = {
    title: title ?? existing.title,
    due_date: due_date ?? existing.due_date,
    priority: priority ?? existing.priority,
    tags: tags ?? existing.tags,
    estimated_minutes: estimated_minutes ?? existing.estimated_minutes,
  };
  await run(
    `UPDATE tasks SET title=?, due_date=?, priority=?, tags=?, estimated_minutes=?, updated_at=? WHERE id=?`,
    [merged.title, merged.due_date, merged.priority, merged.tags, merged.estimated_minutes, now(), existing.id]
  );
  res.json(await one('SELECT * FROM tasks WHERE id = ?', [existing.id]));
}));

app.delete('/api/tasks/:id', ah(async (req, res) => {
  const existing = await one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await run('DELETE FROM logs WHERE task_id = ?', [existing.id]);
  await run('DELETE FROM tasks WHERE id = ?', [existing.id]);
  res.json({ ok: true });
}));

app.post('/api/tasks/:id/reopen', ah(async (req, res) => {
  const existing = await one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  await run(`UPDATE tasks SET status='todo', completed_at=NULL, updated_at=? WHERE id=?`, [now(), existing.id]);
  res.json(await one('SELECT * FROM tasks WHERE id = ?', [existing.id]));
}));

// ---------- 카드 3: 실제로 한 일 (완료 + 실행 기록) ----------
// 완료 버튼을 연달아 두 번 눌러도 로그/집계가 한 건만 늘어나야 함 -> 이미 done이면 새 로그를 만들지 않고 기존 로그를 반환
app.post('/api/tasks/:id/complete', ah(async (req, res) => {
  const task = await one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'not_found' });

  if (task.status === 'done') {
    const log = await one('SELECT * FROM logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', [task.id]);
    return res.json({ task, log, duplicate: true });
  }

  const { start_time, end_time, actual_minutes, blocked_reason } = req.body;
  if (!start_time || !end_time || actual_minutes == null) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const logId = uid();
  const t = now();
  await run(
    `INSERT INTO logs (id, task_id, start_time, end_time, actual_minutes, blocked_reason, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [logId, task.id, start_time, end_time, actual_minutes, blocked_reason || '', t]
  );
  await run(`UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?`, [t, t, task.id]);

  res.json({
    task: await one('SELECT * FROM tasks WHERE id = ?', [task.id]),
    log: await one('SELECT * FROM logs WHERE id = ?', [logId]),
    duplicate: false,
  });
}));

app.get('/api/tasks/:id/logs', ah(async (req, res) => {
  res.json(await all('SELECT * FROM logs WHERE task_id = ? ORDER BY created_at DESC', [req.params.id]));
}));

// ---------- 카드 4: 돌아보기 (집계 + 드릴다운) ----------

app.get('/api/review', ah(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'missing_range' });

  const planCountRow = await one(
    'SELECT COUNT(*) c FROM plans WHERE period_start <= ? AND period_end >= ?', [end, start]
  );

  const tasksInRange = await all(`
    SELECT t.* FROM tasks t JOIN plans p ON t.plan_id = p.id
    WHERE p.period_start <= ? AND p.period_end >= ?
  `, [end, start]);

  const completedCount = tasksInRange.filter(t => t.status === 'done').length;
  const today = now().slice(0, 10);
  const delayedCount = tasksInRange.filter(t => t.status !== 'done' && t.due_date && t.due_date < today).length;

  const blockedRows = await all(`
    SELECT DISTINCT l.task_id FROM logs l
    JOIN tasks t ON l.task_id = t.id
    JOIN plans p ON t.plan_id = p.id
    WHERE p.period_start <= ? AND p.period_end >= ? AND l.blocked_reason != ''
  `, [end, start]);
  const blockedCount = blockedRows.length;

  const estimatedSum = tasksInRange.reduce((s, t) => s + (t.estimated_minutes || 0), 0);
  const actualRows = await all(`
    SELECT l.actual_minutes FROM logs l
    JOIN tasks t ON l.task_id = t.id
    JOIN plans p ON t.plan_id = p.id
    WHERE p.period_start <= ? AND p.period_end >= ?
  `, [end, start]);
  const actualSum = actualRows.reduce((s, r) => s + (r.actual_minutes || 0), 0);

  res.json({
    period_start: start,
    period_end: end,
    plan_count: planCountRow.c,
    completed_count: completedCount,
    delayed_count: delayedCount,
    blocked_count: blockedCount,
    estimated_minutes_sum: estimatedSum,
    actual_minutes_sum: actualSum,
    diff_minutes: actualSum - estimatedSum,
  });
}));

// 집계 숫자를 눌렀을 때 그 숫자가 나온 기록으로 이동하기 위한 드릴다운
app.get('/api/review/drilldown', ah(async (req, res) => {
  const { start, end, type } = req.query;
  if (!start || !end || !type) return res.status(400).json({ error: 'missing_params' });

  const tasksInRange = await all(`
    SELECT t.* FROM tasks t JOIN plans p ON t.plan_id = p.id
    WHERE p.period_start <= ? AND p.period_end >= ?
  `, [end, start]);

  const today = now().slice(0, 10);
  let result;
  if (type === 'plans') {
    result = await all('SELECT * FROM plans WHERE period_start <= ? AND period_end >= ?', [end, start]);
  } else if (type === 'completed') {
    result = tasksInRange.filter(t => t.status === 'done');
  } else if (type === 'delayed') {
    result = tasksInRange.filter(t => t.status !== 'done' && t.due_date && t.due_date < today);
  } else if (type === 'blocked') {
    const blockedIdRows = await all(`
      SELECT DISTINCT l.task_id id FROM logs l
      JOIN tasks t ON l.task_id = t.id
      JOIN plans p ON t.plan_id = p.id
      WHERE p.period_start <= ? AND p.period_end >= ? AND l.blocked_reason != ''
    `, [end, start]);
    const ids = new Set(blockedIdRows.map(r => r.id));
    result = tasksInRange.filter(t => ids.has(t.id));
  } else {
    return res.status(400).json({ error: 'invalid_type' });
  }
  res.json(result);
}));

app.post('/api/reviews', ah(async (req, res) => {
  const { period_start, period_end, next_plan_note } = req.body;
  if (!period_start || !period_end || !next_plan_note) return res.status(400).json({ error: 'missing_fields' });
  const id = uid();
  await run(
    'INSERT INTO reviews (id, period_start, period_end, next_plan_note, created_at) VALUES (?,?,?,?,?)',
    [id, period_start, period_end, next_plan_note, now()]
  );
  res.status(201).json(await one('SELECT * FROM reviews WHERE id = ?', [id]));
}));

app.get('/api/reviews', ah(async (req, res) => {
  res.json(await all('SELECT * FROM reviews ORDER BY created_at DESC'));
}));

// 공통 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`PDS diary server on :${PORT}`));
  })
  .catch((err) => {
    console.error('DB 스키마 초기화 실패:', err && err.message);
    console.error('상세 정보:', err && err.code, err && err.errno, err && err.stack);
    if (err && err.errors) {
      err.errors.forEach((e, i) => console.error(`  하위 에러 ${i}:`, e && e.message, e && e.code));
    }
    process.exit(1);
  });
