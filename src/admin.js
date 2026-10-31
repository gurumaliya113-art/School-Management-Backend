'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one, all, tx, getSettings, audit } = require('./db');
const { need, can, passwordProblem } = require('./auth');
const { HttpError, today, wrap } = require('./crud');
const { sendXlsx, readXlsx } = require('./excel');
const { ROLES, MODULES, ENTITIES } = require('./schema');
const { feeHash, verifyChain, studentDues, LEDGER_COLS } = require('./fees');

const router = express.Router();
const ROLE_KEYS = ROLES.map((r) => r.key);
const LEVELS = ['none', 'view', 'edit'];
const isAdmin = (req) => req.user.role === 'admin';

// ---------- Users ----------
router.get('/users', need('users', 'view'), wrap(async (req, res) => {
  res.json(await all(`SELECT id, username, full_name, role, status, must_change, last_login, created_at,
    (locked_until > now()) AS locked FROM app_users ORDER BY id`));
}));

function checkUserChange(req, target, role) {
  if (!ROLE_KEYS.includes(role)) throw new HttpError(400, 'Invalid role');
  if (!isAdmin(req) && (role === 'admin' || target?.role === 'admin')) throw new HttpError(403, 'Only an Administrator can manage Administrator accounts');
  if (!isAdmin(req) && role === req.user.role && target?.id !== req.user.id) {
    // e.g. a principal cannot create another principal
    throw new HttpError(403, 'You cannot give someone the same access level as yours');
  }
}

router.post('/users', need('users', 'edit'), wrap(async (req, res) => {
  const { username, full_name, role, password } = req.body || {};
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(String(username || ''))) throw new HttpError(400, 'Username: 3-30 letters, numbers, dot, dash or underscore');
  if (!String(full_name || '').trim()) throw new HttpError(400, 'Full name is required');
  checkUserChange(req, null, role);
  const prob = passwordProblem(password); if (prob) throw new HttpError(400, prob);
  if (await one('SELECT 1 FROM app_users WHERE lower(username)=lower($1)', [username])) throw new HttpError(409, 'Username already taken');
  const u = await one(`INSERT INTO app_users(username, full_name, role, pass_hash, must_change) VALUES ($1,$2,$3,$4,TRUE)
    RETURNING id, username, full_name, role, status`, [username, String(full_name).trim().slice(0, 100), role, await bcrypt.hash(password, 12)]);
  await audit(req, 'user_created', 'users', u.id, { username, role });
  res.status(201).json(u);
}));

router.put('/users/:id', need('users', 'edit'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const t = await one('SELECT * FROM app_users WHERE id=$1', [id]);
  if (!t) throw new HttpError(404, 'User not found');
  const role = req.body?.role ?? t.role; const status = req.body?.status ?? t.status;
  const full_name = String(req.body?.full_name ?? t.full_name).trim().slice(0, 100);
  if (!['Active', 'Suspended'].includes(status)) throw new HttpError(400, 'Invalid status');
  if (id === req.user.id && (role !== t.role || status !== t.status)) throw new HttpError(400, 'You cannot change your own role or status');
  checkUserChange(req, t, role);
  if (t.role === 'admin' && (role !== 'admin' || status !== 'Active')) {
    const admins = (await one(`SELECT count(*)::int AS n FROM app_users WHERE role='admin' AND status='Active'`)).n;
    if (admins <= 1) throw new HttpError(400, 'At least one active Administrator is required');
  }
  await q('UPDATE app_users SET role=$1, status=$2, full_name=$3 WHERE id=$4', [role, status, full_name, id]);
  if (status !== 'Active' || role !== t.role) await q('DELETE FROM app_sessions WHERE user_id=$1', [id]);
  await audit(req, 'user_updated', 'users', id, { role: [t.role, role], status: [t.status, status] });
  res.json({ ok: true });
}));

router.post('/users/:id/reset-password', need('users', 'edit'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const t = await one('SELECT * FROM app_users WHERE id=$1', [id]);
  if (!t) throw new HttpError(404, 'User not found');
  checkUserChange(req, t, t.role);
  const prob = passwordProblem(req.body?.password); if (prob) throw new HttpError(400, prob);
  await q('UPDATE app_users SET pass_hash=$1, must_change=TRUE, failed_count=0, locked_until=NULL WHERE id=$2', [await bcrypt.hash(req.body.password, 12), id]);
  await q('DELETE FROM app_sessions WHERE user_id=$1', [id]);
  await audit(req, 'password_reset', 'users', id, { username: t.username });
  res.json({ ok: true });
}));

// ---------- Role permissions ----------
router.get('/perms', need('users', 'view'), wrap(async (req, res) => {
  const rows = await all('SELECT role, module, level FROM role_perms');
  const map = {};
  for (const r of rows) (map[r.role] ||= {})[r.module] = r.level;
  for (const m of MODULES) (map.admin ||= {})[m.key] = 'edit';
  res.json(map);
}));

