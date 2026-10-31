'use strict';
const { Pool, types } = require('pg');
const { ENTITIES, ROLES, DEFAULT_PERMS, MODULES } = require('./schema');

// Return NUMERIC/BIGINT as JS numbers and DATE as plain 'YYYY-MM-DD' strings.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1082, (v) => v);

// Build the connection config ourselves. If the URL has ?sslmode=..., the pg library would
// override our SSL settings and Supabase connections fail with "self-signed certificate".
function dbConfig() {
  const raw = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) {
    console.error('DATABASE_URL is not set. Add it in Render/Railway → Environment (Supabase → Connect → Session pooler).');
    process.exit(1);
  }
  if (/\[YOUR-PASSWORD\]|\[|\]/.test(raw)) {
    console.error('DATABASE_URL still contains [YOUR-PASSWORD] or brackets. Put your real Supabase database password in it (without [ ]).');
    process.exit(1);
  }
  let u;
  try { u = new URL(raw); } catch {
    console.error('DATABASE_URL is not a valid URL. If your password has special characters like @ # / ? %, reset the Supabase DB password to letters+numbers only, or URL-encode it.');
    process.exit(1);
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(u.hostname)) {
    console.warn('WARNING: You are using the Supabase "Direct connection" host (IPv6 only). Render/Railway may not reach it. Use the "Session pooler" string (…pooler.supabase.com).');
  }
  const ssl = process.env.DB_SSL === 'false' ? false
    : process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n') }
      : { rejectUnauthorized: false };
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    ssl,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  };
}

const pool = new Pool(dbConfig());
pool.on('error', (e) => console.error('PG pool error', e.message));

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

// Run fn(client) inside a transaction.
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

const colType = (f) => {
  if (f.type === 'number') return 'NUMERIC';
  if (f.type === 'date') return 'DATE';
  if (f.type === 'ref') return `INTEGER REFERENCES "${f.ref}"(id) ON DELETE RESTRICT`;
  return 'TEXT';
};

// Create entity tables in dependency order so foreign keys resolve.
function entityOrder() {
  const out = []; const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return; seen.add(n);
    for (const f of ENTITIES[n].fields) if (f.type === 'ref' && f.ref !== n) visit(f.ref);
    out.push(n);
  };
  Object.keys(ENTITIES).forEach(visit);
  return out;
}

