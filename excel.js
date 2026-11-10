'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = [
  { header: 'Imię', key: 'firstName', width: 16 },
  { header: 'Nazwisko', key: 'lastName', width: 20 },
  { header: 'Nazwa wyświetlana', key: 'displayName', width: 24 },
  { header: 'E-mail', key: 'email', width: 34 },
  { header: 'Hasło', key: 'password', width: 22, mono: true },
  { header: 'Licencje', key: 'license', width: 44 },
  { header: 'Dział', key: 'department', width: 18 },
  { header: 'Stanowisko', key: 'jobTitle', width: 20 },
  { header: 'Telefon', key: 'phone', width: 16 },
  { header: 'Telefon komórkowy', key: 'mobile', width: 18 },
  { header: 'Biuro', key: 'office', width: 18 }
];
const TAIL = [
  { header: 'Uwagi', key: 'notes', width: 36 },
  { header: 'Utworzono', key: 'created', width: 18, date: true },
  { header: 'Zmieniono', key: 'updated', width: 18, date: true }
];
const ACCENT = 'FF0A64D8';
const NO_LIC = /^(brak( licencji)?|bez licencji|unlicensed)$/i;
const licSplit = s => String(s || '').split(/\s*[;,\n]\s*/).map(x => x.trim()).filter(x => x && !NO_LIC.test(x));

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.height = 22;
  row.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
    c.alignment = { vertical: 'middle' };
  });
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function applyColumnStyles(ws, cols) {
  cols.forEach((c, i) => {
    if (c.mono) ws.getColumn(i + 1).font = { name: 'Consolas' };
    if (c.date) ws.getColumn(i + 1).numFmt = 'yyyy-mm-dd hh:mm';
  });
  styleHeader(ws); // po stylach kolumn, żeby nagłówek miał biały, pogrubiony tekst
}

async function exportWorkbook(rows, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Skarbiec';
  wb.created = new Date();
  const ws = wb.addWorksheet('Konta', { views: [{ state: 'frozen', ySplit: 1 }] });

  // Kolejne hasła: „Hasło 2”, „Opis hasła 2”, …; własne pola: po jednej kolumnie na nazwę pola
  const maxAlt = rows.reduce((m, r) => Math.max(m, r.altPasswords.length), 0);
  const altCols = [];
  for (let i = 0; i < maxAlt; i++) {
    altCols.push({ header: `Hasło ${i + 2}`, key: `alt${i}`, width: 22, mono: true });
    if (rows.some(r => r.altPasswords[i] && r.altPasswords[i].label)) altCols.push({ header: `Opis hasła ${i + 2}`, key: `altl${i}`, width: 20 });
  }
  const reserved = new Set([...BASE, ...TAIL, ...altCols].map(c => c.header.toLowerCase()));
  const extraLabels = [];
  rows.forEach(r => r.extra.forEach(x => { const l = x.label || 'Pole'; if (!extraLabels.some(y => y.toLowerCase() === l.toLowerCase())) extraLabels.push(l); }));
  const extraCols = extraLabels.map((l, i) => ({ header: reserved.has(l.toLowerCase()) ? `${l} (pole)` : l, key: `ex${i}`, width: 20, label: l }));

  const cols = [...BASE.slice(0, 5), ...altCols, ...BASE.slice(5), ...extraCols, ...TAIL];
  ws.columns = cols.map(({ header, key, width }) => ({ header, key, width }));
  rows.forEach(r => {
    const o = { ...r, created: toDate(r.created), updated: toDate(r.updated) };
    r.altPasswords.forEach((a, i) => { o[`alt${i}`] = a.password; o[`altl${i}`] = a.label; });
    extraCols.forEach(c => { const x = r.extra.find(y => (y.label || 'Pole').toLowerCase() === c.label.toLowerCase()); o[c.key] = x ? x.value : ''; });
    delete o.altPasswords; delete o.extra; delete o.apps;
    ws.addRow(o);
  });
  applyColumnStyles(ws, cols);
  ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };

  // Dostępy do innych aplikacji i stron: jeden wiersz na dostęp
  if (rows.some(r => r.apps && r.apps.length)) {
    const ap = wb.addWorksheet('Aplikacje', { views: [{ state: 'frozen', ySplit: 1 }] });
    const acols = [
      { header: 'Imię', key: 'firstName', width: 14 }, { header: 'Nazwisko', key: 'lastName', width: 18 }, { header: 'E-mail', key: 'email', width: 30 },
      { header: 'Aplikacja', key: 'name', width: 20 }, { header: 'Adres strony', key: 'url', width: 30 }, { header: 'Login', key: 'login', width: 28 },
      { header: 'Hasło', key: 'password', width: 22, mono: true }, { header: 'Uwagi', key: 'note', width: 30 }];
    ap.columns = acols.map(({ header, key, width }) => ({ header, key, width }));
    rows.forEach(r => (r.apps || []).forEach(a => ap.addRow({ firstName: r.firstName, lastName: r.lastName, email: r.email, ...a })));
    applyColumnStyles(ap, acols);
    ap.autoFilter = { from: 'A1', to: { row: 1, column: acols.length } };
  }

  // Podsumowanie licencji (konto może mieć kilka licencji)
  const sum = wb.addWorksheet('Licencje');
  sum.columns = [{ header: 'Licencja', key: 'l', width: 44 }, { header: 'Liczba kont', key: 'n', width: 14 }];
  const counts = new Map();
  rows.forEach(r => { const l = licSplit(r.license); (l.length ? l : ['Bez licencji']).forEach(x => counts.set(x, (counts.get(x) || 0) + 1)); });
  [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pl')).forEach(([l, n]) => sum.addRow({ l, n }));
  const total = sum.addRow({ l: 'Kont razem', n: rows.length });
  total.font = { bold: true };
  styleHeader(sum);

  await wb.xlsx.writeFile(filePath);
}