router.put('/perms/:role', need('users', 'edit'), wrap(async (req, res) => {
  const role = req.params.role;
  if (!ROLE_KEYS.includes(role)) throw new HttpError(400, 'Invalid role');
  if (role === 'admin') throw new HttpError(400, 'Administrator always has full access');
  if (!isAdmin(req) && role === req.user.role) throw new HttpError(403, 'You cannot change the access of your own role');
  const levels = req.body || {};
  await tx(async (c) => {
    for (const m of MODULES) {
      const lvl = levels[m.key];
      if (lvl === undefined) continue;
      if (!LEVELS.includes(lvl)) throw new HttpError(400, 'Invalid level');
      if (!isAdmin(req) && ['users', 'backup', 'audit', 'settings'].includes(m.key) && lvl === 'edit') {
        throw new HttpError(403, 'Only the Administrator can give edit access to System sections');
      }
      await c.query(`INSERT INTO role_perms(role, module, level) VALUES ($1,$2,$3) ON CONFLICT (role, module) DO UPDATE SET level=EXCLUDED.level`, [role, m.key, lvl]);
    }
    await audit(req, 'perms_changed', 'role_perms', null, { role, levels }, c);
  });
  res.json({ ok: true });
}));

// ---------- Settings ----------
const SETTING_KEYS = ['school_name', 'school_address', 'school_phone', 'school_email', 'affiliation_no', 'udise_code',
  'principal_name', 'academic_year', 'session_start_month', 'receipt_prefix'];

router.get('/settings', need('settings', 'view'), wrap(async (req, res) => res.json(await getSettings())));

