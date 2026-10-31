'use strict';
const crypto = require('crypto');
const express = require('express');
const { one, all, tx, getSettings, audit } = require('./db');
const { need } = require('./auth');
const { HttpError, today, wrap } = require('./crud');
const { sendXlsx } = require('./excel');

const router = express.Router();
const MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque', 'DD'];
const PER_YEAR = { 'One-Time': 1, Monthly: 12, Quarterly: 4, 'Half-Yearly': 2, Yearly: 1 };
const GENESIS = 'GENESIS';
const SECRET = process.env.FEE_HMAC_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('FEE_HMAC_SECRET must be set (at least 32 random characters). It protects fee records from tampering.');
  process.exit(1);
}

// Hash covers every money-related field + the previous receipt's hash.
// Without FEE_HMAC_SECRET nobody (even with direct DB access) can forge a valid chain.
function feeHash(r) {
  const canon = JSON.stringify([
    r.prev_hash, r.receipt_no, String(r.date), r.academic_year, Number(r.student_id), r.admission_no,
    Number(r.total).toFixed(2), (r.items || []).map((i) => [i.fee_type, i.period || '', Number(i.amount).toFixed(2)]),
    r.mode, r.txn_ref || '', r.collected_by, r.created_at,
  ]);
  return crypto.createHmac('sha256', SECRET).update(canon).digest('hex');
}

function monthsElapsed(settings) {
  const startYear = parseInt(String(settings.academic_year).slice(0, 4), 10);
  const startMonth = parseInt(settings.session_start_month || '4', 10);
  const [ty, tm] = today().split('-').map(Number);
  const m = (ty - startYear) * 12 + (tm - startMonth) + 1;
  return Math.max(1, Math.min(12, m));
}

async function studentDues(studentIds, settings) {
  if (!studentIds.length) return [];
  const months = monthsElapsed(settings);
  const students = await all(`SELECT s.id, s.name, s.admission_no, s.father_name, s.phone, s.class_id, s.concession_pct,
      c.name || ' - ' || COALESCE(c.section,'') AS class_name, r.monthly_fee AS route_fee, h.monthly_fee AS hostel_fee
    FROM students s LEFT JOIN classes c ON c.id=s.class_id LEFT JOIN routes r ON r.id=s.route_id
    LEFT JOIN rooms rm ON rm.id=s.room_id LEFT JOIN hostels h ON h.id=rm.hostel_id
    WHERE s.id = ANY($1::int[]) ORDER BY c.name, s.roll_no, s.name`, [studentIds]);
  const structure = await all('SELECT * FROM fee_structure ORDER BY id');
  const paid = await all(`SELECT student_id, sum(total) AS paid FROM fee_payments
    WHERE status='Paid' AND academic_year=$1 AND student_id = ANY($2::int[]) GROUP BY student_id`, [settings.academic_year, studentIds]);
  const paidMap = Object.fromEntries(paid.map((p) => [p.student_id, Number(p.paid)]));

  return students.map((s) => {
    const lines = structure.filter((f) => f.class_id === s.class_id).map((f) => {
      const per = PER_YEAR[f.frequency] || 1;
      const dueCount = f.frequency === 'Monthly' ? months : f.frequency === 'Quarterly' ? Math.ceil(months / 3)
        : f.frequency === 'Half-Yearly' ? Math.ceil(months / 6) : 1;
      return { fee_type: f.fee_type, frequency: f.frequency, amount: Number(f.amount), annual: Number(f.amount) * per, due_now: Number(f.amount) * dueCount };
    });
    if (s.route_fee) lines.push({ fee_type: 'Transport Fee', frequency: 'Monthly', amount: s.route_fee, annual: s.route_fee * 12, due_now: s.route_fee * months });
    if (s.hostel_fee) lines.push({ fee_type: 'Hostel Fee', frequency: 'Monthly', amount: s.hostel_fee, annual: s.hostel_fee * 12, due_now: s.hostel_fee * months });
    const conc = Math.max(0, Math.min(100, Number(s.concession_pct) || 0)) / 100;
    const annual = Math.round(lines.reduce((a, l) => a + l.annual, 0) * (1 - conc));
    const dueNow = Math.round(lines.reduce((a, l) => a + l.due_now, 0) * (1 - conc));
    const p = paidMap[s.id] || 0;
    return { ...s, lines, concession_pct: conc * 100, annual, due_now: dueNow, paid: p, balance: Math.max(0, dueNow - p), annual_balance: Math.max(0, annual - p) };
  });
}

router.get('/student/:id', need('fees', 'view'), wrap(async (req, res) => {
  const settings = await getSettings();
  const [d] = await studentDues([Number(req.params.id)], settings);
  if (!d) throw new HttpError(404, 'Student not found');
  const history = await all('SELECT * FROM fee_payments WHERE student_id=$1 ORDER BY id DESC', [d.id]);
  res.json({ ...d, history, academic_year: settings.academic_year, months_elapsed: monthsElapsed(settings) });
}));

