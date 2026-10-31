'use strict';
const express = require('express');
const { ENTITIES } = require('./schema');
const { q, one, all, audit } = require('./db');
const { can } = require('./auth');
const { sendXlsx } = require('./excel');

const router = express.Router();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata' });
const nowTime = () => new Date().toLocaleTimeString('en-GB', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

// Which modules may see id/label options for an entity (used for dropdowns).
const optionModules = {};
for (const [name, e] of Object.entries(ENTITIES)) {
  (optionModules[name] ||= new Set()).add(e.module);
  for (const f of e.fields) if (f.type === 'ref') (optionModules[f.ref] ||= new Set()).add(e.module);
}
optionModules.students.add('fees').add('attendance').add('exams');
optionModules.classes.add('fees').add('attendance').add('exams').add('reports');
optionModules.exams.add('reports');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function getEntity(req) {
  const e = ENTITIES[req.params.entity];
  if (!e || !Object.prototype.hasOwnProperty.call(ENTITIES, req.params.entity)) throw new HttpError(404, 'Unknown section');
  return [req.params.entity, e];
}

function visibleFields(req, e) {
  return e.fields.filter((f) => !f.sensitive || can(req, f.sensitive, 'view'));
}

function selfOnly(req, e) { return e.selfService && !can(req, e.module, 'edit'); }

function listSql(req, name, e, { search, filters, limit, offset }) {
  const fields = visibleFields(req, e);
  const cols = ['m.id', 'm.created_at', ...fields.map((f) => `m."${f.k}"`)];
  if (name === 'leaves') cols.push('m.user_id');
  for (const f of fields) {
    if (f.type === 'ref') cols.push(`(SELECT ${ENTITIES[f.ref].display} FROM "${f.ref}" t WHERE t.id=m."${f.k}") AS "${f.k}__label"`);
  }
  for (const c of e.computed || []) cols.push(`${c.sql} AS "${c.k}"`);

  const where = []; const params = [];
  if (search) {
    params.push(`%${search}%`);
    const textCols = fields.filter((f) => f.type !== 'ref').map((f) => `m."${f.k}"::text`);
    const refCols = fields.filter((f) => f.type === 'ref').map((f) => `(SELECT ${ENTITIES[f.ref].display} FROM "${f.ref}" t WHERE t.id=m."${f.k}")`);
    where.push(`concat_ws(' ', ${[...textCols, ...refCols].join(', ')}) ILIKE $${params.length}`);
  }
  for (const [k, v] of Object.entries(filters || {})) {
    const f = fields.find((x) => x.k === k);
    if (!f || v === '' || v == null) continue;
    params.push(f.type === 'ref' ? Number(v) : String(v));
    where.push(`m."${k}"${f.type === 'date' ? '::text' : ''} = $${params.length}`);
  }
  if (selfOnly(req, e)) { params.push(req.user.id); where.push(`m.user_id = $${params.length}`); }

  let sql = `SELECT ${cols.join(', ')} FROM "${name}" m ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${e.order || 'm.id DESC'}`;
  if (limit) { params.push(limit, offset || 0); sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`; }
  return { sql, params };
}

function parseFilters(query) {
  const out = {};
  for (const [k, v] of Object.entries(query)) if (k.startsWith('f_') && typeof v === 'string') out[k.slice(2)] = v;
  return out;
}

// Validate + coerce a request body against the entity schema.
function clean(req, name, e, body, isCreate) {
  const out = {};
  const isEditor = can(req, e.module, 'edit');
  for (const f of visibleFields(req, e)) {
    if (f.auto) continue;
    if (f.approverOnly && !isEditor) continue;
    let v = body?.[f.k];
    if (v === undefined) {
      if (!isCreate) continue;
      if (f.def !== undefined) v = f.def === 'today' ? today() : f.def === 'now' ? nowTime() : f.def;
    }
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      switch (f.type) {
        case 'number': v = Number(v); if (!Number.isFinite(v) || Math.abs(v) > 1e12) throw new HttpError(400, `${f.label} must be a number`); break;
        case 'ref': v = Number(v); if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, `${f.label} is invalid`); break;
        case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, `${f.label} must be a date`); break;
        case 'time': if (!/^\d{2}:\d{2}(:\d{2})?$/.test(String(v))) throw new HttpError(400, `${f.label} must be a time`); break;
        case 'select': if (!f.options.includes(v)) throw new HttpError(400, `${f.label} has an invalid value`); break;
        case 'phone': v = String(v); if (!/^[0-9+\-\s()]{5,20}$/.test(v)) throw new HttpError(400, `${f.label} is not a valid phone number`); break;
        default: v = String(v); if (v.length > (f.type === 'textarea' ? 10000 : 500)) throw new HttpError(400, `${f.label} is too long`);
      }
    }
    if (f.req && v === null && (isCreate || f.k in (body || {}))) throw new HttpError(400, `${f.label} is required`);
    out[f.k] = v;
  }
  if (name === 'leaves' && isCreate) {
    out.person_name = req.user.full_name;
    out.user_id = req.user.id;
    if (!isEditor) out.status = 'Pending';
  }
  if (name === 'leaves' && out.from_date && out.to_date && out.to_date < out.from_date) throw new HttpError(400, 'To date is before From date');
  return out;
}

function needLevel(level) {
  return (req, res, next) => {
    const [, e] = getEntity(req);
    const ok = can(req, e.module, level) || (level === 'edit' && req.method === 'POST' && e.selfService && can(req, e.module, 'view'));
    if (!ok) return res.status(403).json({ error: 'You do not have access to this section' });
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/:entity/options', wrap(async (req, res) => {
  const [name, e] = getEntity(req);
  if (![...optionModules[name]].some((m) => can(req, m, 'view'))) return res.status(403).json({ error: 'No access' });
  const extra = name === 'students' ? ', m.class_id' : '';
  const rows = await all(`SELECT m.id, (SELECT ${e.display} FROM "${name}" t WHERE t.id=m.id) AS label${extra} FROM "${name}" m ORDER BY 2 LIMIT 5000`);
  res.json(rows);
}));

router.get('/:entity', needLevel('view'), wrap(async (req, res) => {
  const [name, e] = getEntity(req);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const filters = parseFilters(req.query);
  const { sql, params } = listSql(req, name, e, { search, filters, limit, offset });
  const rows = await all(sql, params);
  const c = listSql(req, name, e, { search, filters });
  const total = (await one(`SELECT count(*)::int AS n FROM (${c.sql}) x`, c.params)).n;
  res.json({ rows, total });
}));

router.get('/:entity/export.xlsx', needLevel('view'), wrap(async (req, res) => {
  const [name, e] = getEntity(req);
  const { sql, params } = listSql(req, name, e, { search: String(req.query.q || ''), filters: parseFilters(req.query) });
  const rows = await all(sql, params);
  const fields = visibleFields(req, e);
  const columns = [{ header: 'ID', key: 'id', width: 8 },
    ...fields.map((f) => ({ header: f.label, key: f.type === 'ref' ? `${f.k}__label` : f.k })),
    ...(e.computed || []).map((c) => ({ header: c.label, key: c.k }))];
  await audit(req, 'export', name, null, { count: rows.length });
  await sendXlsx(res, `${name}-${today()}.xlsx`, [{ name: e.plural, columns, rows }]);
}));

router.get('/:entity/:id', needLevel('view'), wrap(async (req, res) => {
  const [name, e] = getEntity(req);
  const { sql, params } = listSql(req, name, e, {});
  params.push(Number(req.params.id));
  const row = await one(`SELECT * FROM (${sql}) x WHERE x.id = $${params.length}`, params);
  if (!row) throw new HttpError(404, 'Not found');
  res.json(row);
}));

router.post('/:entity', needLevel('edit'), wrap(async (req, res) => {
  const [name, e] = getEntity(req);
  const data = clean(req, name, e, req.body, true);
  if (name === 'book_issues') {
    const b = await one(`SELECT total - (SELECT count(*) FROM book_issues WHERE book_id=$1 AND status='Issued') AS avail FROM books WHERE id=$1`, [data.book_id]);
    if (!b || b.avail <= 0) throw new HttpError(400, 'No copies of this book are available');
  }
  const keys = Object.keys(data);
  const row = await one(`INSERT INTO "${name}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map((k) => data[k]));
  await audit(req, 'create', name, row.id, data);
  res.status(201).json(row);
}));