router.put('/settings', need('settings', 'edit'), wrap(async (req, res) => {
  const body = req.body || {};
  if (body.academic_year !== undefined && !/^\d{4}-\d{2}$/.test(body.academic_year)) throw new HttpError(400, 'Academic year format: 2026-27');
  if (body.session_start_month !== undefined && !(Number(body.session_start_month) >= 1 && Number(body.session_start_month) <= 12)) throw new HttpError(400, 'Invalid month');
  if (body.receipt_prefix !== undefined && !/^[A-Za-z0-9/-]{1,12}$/.test(body.receipt_prefix)) throw new HttpError(400, 'Receipt prefix: letters, numbers, / or - (max 12)');
  const before = await getSettings(); const changes = {};
  for (const k of SETTING_KEYS) {
    if (body[k] === undefined) continue;
    const v = String(body[k]).trim().slice(0, 300);
    await q('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
    if (before[k] !== v) changes[k] = { from: before[k], to: v };
  }
  await audit(req, 'settings_changed', 'settings', null, changes);
  res.json({ ok: true });
}));

// ---------- Backup ----------
const ledgerSheet = (rows) => ({ name: 'Fee Ledger', columns: LEDGER_COLS.map((k) => ({ header: k, key: k, width: k === 'hash' || k === 'prev_hash' ? 66 : 16 })), rows });

router.get('/backup/fees.xlsx', need('backup', 'view'), wrap(async (req, res) => {
  const rows = await all('SELECT * FROM fee_payments ORDER BY id');
  await audit(req, 'backup_fees', 'backup', null, { count: rows.length });
  await sendXlsx(res, `FEE-BACKUP-${today()}.xlsx`, [ledgerSheet(rows)]);
}));

router.get('/backup/full.xlsx', need('backup', 'view'), wrap(async (req, res) => {
  const sheets = [ledgerSheet(await all('SELECT * FROM fee_payments ORDER BY id'))];
  for (const [name, e] of Object.entries(ENTITIES)) {
    const rows = await all(`SELECT * FROM "${name}" ORDER BY id`);
    const cols = ['id', ...e.fields.map((f) => f.k), ...(name === 'leaves' ? ['user_id'] : []), 'created_at'];
    sheets.push({ name, columns: cols.map((k) => ({ header: k, key: k })), rows });
  }
  const extra = {
    attendance: ['date', 'student_id', 'class_id', 'status', 'remark'],
    marks: ['exam_id', 'student_id', 'subject_id', 'marks'],
    settings: ['key', 'value'],
  };
  for (const [t, cols] of Object.entries(extra)) sheets.push({ name: t, columns: cols.map((k) => ({ header: k, key: k })), rows: await all(`SELECT ${cols.join(',')} FROM ${t}`) });
  sheets.push({ name: 'users', columns: ['id', 'username', 'full_name', 'role', 'status'].map((k) => ({ header: k, key: k })), rows: await all('SELECT id, username, full_name, role, status FROM app_users ORDER BY id') });
  await audit(req, 'backup_full', 'backup', null, {});
  await sendXlsx(res, `FULL-BACKUP-${today()}.xlsx`, sheets);
}));

// Restore fee receipts from a backup Excel. Only rows whose hash is still valid are accepted,
// so an edited Excel file cannot be used to insert fake receipts.
router.post('/backup/restore-fees', express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
  if (!isAdmin(req)) throw new HttpError(403, 'Only the Administrator can restore fee data');
  if (!req.body?.length) throw new HttpError(400, 'Upload the FEE-BACKUP Excel file');
  let sheets;
  try { sheets = await readXlsx(req.body); } catch { throw new HttpError(400, 'This is not a valid Excel (.xlsx) file'); }
  const rows = sheets['Fee Ledger'];
  if (!rows) throw new HttpError(400, 'Sheet "Fee Ledger" not found. Use a file downloaded from Backup.');
  const norm = (v) => (v === '' || v === undefined ? null : v);
  const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const parsed = rows.filter((r) => r.receipt_no).map((r) => ({
    ...r, id: Number(r.id), date: dateStr(r.date), student_id: Number(r.student_id), total: Number(r.total),
    items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    txn_ref: norm(r.txn_ref),
  })).sort((a, b) => a.id - b.id);

  const result = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7002)');
    let added = 0, skipped = 0; const rejected = [];
    for (const r of parsed) {
      if (feeHash(r) !== r.hash) { rejected.push(r.receipt_no); continue; }
      const exists = (await c.query('SELECT 1 FROM fee_payments WHERE receipt_no=$1', [r.receipt_no])).rowCount;
      if (exists) { skipped++; continue; }
      await c.query(`INSERT INTO fee_payments(receipt_no, date, academic_year, student_id, student_name, admission_no, class_name, father_name,
        items, total, mode, txn_ref, remark, collected_by, created_at, prev_hash, hash, status, void_reason, voided_by, voided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [r.receipt_no, r.date, r.academic_year, r.student_id, r.student_name, r.admission_no, norm(r.class_name), norm(r.father_name),
        JSON.stringify(r.items), r.total, r.mode, r.txn_ref, norm(r.remark), r.collected_by, r.created_at, r.prev_hash, r.hash,
        r.status === 'Void' ? 'Void' : 'Paid', norm(r.void_reason), norm(r.voided_by), r.voided_at ? new Date(r.voided_at) : null]);
      added++;
    }
    // keep receipt numbering ahead of restored receipts
    const maxN = (await c.query(`SELECT max(NULLIF(regexp_replace(receipt_no,'\\D','','g'),'')::bigint) AS n FROM fee_payments`)).rows[0].n || 0;
    await c.query(`UPDATE settings SET value=GREATEST(value::bigint, $1)::text WHERE key='next_receipt'`, [Number(maxN) + 1]);
    await audit(req, 'fees_restored', 'backup', null, { added, skipped, rejected: rejected.length }, c);
    return { added, skipped, rejected };
  });
  res.json({ ...result, chain: await verifyChain() });
}));

// ---------- Audit log ----------
router.get('/audit', need('audit', 'view'), wrap(async (req, res) => {
  const p = []; const w = [];
  if (req.query.q) { p.push(`%${String(req.query.q).slice(0, 100)}%`); w.push(`(username || ' ' || action || ' ' || COALESCE(entity,'') || ' ' || COALESCE(details::text,'')) ILIKE $${p.length}`); }
  if (req.query.date) { p.push(String(req.query.date)); w.push(`at::date = $${p.length}::date`); }
  res.json(await all(`SELECT * FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`, p));
}));

// ---------- Reports ----------
router.get('/reports/summary', need('reports', 'view'), wrap(async (req, res) => {
  const from = String(req.query.from || `${today().slice(0, 4)}-01-01`); const to = String(req.query.to || today());
  const out = { from, to };
  if (can(req, 'fees')) {
    out.fee_by_month = await all(`SELECT to_char(date,'YYYY-MM') AS month, count(*)::int AS receipts, sum(total) AS total FROM fee_payments
      WHERE status='Paid' AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to]);
    out.fee_by_mode = await all(`SELECT mode, sum(total) AS total FROM fee_payments WHERE status='Paid' AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  }
  if (can(req, 'expenses')) {
    out.expense_by_category = await all(`SELECT category, sum(amount) AS total FROM expenses WHERE status<>'Cancelled' AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  }
  if (can(req, 'attendance')) {
    out.attendance_by_class = await all(`SELECT c.name || ' - ' || COALESCE(c.section,'') AS class_name,
      round(100.0 * count(*) FILTER (WHERE a.status IN ('Present','Late')) / NULLIF(count(*),0)) AS pct
      FROM attendance a JOIN classes c ON c.id=a.class_id WHERE a.date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to]);
  }
  res.json(out);
}));

router.get('/reports/dues.xlsx', need('fees', 'view'), wrap(async (req, res) => {
  const settings = await getSettings();
  const p = []; let w = "status='Active'";
  if (req.query.class_id) { p.push(Number(req.query.class_id)); w += ' AND class_id=$1'; }
  const ids = (await all(`SELECT id FROM students WHERE ${w}`, p)).map((r) => r.id);
  const rows = await studentDues(ids, settings);
  await sendXlsx(res, `fee-dues-${today()}.xlsx`, [{
    name: 'Fee Dues',
    columns: [{ header: 'Admission No', key: 'admission_no' }, { header: 'Student', key: 'name', width: 22 }, { header: 'Class', key: 'class_name' },
      { header: 'Father', key: 'father_name', width: 18 }, { header: 'Phone', key: 'phone', width: 14 }, { header: 'Annual Fee', key: 'annual' },
      { header: 'Due Till Now', key: 'due_now' }, { header: 'Paid', key: 'paid' }, { header: 'Balance Due', key: 'balance' }],
    rows,
  }]);
}));

module.exports = { router };