async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7001)'); // only one instance migrates at a time

    await c.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      must_change BOOLEAN NOT NULL DEFAULT TRUE,
      failed_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires TIMESTAMPTZ NOT NULL,
      ip TEXT
    );
    CREATE TABLE IF NOT EXISTS role_perms (
      role TEXT NOT NULL, module TEXT NOT NULL, level TEXT NOT NULL,
      PRIMARY KEY (role, module)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ DEFAULT now(),
      user_id INTEGER, username TEXT, action TEXT, entity TEXT, entity_id INTEGER, details JSONB, ip TEXT
    );`);

    for (const name of entityOrder()) {
      const e = ENTITIES[name];
      const cols = e.fields.map((f) => `"${f.k}" ${colType(f)}${f.unique ? ' UNIQUE' : ''}`);
      if (name === 'leaves') cols.push('user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL');
      await c.query(`CREATE TABLE IF NOT EXISTS "${name}" (id SERIAL PRIMARY KEY, ${cols.join(', ')},
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ)`);
      for (const f of e.fields) await c.query(`ALTER TABLE "${name}" ADD COLUMN IF NOT EXISTS "${f.k}" ${colType(f)}`);
    }

    await c.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      date DATE NOT NULL,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('Present','Absent','Late','Leave')),
      remark TEXT, marked_by INTEGER,
      PRIMARY KEY (date, student_id)
    );
    CREATE TABLE IF NOT EXISTS marks (
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      marks NUMERIC,
      PRIMARY KEY (exam_id, student_id, subject_id)
    );

    -- FEES: append-only ledger. Rows are never deleted or edited, only voided once.
    CREATE TABLE IF NOT EXISTS fee_payments (
      id SERIAL PRIMARY KEY,
      receipt_no TEXT UNIQUE NOT NULL,
      date DATE NOT NULL,
      academic_year TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      student_name TEXT NOT NULL,
      admission_no TEXT NOT NULL,
      class_name TEXT,
      father_name TEXT,
      items JSONB NOT NULL,
      total NUMERIC NOT NULL CHECK (total > 0),
      mode TEXT NOT NULL,
      txn_ref TEXT,
      remark TEXT,
      collected_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Paid',
      void_reason TEXT, voided_by TEXT, voided_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_fee_student ON fee_payments(student_id, academic_year);
    CREATE INDEX IF NOT EXISTS idx_fee_date ON fee_payments(date);
    CREATE INDEX IF NOT EXISTS idx_att_class ON attendance(class_id, date);

    CREATE OR REPLACE FUNCTION fee_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Fee records cannot be deleted. Void them instead.'; END IF;
      IF OLD.status = 'Void' THEN RAISE EXCEPTION 'This receipt is already void.'; END IF;
      IF (NEW.receipt_no, NEW.date, NEW.academic_year, NEW.student_id, NEW.student_name, NEW.admission_no,
          NEW.items, NEW.total, NEW.mode, NEW.txn_ref, NEW.collected_by, NEW.created_at, NEW.prev_hash, NEW.hash)
         IS DISTINCT FROM
         (OLD.receipt_no, OLD.date, OLD.academic_year, OLD.student_id, OLD.student_name, OLD.admission_no,
          OLD.items, OLD.total, OLD.mode, OLD.txn_ref, OLD.collected_by, OLD.created_at, OLD.prev_hash, OLD.hash)
      THEN RAISE EXCEPTION 'Fee records are locked. Only a one-time void is allowed.'; END IF;
      IF NEW.status <> 'Void' THEN RAISE EXCEPTION 'Only void is allowed.'; END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS fee_guard_trg ON fee_payments;
    CREATE TRIGGER fee_guard_trg BEFORE UPDATE OR DELETE ON fee_payments FOR EACH ROW EXECUTE FUNCTION fee_guard();

    CREATE OR REPLACE FUNCTION audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Audit log is read-only'; END $$;
    DROP TRIGGER IF EXISTS audit_guard_trg ON audit_log;
    CREATE TRIGGER audit_guard_trg BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_guard();
    `);

    // Lock out Supabase's public REST API (anon/authenticated keys).
    // Only this backend (connecting as the postgres owner) can read/write.
    const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map((r) => r.tablename);
    const hasRole = async (r) => (await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [r])).rowCount > 0;
    const supaRoles = [];
    for (const r of ['anon', 'authenticated']) if (await hasRole(r)) supaRoles.push(r);
    for (const t of tables) {
      await c.query(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      if (supaRoles.length) await c.query(`REVOKE ALL ON TABLE "${t}" FROM ${supaRoles.join(', ')}`);
    }

    for (const r of ROLES) for (const m of MODULES) {
      await c.query('INSERT INTO role_perms(role, module, level) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [r.key, m.key, DEFAULT_PERMS[r.key][m.key] || 'none']);
    }

    const now = new Date();
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const defaults = {
      school_name: 'My School', school_address: '', school_phone: '', school_email: '',
      affiliation_no: '', udise_code: '', principal_name: '',
      academic_year: `${y}-${String((y + 1) % 100).padStart(2, '0')}`,
      session_start_month: '4', receipt_prefix: 'RCPT', next_receipt: '1',
    };
    for (const [k, v] of Object.entries(defaults)) {
      await c.query('INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT DO NOTHING', [k, v]);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function getSettings() {
  return Object.fromEntries((await all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
}

async function audit(req, action, entity, entityId, details, client) {
  const runner = client || pool;
  await runner.query('INSERT INTO audit_log(user_id, username, action, entity, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req?.user?.id ?? null, req?.user?.username ?? null, action, entity ?? null, entityId ?? null,
      details ? JSON.stringify(details) : null, req?.ip ?? null]);
}

module.exports = { pool, q, one, all, tx, migrate, getSettings, audit };