router.put('/:entity/:id', needLevel('edit'), wrap(async (req, res) => {
  const [name, e] = getEntity(req);
  const id = Number(req.params.id);
  const before = await one(`SELECT * FROM "${name}" WHERE id=$1`, [id]);
  if (!before) throw new HttpError(404, 'Not found');
  const data = clean(req, name, e, req.body, false);
  const keys = Object.keys(data);
  if (!keys.length) return res.json(before);
  const row = await one(`UPDATE "${name}" SET ${keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`,
    [...keys.map((k) => data[k]), id]);
  const changes = {};
  for (const k of keys) if (String(before[k] ?? '') !== String(row[k] ?? '')) changes[k] = { from: before[k], to: row[k] };
  await audit(req, 'update', name, id, changes);
  res.json(row);
}));

router.delete('/:entity/:id', needLevel('edit'), wrap(async (req, res) => {
  const [name] = getEntity(req);
  const id = Number(req.params.id);
  const before = await one(`SELECT * FROM "${name}" WHERE id=$1`, [id]);
  if (!before) throw new HttpError(404, 'Not found');
  if (name === 'students' && (await one('SELECT 1 FROM fee_payments WHERE student_id=$1 LIMIT 1', [id]))) {
    throw new HttpError(400, 'This student has fee records. Mark the student as "Left" instead of deleting.');
  }
  await q(`DELETE FROM "${name}" WHERE id=$1`, [id]);
  await audit(req, 'delete', name, id, before);
  res.json({ ok: true });
}));

module.exports = { router, HttpError, today, wrap };
