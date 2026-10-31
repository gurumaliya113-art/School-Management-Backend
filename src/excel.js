'use strict';
const ExcelJS = require('exceljs');

// Prevent spreadsheet formula injection when values are opened in Excel.
const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'School Management System';
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width || Math.max(12, c.header.length + 4) }));
    for (const r of s.rows) {
      const row = {};
      for (const c of s.columns) {
        let v = r[c.key];
        if (v && typeof v === 'object' && !(v instanceof Date)) v = JSON.stringify(v);
        row[c.key] = safe(v);
      }
      ws.addRow(row);
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb;
}

async function sendXlsx(res, filename, sheets) {
  const wb = await buildWorkbook(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]/g, '_')}"`);
  await wb.xlsx.write(res);
  res.end();
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = {};
  wb.eachSheet((ws) => {
    const headers = [];
    const rows = [];
    ws.eachRow((row, i) => {
      const vals = row.values.slice(1).map((v) => (v && typeof v === 'object' && 'text' in v ? v.text : v && typeof v === 'object' && 'result' in v ? v.result : v));
      if (i === 1) vals.forEach((h, j) => { headers[j] = String(h ?? '').trim(); });
      else rows.push(Object.fromEntries(headers.map((h, j) => [h, vals[j] ?? null])));
    });
    out[ws.name] = rows;
  });
  return out;
}

module.exports = { sendXlsx, readXlsx, buildWorkbook };