router.get('/dues', need('fees', 'view'), wrap(async (req, res) => {
  const settings = await getSettings();
  const params = []; let where = "status='Active'";
  if (req.query.class_id) { params.push(Number(req.query.class_id)); where += ` AND class_id=$1`; }
  const ids = (await all(`SELECT id FROM students WHERE ${where}`, params)).map((r) => r.id);
  const rows = await studentDues(ids, settings);
  res.json({ rows, academic_year: settings.academic_year });
}));

router.post('/collect', need('fees', 'edit'), wrap(async (req, res) => {
  const { student_id, items, mode, txn_ref, remark } = req.body || {};
  const date = req.body?.date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) throw new HttpError(400, 'Invalid date (future dates not allowed)');
  if (!MODES.includes(mode)) throw new HttpError(400, 'Choose a payment mode');
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new HttpError(400, 'Add at least one fee item');
  const clean = items.map((i) => {
    const amount = Math.round(Number(i?.amount) * 100) / 100;
    const fee_type = String(i?.fee_type || '').trim().slice(0, 100);
    if (!fee_type) throw new HttpError(400, 'Fee type is required');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new HttpError(400, `Invalid amount for ${fee_type}`);
    return { fee_type, period: String(i?.period || '').trim().slice(0, 50), amount };
  });
  const total = Math.round(clean.reduce((a, i) => a + i.amount, 0) * 100) / 100;
  if (mode !== 'Cash' && !String(txn_ref || '').trim()) throw new HttpError(400, 'Transaction / cheque reference is required for non-cash payments');

  const row = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(7002)'); // one receipt at a time keeps the chain & numbering intact
    const s = (await c.query(`SELECT s.*, c.name || ' - ' || COALESCE(c.section,'') AS class_name FROM students s
      LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=$1`, [Number(student_id)])).rows[0];
    if (!s) throw new HttpError(404, 'Student not found');
    const set = Object.fromEntries((await c.query('SELECT key, value FROM settings')).rows.map((r) => [r.key, r.value]));
    const n = parseInt(set.next_receipt || '1', 10);
    await c.query(`UPDATE settings SET value=$1 WHERE key='next_receipt'`, [String(n + 1)]);
    const last = (await c.query('SELECT hash FROM fee_payments ORDER BY id DESC LIMIT 1')).rows[0];
    const r = {
      receipt_no: `${set.receipt_prefix || 'RCPT'}-${String(n).padStart(6, '0')}`,
      date, academic_year: set.academic_year, student_id: s.id, student_name: s.name, admission_no: s.admission_no,
      class_name: s.class_name, father_name: s.father_name, items: clean, total, mode,
      txn_ref: String(txn_ref || '').trim().slice(0, 100) || null, remark: String(remark || '').trim().slice(0, 300) || null,
      collected_by: `${req.user.full_name} (${req.user.username})`, created_at: new Date().toISOString(),
      prev_hash: last ? last.hash : GENESIS,
    };
    r.hash = feeHash(r);
    const ins = await c.query(`INSERT INTO fee_payments(receipt_no, date, academic_year, student_id, student_name, admission_no,
      class_name, father_name, items, total, mode, txn_ref, remark, collected_by, created_at, prev_hash, hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [r.receipt_no, r.date, r.academic_year, r.student_id, r.student_name, r.admission_no, r.class_name, r.father_name,
      JSON.stringify(r.items), r.total, r.mode, r.txn_ref, r.remark, r.collected_by, r.created_at, r.prev_hash, r.hash]);
    await audit(req, 'fee_collected', 'fee_payments', ins.rows[0].id, { receipt_no: r.receipt_no, total, mode, student: s.admission_no }, c);
    return ins.rows[0];
  });
  res.status(201).json(row);
}));

router.get('/payments', need('fees', 'view'), wrap(async (req, res) => {
  const where = []; const p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (req.query.q) add(`(receipt_no || ' ' || student_name || ' ' || admission_no) ILIKE ?`, `%${String(req.query.q).slice(0, 100)}%`);
  if (req.query.from) add('date >= ?', String(req.query.from));
  if (req.query.to) add('date <= ?', String(req.query.to));
  if (req.query.status) add('status = ?', String(req.query.status));
  if (req.query.student_id) add('student_id = ?', Number(req.query.student_id));
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await all(`SELECT * FROM fee_payments ${w} ORDER BY id DESC LIMIT 500`, p);
  const sum = await one(`SELECT count(*)::int AS n, COALESCE(sum(total) FILTER (WHERE status='Paid'),0) AS total FROM fee_payments ${w}`, p);
  res.json({ rows, ...sum });
}));

router.get('/payments/:id', need('fees', 'view'), wrap(async (req, res) => {
  const r = await one('SELECT * FROM fee_payments WHERE id=$1', [Number(req.params.id)]);
  if (!r) throw new HttpError(404, 'Receipt not found');
  res.json({ ...r, school: await getSettings() });
}));

router.post('/payments/:id/void', need('fees', 'edit'), wrap(async (req, res) => {
  if (!['admin', 'principal'].includes(req.user.role)) throw new HttpError(403, 'Only the Principal or Administrator can void a receipt');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'Please give a reason (at least 5 characters)');
  const id = Number(req.params.id);
  const r = await tx(async (c) => {
    const row = (await c.query(`UPDATE fee_payments SET status='Void', void_reason=$1, voided_by=$2, voided_at=now()
      WHERE id=$3 AND status='Paid' RETURNING *`, [reason.slice(0, 300), `${req.user.full_name} (${req.user.username})`, id])).rows[0];
    if (!row) throw new HttpError(400, 'Receipt not found or already void');
    await audit(req, 'fee_voided', 'fee_payments', id, { receipt_no: row.receipt_no, total: row.total, reason }, c);
    return row;
  });
  res.json(r);
}));

// Re-computes every hash. Any edit made directly in the database shows up here.
async function verifyChain() {
  const rows = await all('SELECT * FROM fee_payments ORDER BY id');
  const problems = [];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) problems.push({ receipt_no: r.receipt_no, problem: 'Chain broken: a receipt before this one was deleted or changed' });
    if (feeHash(r) !== r.hash) problems.push({ receipt_no: r.receipt_no, problem: 'Data changed after it was saved (amount/date/student/items tampered)' });
    prev = r.hash;
  }
  return { checked: rows.length, ok: problems.length === 0, problems: problems.slice(0, 200) };
}

router.get('/verify', need('fees', 'view'), wrap(async (req, res) => {
  const result = await verifyChain();
  await audit(req, 'fee_verify', 'fee_payments', null, { checked: result.checked, ok: result.ok });
  res.json(result);
}));

router.get('/dayclose', need('fees', 'view'), wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : today();
  const modes = await all(`SELECT mode, count(*)::int AS receipts, sum(total) AS total FROM fee_payments
    WHERE date=$1 AND status='Paid' GROUP BY mode ORDER BY mode`, [date]);
  const range = await one(`SELECT min(receipt_no) AS first, max(receipt_no) AS last, count(*)::int AS n,
    count(*) FILTER (WHERE status='Void')::int AS voids FROM fee_payments WHERE date=$1`, [date]);
  const byUser = await all(`SELECT collected_by, count(*)::int AS receipts, sum(total) AS total FROM fee_payments
    WHERE date=$1 AND status='Paid' GROUP BY collected_by`, [date]);
  res.json({ date, modes, range, byUser, grand: modes.reduce((a, m) => a + Number(m.total), 0) });
}));

const LEDGER_COLS = ['id', 'receipt_no', 'date', 'academic_year', 'student_id', 'student_name', 'admission_no', 'class_name', 'father_name',
  'items', 'total', 'mode', 'txn_ref', 'remark', 'collected_by', 'created_at', 'prev_hash', 'hash', 'status', 'void_reason', 'voided_by', 'voided_at'];

router.get('/export.xlsx', need('fees', 'view'), wrap(async (req, res) => {
  const p = []; const w = [];
  if (req.query.from) { p.push(String(req.query.from)); w.push(`date >= $${p.length}`); }
  if (req.query.to) { p.push(String(req.query.to)); w.push(`date <= $${p.length}`); }
  const rows = await all(`SELECT * FROM fee_payments ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id`, p);
  const flat = rows.map((r) => ({ ...r, items_text: r.items.map((i) => `${i.fee_type}${i.period ? ' (' + i.period + ')' : ''}: ${i.amount}`).join('; ') }));
  await audit(req, 'export', 'fee_payments', null, { count: rows.length });
  await sendXlsx(res, `fee-collection-${today()}.xlsx`, [{
    name: 'Fee Collection',
    columns: [
      { header: 'Receipt No', key: 'receipt_no', width: 16 }, { header: 'Date', key: 'date' }, { header: 'Student', key: 'student_name', width: 22 },
      { header: 'Admission No', key: 'admission_no' }, { header: 'Class', key: 'class_name' }, { header: 'Fee Items', key: 'items_text', width: 50 },
      { header: 'Total', key: 'total' }, { header: 'Mode', key: 'mode' }, { header: 'Txn Ref', key: 'txn_ref' },
      { header: 'Collected By', key: 'collected_by', width: 24 }, { header: 'Status', key: 'status' }, { header: 'Void Reason', key: 'void_reason', width: 24 },
    ],
    rows: flat,
  }]);
}));

module.exports = { router, verifyChain, feeHash, studentDues, LEDGER_COLS, GENESIS, MODES };
