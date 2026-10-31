'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { migrate, getSettings, pool } = require('./db');
const auth = require('./auth');
const crud = require('./crud');
const fees = require('./fees');
const academics = require('./academics');
const admin = require('./admin');
const { MODULES, ROLES, ENTITIES } = require('./schema');

const app = express();
app.disable('x-powered-by');
// Requests arrive through Vercel's proxy and then Render/Railway's proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 2));
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(express.json({ limit: '1mb' }));

const api = express.Router();
api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// CSRF protection: browsers cannot send this custom header cross-site without CORS approval (which we never give).
api.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Bad request origin' });
  next();
});
api.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

api.get('/health', async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, message: { error: 'Too many login attempts. Wait 15 minutes.' } });
api.post('/auth/login', loginLimiter, crud.wrap(auth.login));
api.post('/auth/logout', crud.wrap(auth.logout));

api.use(auth.requireAuth);

api.post('/auth/change-password', crud.wrap(auth.changePassword));
api.get('/auth/me', (req, res) => res.json({ user: req.user, perms: req.perms }));

api.get('/meta', crud.wrap(async (req, res) => {
  const s = await getSettings();
  const entities = Object.fromEntries(Object.entries(ENTITIES).map(([k, e]) => [k, {
    module: e.module, label: e.label, plural: e.plural, selfService: !!e.selfService, computed: (e.computed || []).map((c) => ({ k: c.k, label: c.label })),
    fields: e.fields.filter((f) => !f.sensitive || auth.can(req, f.sensitive)).map(({ sensitive, unique, ...f }) => f),
  }]));
  res.json({
    user: req.user, perms: req.perms, modules: MODULES, roles: ROLES, entities,
    school: { name: s.school_name, address: s.school_address, phone: s.school_phone, email: s.school_email,
      affiliation_no: s.affiliation_no, udise_code: s.udise_code, principal_name: s.principal_name, academic_year: s.academic_year },
    fee_modes: fees.MODES,
  });
}));

api.use('/e', crud.router);
api.use('/fees', fees.router);
api.use('/', academics.router);
api.use('/', admin.router);

api.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.code === '23505') return res.status(409).json({ error: 'A record with this value already exists' });
  if (err.code === '23503') return res.status(400).json({ error: 'This record is linked to other records and cannot be removed. Mark it Inactive instead.' });
  if (err.code === 'P0001') return res.status(400).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.use('/api', api);

// For local development, serve the frontend from the same server.
const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
if (process.env.SERVE_FRONTEND !== 'false' && fs.existsSync(FRONTEND)) app.use(express.static(FRONTEND));

const PORT = Number(process.env.PORT || 4000);
(async () => {
  await migrate();
  await auth.ensureAdmin();
  app.listen(PORT, () => console.log(`School Management API running on port ${PORT}`));
})().catch((e) => {
  const m = String(e.message || e);
  let hint = '';
  if (/password authentication failed/i.test(m)) hint = 'Wrong database password in DATABASE_URL. Reset it in Supabase → Project Settings → Database and update DATABASE_URL.';
  else if (/Tenant or user not found/i.test(m)) hint = 'Pooler username must be "postgres.<project-ref>" — copy the full Session pooler string from Supabase → Connect.';
  else if (/ENOTFOUND|EAI_AGAIN/i.test(m)) hint = 'Database host not found. Check DATABASE_URL host spelling.';
  else if (/ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timeout/i.test(m)) hint = 'Cannot reach database. Use the Supabase "Session pooler" string (IPv4), not "Direct connection". Also check the Supabase project is not paused.';
  else if (/certificate/i.test(m)) hint = 'SSL problem. Remove DB_SSL_CA or check it is the correct Supabase CA.';
  console.error('Startup failed:', m);
  if (hint) console.error('FIX:', hint);
  process.exit(1);
});
