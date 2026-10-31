'use strict';
const express = require('express');
const { one, all, tx, getSettings, audit } = require('./db');
const { need, can } = require('./auth');
const { HttpError, today, wrap } = require('./crud');
const { sendXlsx } = require('./excel');

const router = express.Router();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const isMonth = (s) => /^\d{4}-\d{2}$/.test(String(s));

function grade(pct) {
  if (pct >= 91) return 'A1'; if (pct >= 81) return 'A2'; if (pct >= 71) return 'B1'; if (pct >= 61) return 'B2';
  if (pct >= 51) return 'C1'; if (pct >= 41) return 'C2'; if (pct >= 33) return 'D'; return 'E';
}

// ---------- Dashboard: each card only appears if the user can see that module ----------
router.get('/dashboard', wrap(async (req, res) => {
  const d = today();
  const out = { date: d, school: (await getSettings()).school_name };
  if (can(req, 'students')) {
    out.students = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE gender='Male')::int AS boys,
      count(*) FILTER (WHERE gender='Female')::int AS girls FROM students WHERE status='Active'`);
    out.birthdays = await all(`SELECT name FROM students WHERE status='Active' AND to_char(dob,'MM-DD') = to_char($1::date,'MM-DD')`, [d]);
  }
  if (can(req, 'teachers')) out.teachers = (await one(`SELECT count(*)::int AS n FROM teachers WHERE status='Active'`)).n;
  if (can(req, 'staff')) out.staff = (await one(`SELECT count(*)::int AS n FROM staff WHERE status='Active'`)).n;
  if (can(req, 'attendance')) {
    out.attendance = await one(`SELECT count(*)::int AS marked, count(*) FILTER (WHERE status IN ('Present','Late'))::int AS present,
      count(*) FILTER (WHERE status='Absent')::int AS absent FROM attendance WHERE date=$1`, [d]);
    out.classes_not_marked = (await one(`SELECT count(*)::int AS n FROM classes c WHERE NOT EXISTS
      (SELECT 1 FROM attendance a WHERE a.class_id=c.id AND a.date=$1)`, [d])).n;
  }
  if (can(req, 'fees')) {
    out.fees = await one(`SELECT COALESCE(sum(total) FILTER (WHERE date=$1),0) AS today,
      COALESCE(sum(total) FILTER (WHERE to_char(date,'YYYY-MM')=to_char($1::date,'YYYY-MM')),0) AS month
      FROM fee_payments WHERE status='Paid'`, [d]);
    out.fee_months = await all(`SELECT to_char(date,'YYYY-MM') AS m, sum(total) AS total FROM fee_payments
      WHERE status='Paid' AND date > ($1::date - interval '12 months') GROUP BY 1 ORDER BY 1`, [d]);
  }
  if (can(req, 'expenses')) {
    out.expenses_month = (await one(`SELECT COALESCE(sum(amount),0) AS n FROM expenses WHERE status<>'Cancelled'
      AND to_char(date,'YYYY-MM')=to_char($1::date,'YYYY-MM')`, [d])).n;
  }
  if (can(req, 'leave')) out.on_leave = await all(`SELECT person_name, leave_type FROM leaves WHERE status='Approved' AND $1::date BETWEEN from_date AND to_date`, [d]);
  if (can(req, 'enquiry')) out.followups = (await one(`SELECT count(*)::int AS n FROM enquiries WHERE status IN ('New','In Progress') AND next_followup <= $1`, [d])).n;
  if (can(req, 'library')) out.overdue_books = (await one(`SELECT count(*)::int AS n FROM book_issues WHERE status='Issued' AND due_date < $1`, [d])).n;
  if (can(req, 'visitors')) out.visitors_today = (await one(`SELECT count(*)::int AS n FROM visitors WHERE date=$1`, [d])).n;
  if (can(req, 'transport')) {
    out.expiring_docs = await all(`SELECT number, insurance_expiry, fitness_expiry FROM vehicles
      WHERE insurance_expiry <= $1::date + 30 OR fitness_expiry <= $1::date + 30`, [d]);
  }
  if (can(req, 'notices')) out.notices = await all('SELECT id, date, title, category FROM notices ORDER BY date DESC, id DESC LIMIT 5');
  res.json(out);
}));

// ---------- Attendance ----------
router.get('/attendance', need('attendance', 'view'), wrap(async (req, res) => {
  const classId = Number(req.query.class_id); const date = String(req.query.date || today());
  if (!classId || !isDate(date)) throw new HttpError(400, 'Choose class and date');
  const rows = await all(`SELECT s.id, s.name, s.roll_no, s.phone, s.father_name, a.status, a.remark FROM students s
    LEFT JOIN attendance a ON a.student_id=s.id AND a.date=$2
    WHERE s.class_id=$1 AND s.status='Active' ORDER BY NULLIF(regexp_replace(s.roll_no,'\\D','','g'),'')::int NULLS LAST, s.name`, [classId, date]);
  res.json({ rows, marked: rows.some((r) => r.status) });
}));

router.post('/attendance', need('attendance', 'edit'), wrap(async (req, res) => {
  const { class_id, date, entries } = req.body || {};
  if (!Number(class_id) || !isDate(date)) throw new HttpError(400, 'Choose class and date');
  if (date > today()) throw new HttpError(400, 'Cannot mark attendance for a future date');
  if (!Array.isArray(entries) || entries.length > 500) throw new HttpError(400, 'Invalid attendance list');
  const ok = ['Present', 'Absent', 'Late', 'Leave'];
  await tx(async (c) => {
    const valid = new Set((await c.query(`SELECT id FROM students WHERE class_id=$1`, [Number(class_id)])).rows.map((r) => r.id));
    for (const e of entries) {
      if (!valid.has(Number(e.student_id)) || !ok.includes(e.status)) continue;
      await c.query(`INSERT INTO attendance(date, student_id, class_id, status, remark, marked_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (date, student_id) DO UPDATE SET status=EXCLUDED.status, remark=EXCLUDED.remark, marked_by=EXCLUDED.marked_by`,
      [date, Number(e.student_id), Number(class_id), e.status, String(e.remark || '').slice(0, 200) || null, req.user.id]);
    }
    await audit(req, 'attendance_marked', 'attendance', Number(class_id), { date, count: entries.length }, c);
  });
  res.json({ ok: true });
}));

async function monthlyAttendance(classId, month) {
  const students = await all(`SELECT id, name, roll_no FROM students WHERE class_id=$1 AND status='Active' ORDER BY roll_no, name`, [classId]);
  const recs = await all(`SELECT student_id, to_char(date,'DD') AS d, status FROM attendance WHERE class_id=$1 AND to_char(date,'YYYY-MM')=$2`, [classId, month]);
  const map = {};
  for (const r of recs) (map[r.student_id] ||= {})[r.d] = r.status;
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  return {
    days,
    rows: students.map((s) => {
      const st = map[s.id] || {};
      const vals = Object.values(st);
      const present = vals.filter((v) => v === 'Present' || v === 'Late').length;
      return { ...s, days: st, present, absent: vals.filter((v) => v === 'Absent').length, leave: vals.filter((v) => v === 'Leave').length,
        working: vals.length, pct: vals.length ? Math.round((present / vals.length) * 100) : null };
    }),
  };
}

router.get('/attendance/monthly', need('attendance', 'view'), wrap(async (req, res) => {
  const classId = Number(req.query.class_id); const month = String(req.query.month || today().slice(0, 7));
  if (!classId || !isMonth(month)) throw new HttpError(400, 'Choose class and month');
  res.json(await monthlyAttendance(classId, month));
}));

router.get('/attendance/monthly.xlsx', need('attendance', 'view'), wrap(async (req, res) => {
  const classId = Number(req.query.class_id); const month = String(req.query.month || today().slice(0, 7));
  if (!classId || !isMonth(month)) throw new HttpError(400, 'Choose class and month');
  const { days, rows } = await monthlyAttendance(classId, month);
  const short = { Present: 'P', Absent: 'A', Late: 'L', Leave: 'LV' };
  const dayCols = Array.from({ length: days }, (_, i) => String(i + 1).padStart(2, '0'));
  const flat = rows.map((r) => ({ ...r, ...Object.fromEntries(dayCols.map((d) => [`d${d}`, short[r.days[d]] || ''])) }));
  await sendXlsx(res, `attendance-${month}.xlsx`, [{
    name: `Attendance ${month}`,
    columns: [{ header: 'Roll', key: 'roll_no', width: 6 }, { header: 'Student', key: 'name', width: 22 },
      ...dayCols.map((d) => ({ header: d, key: `d${d}`, width: 4 })),
      { header: 'Present', key: 'present' }, { header: 'Absent', key: 'absent' }, { header: 'Leave', key: 'leave' }, { header: '%', key: 'pct', width: 6 }],
    rows: flat,
  }]);
}));

// ---------- Exams: marks entry + results ----------
async function examSheet(examId) {
  const exam = await one(`SELECT e.*, c.name || ' - ' || COALESCE(c.section,'') AS class_name FROM exams e JOIN classes c ON c.id=e.class_id WHERE e.id=$1`, [examId]);
  if (!exam) throw new HttpError(404, 'Exam not found');
  const subjects = await all(`SELECT DISTINCT s.id, s.name, s.code FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.class_id=$1 ORDER BY s.name`, [exam.class_id]);
  const students = await all(`SELECT id, name, roll_no, father_name, mother_name, admission_no FROM students WHERE class_id=$1 AND status='Active' ORDER BY roll_no, name`, [exam.class_id]);
  const marks = await all('SELECT student_id, subject_id, marks FROM marks WHERE exam_id=$1', [examId]);
  const mm = {};
  for (const m of marks) (mm[m.student_id] ||= {})[m.subject_id] = m.marks;
  const max = Number(exam.max_marks); const pass = Number(exam.pass_marks);
  const rows = students.map((s) => {
    const sm = mm[s.id] || {};
    const total = subjects.reduce((a, sub) => a + (Number(sm[sub.id]) || 0), 0);
    const outOf = subjects.length * max;
    const pct = outOf ? Math.round((total / outOf) * 1000) / 10 : 0;
    const failed = subjects.some((sub) => sm[sub.id] != null && Number(sm[sub.id]) < pass);
    const complete = subjects.every((sub) => sm[sub.id] != null);
    return { ...s, marks: sm, total, out_of: outOf, pct, grade: grade(pct), result: !complete ? 'Incomplete' : failed ? 'Fail' : 'Pass' };
  });
  [...rows].sort((a, b) => b.total - a.total).forEach((r, i, arr) => { r.rank = i > 0 && arr[i - 1].total === r.total ? arr[i - 1].rank : i + 1; });
  const done = rows.filter((r) => r.result !== 'Incomplete');
  const summary = {
    average: rows.length ? Math.round(rows.reduce((a, r) => a + r.pct, 0) / rows.length) : 0,
    pass_pct: done.length ? Math.round((done.filter((r) => r.result === 'Pass').length / done.length) * 100) : 0,
    distinctions: rows.filter((r) => r.pct >= 75).length, failed: rows.filter((r) => r.result === 'Fail').length,
  };
  return { exam, subjects, rows, summary };
}

router.get('/exams/:id/sheet', need('exams', 'view'), wrap(async (req, res) => res.json(await examSheet(Number(req.params.id)))));

router.post('/exams/:id/marks', need('exams', 'edit'), wrap(async (req, res) => {
  const examId = Number(req.params.id);
  const { exam, subjects, rows } = await examSheet(examId);
  const subIds = new Set(subjects.map((s) => s.id)); const stuIds = new Set(rows.map((r) => r.id));
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  await tx(async (c) => {
    for (const e of entries) {
      if (!stuIds.has(Number(e.student_id)) || !subIds.has(Number(e.subject_id))) continue;
      let v = e.marks === '' || e.marks == null ? null : Number(e.marks);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > Number(exam.max_marks))) throw new HttpError(400, `Marks must be between 0 and ${exam.max_marks}`);
      await c.query(`INSERT INTO marks(exam_id, student_id, subject_id, marks) VALUES ($1,$2,$3,$4)
        ON CONFLICT (exam_id, student_id, subject_id) DO UPDATE SET marks=EXCLUDED.marks`, [examId, Number(e.student_id), Number(e.subject_id), v]);
    }
    await audit(req, 'marks_saved', 'exams', examId, { count: entries.length }, c);
  });
  res.json({ ok: true });
}));

router.get('/exams/:id/results.xlsx', need('exams', 'view'), wrap(async (req, res) => {
  const { exam, subjects, rows } = await examSheet(Number(req.params.id));
  const flat = rows.map((r) => ({ ...r, ...Object.fromEntries(subjects.map((s) => [`s${s.id}`, r.marks[s.id] ?? ''])) }));
  await sendXlsx(res, `results-${exam.name}-${exam.class_name}.xlsx`, [{
    name: 'Results',
    columns: [{ header: 'Rank', key: 'rank', width: 6 }, { header: 'Roll', key: 'roll_no', width: 6 }, { header: 'Student', key: 'name', width: 22 },
      ...subjects.map((s) => ({ header: s.name, key: `s${s.id}` })),
      { header: 'Total', key: 'total' }, { header: '%', key: 'pct' }, { header: 'Grade', key: 'grade' }, { header: 'Result', key: 'result' }],
    rows: flat,
  }]);
}));

// ---------- Transport: students on a route (drivers see only names, class, stop, parent phone) ----------
router.get('/transport/routes/:id/students', need('transport', 'view'), wrap(async (req, res) => {
  res.json(await all(`SELECT s.name, s.roll_no, c.name || ' - ' || COALESCE(c.section,'') AS class_name, s.father_name, s.phone
    FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.route_id=$1 AND s.status='Active' ORDER BY c.name, s.name`, [Number(req.params.id)]));
}));

// ---------- Hostel: boarders of a room ----------
router.get('/hostel/rooms/:id/students', need('hostel', 'view'), wrap(async (req, res) => {
  res.json(await all(`SELECT s.name, s.admission_no, c.name || ' - ' || COALESCE(c.section,'') AS class_name, s.father_name, s.phone
    FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.room_id=$1 AND s.status='Active' ORDER BY s.name`, [Number(req.params.id)]));
}));

module.exports = { router, examSheet };
