'use strict';
// Single source of truth for modules, roles and generic entities.
// The client receives this via /api/meta so forms/tables are generated from it.

const MODULES = [
  { key: 'dashboard', label: 'Dashboard', group: 'Main' },
  { key: 'students', label: 'Students', group: 'Academics' },
  { key: 'teachers', label: 'Teachers', group: 'Academics' },
  { key: 'staff', label: 'Staff', group: 'Academics' },
  { key: 'classes', label: 'Classes', group: 'Academics' },
  { key: 'subjects', label: 'Subjects', group: 'Academics' },
  { key: 'timetable', label: 'Timetable', group: 'Academics' },
  { key: 'enquiry', label: 'Admission Enquiry', group: 'Academics' },
  { key: 'attendance', label: 'Attendance', group: 'Administration' },
  { key: 'diary', label: 'Daily Diary', group: 'Administration' },
  { key: 'leave', label: 'Leave Management', group: 'Administration' },
  { key: 'fees', label: 'Fees & Finance', group: 'Administration' },
  { key: 'expenses', label: 'Expenses', group: 'Administration' },
  { key: 'exams', label: 'Examinations & Results', group: 'Administration' },
  { key: 'notices', label: 'Notice Board', group: 'Communication' },
  { key: 'library', label: 'Library', group: 'Library & Assets' },
  { key: 'transport', label: 'Transport', group: 'Library & Assets' },
  { key: 'hostel', label: 'Hostel', group: 'Library & Assets' },
  { key: 'visitors', label: 'Gate / Visitors', group: 'Library & Assets' },
  { key: 'reports', label: 'Reports', group: 'System' },
  { key: 'users', label: 'Users & Access', group: 'System' },
  { key: 'settings', label: 'Settings', group: 'System' },
  { key: 'backup', label: 'Backup & Restore', group: 'System' },
  { key: 'audit', label: 'Audit Log', group: 'System' },
];

// Access levels: 'none' | 'view' | 'edit'
const ROLES = [
  { key: 'admin', label: 'Super Administrator' },
  { key: 'principal', label: 'Principal' },
  { key: 'accountant', label: 'Accountant' },
  { key: 'teacher', label: 'Teacher' },
  { key: 'librarian', label: 'Librarian' },
  { key: 'receptionist', label: 'Receptionist' },
  { key: 'driver', label: 'Transport / Driver' },
  { key: 'warden', label: 'Hostel Warden' },
  { key: 'watchman', label: 'Watchman / Gatekeeper' },
];

const all = (lvl) => Object.fromEntries(MODULES.map((m) => [m.key, lvl]));
const only = (map) => ({ ...all('none'), dashboard: 'view', notices: 'view', leave: 'view', ...map });

const DEFAULT_PERMS = {
  admin: all('edit'),
  principal: { ...all('edit'), backup: 'view', audit: 'view' },
  accountant: only({ students: 'view', classes: 'view', fees: 'edit', expenses: 'edit', reports: 'view', transport: 'view', hostel: 'view', backup: 'view' }),
  teacher: only({ students: 'view', classes: 'view', subjects: 'view', timetable: 'view', attendance: 'edit', diary: 'edit', exams: 'edit', library: 'view' }),
  librarian: only({ students: 'view', library: 'edit' }),
  receptionist: only({ enquiry: 'edit', visitors: 'edit', students: 'view', classes: 'view' }),
  driver: only({ transport: 'view' }),
  warden: only({ hostel: 'edit', students: 'view' }),
  watchman: only({ visitors: 'edit' }),
};

const sel = (...o) => ({ type: 'select', options: o });
const STATUS = sel('Active', 'Inactive');
const GENDER = sel('Male', 'Female', 'Other');