async function exportTemplate(licenses, filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Skarbiec';
  const ws = wb.addWorksheet('Konta', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [...BASE.slice(0, 5), { header: 'Hasło 2', key: 'alt0', width: 22, mono: true }, { header: 'Opis hasła 2', key: 'altl0', width: 20 }, ...BASE.slice(5), TAIL[0]];
  ws.columns = cols.map(({ header, key, width }) => ({ header, key, width }));
  applyColumnStyles(ws, cols);
  const licCol = cols.findIndex(c => c.key === 'license') + 1;
  const list = wb.addWorksheet('Lista licencji');
  licenses.forEach((l, i) => { list.getCell(i + 1, 1).value = l; });
  list.getColumn(1).width = 40;
  for (let r = 2; r <= 1000; r++) {
    ws.getCell(r, licCol).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: false,
      formulae: [`'Lista licencji'!$A$1:$A$${licenses.length}`]
    };
  }
  const info = wb.addWorksheet('Instrukcja');
  info.getColumn(1).width = 100;
  ['Wypełnij arkusz „Konta”. Wymagany jest tylko adres e-mail; hasło jest opcjonalne.',
   'Kilka licencji wpisz w jednej komórce, oddzielając je przecinkami (lista w kolumnie podpowiada najczęstsze).',
   'Kolejne hasła: dodaj kolumny „Hasło 3”, „Opis hasła 3” itd.',
   'Każdą inną kolumnę (np. „Numer karty”) można zaimportować jako dodatkowe pole konta.'
  ].forEach((t, i) => { info.getCell(i + 1, 1).value = t; });
  await wb.xlsx.writeFile(filePath);
}

function parseCSV(text) {
  const first = text.split(/\r?\n/, 1)[0] || '';
  const count = ch => first.split(ch).length - 1;
  const d = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];
  const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  return out.filter(r => r.some(v => String(v).trim() !== ''));
}

function decodeText(buf) {
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\uFFFD')) {
    try { text = new TextDecoder('windows-1250').decode(buf); } catch (_) { /* zostaje UTF-8 */ }
  }
  return text.replace(/^\uFEFF/, '');
}

// Niektóre programy (np. eksporty z .NET/OpenXML SDK) zapisują w relacjach ścieżki bezwzględne
// („/xl/workbook.xml”). Excel je akceptuje, ExcelJS nie — zamieniamy je na względne.
async function normalizeXlsx(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.rels')) continue;
    // _rels/.rels → katalog bazowy ''; xl/_rels/workbook.xml.rels → 'xl/'
    const base = name.replace(/_rels\/[^/]*$/, '');
    let xml = await zip.file(name).async('string');
    const fixed = xml.replace(/^﻿/, '').replace(/Target="\/([^"]*)"/g, (_m, t) => {
      changed = true;
      const from = base.split('/').filter(Boolean), to = t.split('/');
      let i = 0; while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
      return `Target="${[...from.slice(i).map(() => '..'), ...to.slice(i)].join('/')}"`;
    });
    if (fixed !== xml) { changed = true; zip.file(name, fixed); }
  }
  // Prefiks przestrzeni nazw SpreadsheetML (<x:worksheet>) → elementy bez prefiksu (<worksheet>)
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  for (const name of Object.keys(zip.files)) {
    if (!/\.xml$/i.test(name) || zip.files[name].dir) continue;
    const xml = await zip.file(name).async('string');
    const m = xml.match(new RegExp(`xmlns:([A-Za-z_][\\w.-]*)="${MAIN.replace(/[./]/g, '\\$&')}"`));
    if (!m) continue;
    const p = m[1];
    const fixed = xml.replace(/^\uFEFF/, '')
      .replace(new RegExp(`<(/?)${p}:`, 'g'), '<$1')
      .replace(new RegExp(`\\sxmlns:${p}="${MAIN.replace(/[./]/g, '\\$&')}"`, 'g'), ` xmlns="${MAIN}"`);
    zip.file(name, fixed); changed = true;
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer' }) : buf;
}

function sheetRows(ws) {
  const rows = [], nums = [];
  const cols = Math.min(ws.actualColumnCount || ws.columnCount || 0, 200);
  let n = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (n++ > 20000) return;
    const vals = [];
    for (let c = 1; c <= cols; c++) {
      const cell = row.getCell(c);
      let t = cell.text;
      if (t == null || typeof t === 'object') t = cell.value && cell.value.text ? cell.value.text : '';
      vals.push(String(t ?? '').trim());
    }
    if (vals.some(v => v)) { rows.push(vals); nums.push(rowNumber); }
  });
  return { rows, nums };
}

// Zwraca wszystkie arkusze jako tablice wierszy; wybór arkusza i wiersza nagłówka robi aplikacja
async function readTable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.txt') {
    const rows = parseCSV(decodeText(fs.readFileSync(filePath))).slice(0, 20001);
    return { sheets: [{ name: path.basename(filePath), rows, nums: rows.map((_r, i) => i + 1) }] };
  }
  const buf = fs.readFileSync(filePath);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); }
  catch (_) { await wb.xlsx.load(await normalizeXlsx(buf)); }
  return { sheets: wb.worksheets.filter(ws => ws.state !== 'hidden').map(ws => ({ name: ws.name, ...sheetRows(ws) })) };
}

// Dziennik zdarzeń: data, zdarzenie, szczegóły
async function exportLog(rows, filePath) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'Skarbiec'; wb.created = new Date();
  const ws = wb.addWorksheet('Dziennik', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Data i godzina', key: 't', width: 20 }, { header: 'Zdarzenie', key: 'a', width: 28 }, { header: 'Szczegóły', key: 'd', width: 80 }];
  rows.forEach(r => ws.addRow({ t: toDate(r.t) || r.t, a: r.a, d: r.d }));
  ws.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  styleHeader(ws);
  await wb.xlsx.writeFile(filePath);
}

module.exports = { exportWorkbook, exportTemplate, exportLog, readTable, parseCSV };