// type: text | textarea | number | date | time | select | ref | phone
const ENTITIES = {
  classes: {
    module: 'classes', label: 'Class', plural: 'Classes',
    display: "t.name || ' - ' || COALESCE(t.section,'')",
    fields: [
      { k: 'name', label: 'Class Name', type: 'text', req: true },
      { k: 'section', label: 'Section', type: 'text' },
      { k: 'class_teacher', label: 'Class Teacher', type: 'ref', ref: 'teachers' },
      { k: 'room', label: 'Room', type: 'text' },
      { k: 'capacity', label: 'Capacity', type: 'number' },
    ],
    computed: [{ k: 'strength', label: 'Students', sql: "(SELECT count(*) FROM students s WHERE s.class_id=m.id AND s.status='Active')" }],
  },
  subjects: {
    module: 'subjects', label: 'Subject', plural: 'Subjects', display: 't.name',
    fields: [
      { k: 'code', label: 'Code', type: 'text', req: true, unique: true },
      { k: 'name', label: 'Subject', type: 'text', req: true },
      { k: 'type', label: 'Type', ...sel('Theory', 'Practical', 'Theory + Practical') },
      { k: 'department', label: 'Department', type: 'text' },
      { k: 'status', label: 'Status', ...STATUS },
    ],
  },
  class_subjects: {
    module: 'classes', label: 'Subject Allocation', plural: 'Subject Allocation (Class ↔ Subject ↔ Teacher)',
    display: "t.id",
    fields: [
      { k: 'class_id', label: 'Class', type: 'ref', ref: 'classes', req: true, filter: true },
      { k: 'subject_id', label: 'Subject', type: 'ref', ref: 'subjects', req: true },
      { k: 'teacher_id', label: 'Teacher', type: 'ref', ref: 'teachers' },
    ],
  },
  students: {
    module: 'students', label: 'Student', plural: 'Students',
    display: "t.name || ' (' || t.admission_no || ')'",
    fields: [
      { k: 'admission_no', label: 'Admission No', type: 'text', req: true, unique: true },
      { k: 'name', label: 'Student Name', type: 'text', req: true },
      { k: 'gender', label: 'Gender', ...GENDER, filter: true },
      { k: 'dob', label: 'Date of Birth', type: 'date', hide: true },
      { k: 'class_id', label: 'Class', type: 'ref', ref: 'classes', req: true, filter: true },
      { k: 'roll_no', label: 'Roll No', type: 'text' },
      { k: 'father_name', label: 'Father Name', type: 'text' },
      { k: 'mother_name', label: 'Mother Name', type: 'text', hide: true },
      { k: 'phone', label: 'Parent Phone', type: 'phone' },
      { k: 'address', label: 'Address', type: 'textarea', hide: true },
      { k: 'admission_date', label: 'Admission Date', type: 'date', hide: true },
      { k: 'route_id', label: 'Transport Route', type: 'ref', ref: 'routes', hide: true },
      { k: 'room_id', label: 'Hostel Room', type: 'ref', ref: 'rooms', hide: true },
      { k: 'concession_pct', label: 'Fee Concession %', type: 'number', hide: true },
      { k: 'status', label: 'Status', ...sel('Active', 'Left', 'Passed Out'), filter: true },
    ],
  },
  teachers: {
    module: 'teachers', label: 'Teacher', plural: 'Teachers', display: 't.name',
    fields: [
      { k: 'emp_id', label: 'Employee ID', type: 'text', req: true, unique: true },
      { k: 'name', label: 'Name', type: 'text', req: true },
      { k: 'gender', label: 'Gender', ...GENDER },
      { k: 'department', label: 'Department', type: 'text', filter: true },
      { k: 'subjects', label: 'Subjects', type: 'text' },
      { k: 'qualification', label: 'Qualification', type: 'text' },
      { k: 'experience', label: 'Experience (yrs)', type: 'number', hide: true },
      { k: 'phone', label: 'Phone', type: 'phone' },
      { k: 'email', label: 'Email', type: 'text', hide: true },
      { k: 'joining_date', label: 'Joining Date', type: 'date', hide: true },
      { k: 'salary', label: 'Salary (₹)', type: 'number', sensitive: 'expenses' },
      { k: 'status', label: 'Status', ...STATUS, filter: true },
    ],
  },
  staff: {
    module: 'staff', label: 'Staff Member', plural: 'Non-Teaching Staff', display: 't.name',
    fields: [
      { k: 'emp_id', label: 'Employee ID', type: 'text', req: true, unique: true },
      { k: 'name', label: 'Name', type: 'text', req: true },
      { k: 'gender', label: 'Gender', ...GENDER },
      { k: 'role', label: 'Role', ...sel('Accountant', 'Driver', 'Conductor', 'Watchman', 'Warden', 'Librarian', 'Receptionist', 'Peon', 'Cleaner', 'Other'), filter: true },
      { k: 'department', label: 'Department', type: 'text' },
      { k: 'phone', label: 'Phone', type: 'phone' },
      { k: 'joining_date', label: 'Joining Date', type: 'date' },
      { k: 'salary', label: 'Salary (₹)', type: 'number', sensitive: 'expenses' },
      { k: 'status', label: 'Status', ...STATUS, filter: true },
    ],
  },
  timetable: {
    module: 'timetable', label: 'Period', plural: 'Timetable', display: 't.id',
    order: "m.class_id, array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']::text[], m.day), m.period",
    fields: [
      { k: 'class_id', label: 'Class', type: 'ref', ref: 'classes', req: true, filter: true },
      { k: 'day', label: 'Day', ...sel('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'), req: true, filter: true },
      { k: 'period', label: 'Period No', type: 'number', req: true },
      { k: 'start_time', label: 'Start', type: 'time' },
      { k: 'end_time', label: 'End', type: 'time' },
      { k: 'subject_id', label: 'Subject', type: 'ref', ref: 'subjects' },
      { k: 'teacher_id', label: 'Teacher', type: 'ref', ref: 'teachers', filter: true },
    ],
  },
  enquiries: {
    module: 'enquiry', label: 'Enquiry', plural: 'Admission Enquiries', display: 't.student_name',
    fields: [
      { k: 'student_name', label: 'Student Name', type: 'text', req: true },
      { k: 'class_sought', label: 'Class Sought', type: 'ref', ref: 'classes', filter: true },
      { k: 'parent_name', label: 'Parent', type: 'text' },
      { k: 'phone', label: 'Mobile', type: 'phone', req: true },
      { k: 'source', label: 'Source', ...sel('Walk-in', 'Phone', 'Website', 'Reference', 'Other') },
      { k: 'next_followup', label: 'Next Follow-up', type: 'date' },
      { k: 'status', label: 'Status', ...sel('New', 'In Progress', 'Converted', 'Closed'), filter: true },
      { k: 'notes', label: 'Notes', type: 'textarea', hide: true },
    ],
  },
  diary: {
    module: 'diary', label: 'Diary Entry', plural: 'Daily Diary', display: 't.id',
    fields: [
      { k: 'date', label: 'Date', type: 'date', req: true, def: 'today', filter: true },
      { k: 'class_id', label: 'Class', type: 'ref', ref: 'classes', req: true, filter: true },
      { k: 'subject_id', label: 'Subject', type: 'ref', ref: 'subjects' },
      { k: 'classwork', label: 'Covered in Class', type: 'textarea' },
      { k: 'homework', label: 'Homework', type: 'textarea' },
      { k: 'note', label: 'Note for Parents', type: 'textarea', hide: true },
    ],
  },
  leaves: {
    module: 'leave', label: 'Leave Request', plural: 'Leave Requests', display: 't.id',
    selfService: true, // anyone with view can apply & see own; edit sees all & approves
    fields: [
      { k: 'person_name', label: 'Applicant', type: 'text', auto: true },
      { k: 'leave_type', label: 'Leave Type', ...sel('Casual', 'Sick', 'Earned', 'Other'), req: true, filter: true },
      { k: 'from_date', label: 'From', type: 'date', req: true },
      { k: 'to_date', label: 'To', type: 'date', req: true },
      { k: 'reason', label: 'Reason', type: 'textarea' },
      { k: 'status', label: 'Status', ...sel('Pending', 'Approved', 'Rejected'), approverOnly: true, def: 'Pending', filter: true },
    ],
  },
  fee_structure: {
    module: 'fees', label: 'Fee Head', plural: 'Fee Structure', display: 't.fee_type',
    fields: [
      { k: 'class_id', label: 'Class', type: 'ref', ref: 'classes', req: true, filter: true },
      { k: 'fee_type', label: 'Fee Type', type: 'text', req: true },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true },
      { k: 'frequency', label: 'Frequency', ...sel('One-Time', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'), req: true },
    ],
  },
  expenses: {
    module: 'expenses', label: 'Expense', plural: 'Expenses', display: 't.description',
    fields: [
      { k: 'date', label: 'Date', type: 'date', req: true, def: 'today' },
      { k: 'category', label: 'Category', ...sel('Transport', 'Staff Salary', 'Electricity', 'Maintenance', 'Stationery', 'Hostel & Mess', 'Events', 'Other'), req: true, filter: true },
      { k: 'description', label: 'Description', type: 'text', req: true },
      { k: 'amount', label: 'Amount (₹)', type: 'number', req: true },
      { k: 'paid_to', label: 'Paid To', type: 'text' },
      { k: 'mode', label: 'Mode', ...sel('Cash', 'UPI', 'Bank Transfer', 'Cheque') },
      { k: 'ref_no', label: 'Bill / Ref No', type: 'text', hide: true },
      { k: 'status', label: 'Status', ...sel('Paid', 'Pending', 'Cancelled'), filter: true },
    ],
  },
  exams: {
    module: 'exams', label: 'Exam', plural: 'Exams', display: 't.name',
    fields: [
      { k: 'name', label: 'Exam Name', type: 'text', req: true },
      { k: 'class_id', label: 'Class', type: 'ref', ref: 'classes', req: true, filter: true },
      { k: 'start_date', label: 'Start Date', type: 'date' },
      { k: 'end_date', label: 'End Date', type: 'date' },
      { k: 'max_marks', label: 'Max Marks / Subject', type: 'number', req: true, def: 100 },
      { k: 'pass_marks', label: 'Pass Marks / Subject', type: 'number', req: true, def: 33 },
    ],
  },
  notices: {
    module: 'notices', label: 'Notice', plural: 'Notice Board', display: 't.title',
    fields: [
      { k: 'date', label: 'Date', type: 'date', req: true, def: 'today' },
      { k: 'title', label: 'Title', type: 'text', req: true },
      { k: 'category', label: 'Category', ...sel('General', 'Exam', 'Fee', 'Event', 'Holiday', 'Urgent'), filter: true },
      { k: 'audience', label: 'Audience', ...sel('All', 'Staff', 'Parents', 'Students') },
      { k: 'body', label: 'Notice Text', type: 'textarea', req: true },
    ],
  },
  books: {
    module: 'library', label: 'Book', plural: 'Library Catalog', display: 't.title',
    fields: [
      { k: 'title', label: 'Title', type: 'text', req: true },
      { k: 'isbn', label: 'ISBN', type: 'text' },
      { k: 'author', label: 'Author', type: 'text' },
      { k: 'category', label: 'Category', ...sel('Textbook', 'Reference', 'Fiction', 'Non-Fiction', 'Magazine', 'Other'), filter: true },
      { k: 'rack', label: 'Rack', type: 'text' },
      { k: 'total', label: 'Total Copies', type: 'number', req: true, def: 1 },
    ],
    computed: [{ k: 'available', label: 'Available', sql: "(m.total - (SELECT count(*) FROM book_issues bi WHERE bi.book_id=m.id AND bi.status='Issued'))" }],
  },
  book_issues: {
    module: 'library', label: 'Book Issue', plural: 'Issued Books', display: 't.id',
    fields: [
      { k: 'book_id', label: 'Book', type: 'ref', ref: 'books', req: true },
      { k: 'student_id', label: 'Student', type: 'ref', ref: 'students', req: true },
      { k: 'issue_date', label: 'Issue Date', type: 'date', req: true, def: 'today' },
      { k: 'due_date', label: 'Due Date', type: 'date', req: true },
      { k: 'return_date', label: 'Returned On', type: 'date' },
      { k: 'fine', label: 'Fine (₹)', type: 'number' },
      { k: 'status', label: 'Status', ...sel('Issued', 'Returned', 'Lost'), def: 'Issued', filter: true },
    ],
    computed: [{ k: 'overdue_days', label: 'Overdue Days', sql: "(CASE WHEN m.status='Issued' AND m.due_date < CURRENT_DATE THEN CURRENT_DATE - m.due_date ELSE 0 END)" }],
  },
  vehicles: {
    module: 'transport', label: 'Vehicle', plural: 'Vehicles', display: 't.number',
    fields: [
      { k: 'number', label: 'Vehicle No', type: 'text', req: true, unique: true },
      { k: 'type', label: 'Type', ...sel('Bus', 'Van', 'Auto', 'Other') },
      { k: 'capacity', label: 'Capacity', type: 'number' },
      { k: 'driver_name', label: 'Driver', type: 'text' },
      { k: 'driver_phone', label: 'Driver Phone', type: 'phone' },
      { k: 'fuel', label: 'Fuel', ...sel('Diesel', 'Petrol', 'CNG', 'Electric') },
      { k: 'insurance_expiry', label: 'Insurance Expiry', type: 'date' },
      { k: 'fitness_expiry', label: 'Fitness Expiry', type: 'date', hide: true },
      { k: 'status', label: 'Status', ...STATUS },
    ],
  },
  routes: {
    module: 'transport', label: 'Route', plural: 'Routes', display: 't.name',
    fields: [
      { k: 'name', label: 'Route Name', type: 'text', req: true },
      { k: 'vehicle_id', label: 'Vehicle', type: 'ref', ref: 'vehicles' },
      { k: 'stops', label: 'Stops (in order)', type: 'textarea' },
      { k: 'pickup_time', label: 'Pickup Time', type: 'time' },
      { k: 'drop_time', label: 'Drop Time', type: 'time' },
      { k: 'monthly_fee', label: 'Monthly Fee (₹)', type: 'number' },
    ],
    computed: [{ k: 'students', label: 'Students', sql: "(SELECT count(*) FROM students s WHERE s.route_id=m.id AND s.status='Active')" }],
  },
  hostels: {
    module: 'hostel', label: 'Hostel', plural: 'Hostels', display: 't.name',
    fields: [
      { k: 'name', label: 'Hostel Name', type: 'text', req: true },
      { k: 'type', label: 'Type', ...sel('Boys', 'Girls', 'Mixed') },
      { k: 'warden', label: 'Warden', type: 'text' },
      { k: 'phone', label: 'Phone', type: 'phone' },
      { k: 'monthly_fee', label: 'Monthly Fee (₹)', type: 'number' },
    ],
  },
  rooms: {
    module: 'hostel', label: 'Room', plural: 'Rooms', display: "t.room_no",
    fields: [
      { k: 'hostel_id', label: 'Hostel', type: 'ref', ref: 'hostels', req: true, filter: true },
      { k: 'room_no', label: 'Room No', type: 'text', req: true },
      { k: 'floor', label: 'Floor', type: 'text' },
      { k: 'beds', label: 'Beds', type: 'number', req: true },
      { k: 'status', label: 'Status', ...STATUS },
    ],
    computed: [{ k: 'occupied', label: 'Occupied', sql: "(SELECT count(*) FROM students s WHERE s.room_id=m.id AND s.status='Active')" }],
  },
  visitors: {
    module: 'visitors', label: 'Visitor Entry', plural: 'Gate Register', display: 't.name',
    fields: [
      { k: 'date', label: 'Date', type: 'date', req: true, def: 'today', filter: true },
      { k: 'time_in', label: 'Time In', type: 'time', def: 'now' },
      { k: 'time_out', label: 'Time Out', type: 'time' },
      { k: 'name', label: 'Visitor Name', type: 'text', req: true },
      { k: 'phone', label: 'Phone', type: 'phone' },
      { k: 'purpose', label: 'Purpose', ...sel('Parent Meeting', 'Student Pickup', 'Delivery', 'Vendor', 'Interview', 'Official', 'Other') },
      { k: 'whom_to_meet', label: 'Whom to Meet', type: 'text' },
      { k: 'vehicle_no', label: 'Vehicle No', type: 'text' },
      { k: 'id_proof', label: 'ID Proof', type: 'text', hide: true },
    ],
  },
};

module.exports = { MODULES, ROLES, DEFAULT_PERMS, ENTITIES };
