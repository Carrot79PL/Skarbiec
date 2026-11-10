(() => {
'use strict';
const api = window.api;
const ITER = 310000; // PBKDF2 – skarbce zapisane przed wersją 1.7.0
// Od 1.7.0 klucz z hasła głównego powstaje przez scrypt (1.7.0: N = 2^17; 1.8.0: N = 2^20; od 1.8.1: N = 2^20, p = 2), co wielokrotnie podraża zgadywanie haseł
const KDF_NEW = { alg: 'scrypt', N: 1048576, r: 8, p: 2 }; // N = 2^20, p = 2: ok. 1 GB pamięci i ok. 7 s na próbę (Apple M2)
const KDF_OLD = { alg: 'pbkdf2', iter: ITER };
const kdfOf = b => (b && b.kdf && b.kdf.alg === 'scrypt') ? { alg: 'scrypt', N: +b.kdf.N, r: +b.kdf.r, p: +b.kdf.p } : KDF_OLD;
const kdfWeak = k => k.alg !== 'scrypt' || k.N < KDF_NEW.N || k.N * k.p < KDF_NEW.N * KDF_NEW.p;
const IDLE_MS = 5 * 60 * 1000;
const CLIP_CLEAR_MS = 30000;
const LOG_MAX = 3000; // tyle ostatnich zdarzeń zostaje w dzienniku
const LICENSES = [
  'Microsoft 365 Business Basic', 'Microsoft 365 Business Standard', 'Microsoft 365 Business Premium',
  'Microsoft 365 Apps for business', 'Microsoft 365 E3', 'Microsoft 365 E5', 'Microsoft 365 F3',
  'Office 365 E1', 'Office 365 E3', 'Exchange Online (Plan 1)', 'Exchange Online (Plan 2)'
];
const NO_LICENSE = 'Bez licencji';
// Dostępy do innych aplikacji i stron (osobno dla każdego konta). Adres strony podpowiadany z listy albo z innych kont.
const APP_PRESETS = [
  { name: 'Facebook', url: 'https://www.facebook.com', color: '#1877F2' },
  { name: 'Instagram', url: 'https://www.instagram.com', color: '#E1306C' },
  { name: 'Meta Business Suite', url: 'https://business.facebook.com', color: '#0866FF' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com', color: '#0A66C2' },
  { name: 'TikTok', url: 'https://www.tiktok.com', color: '#111111' },
  { name: 'YouTube', url: 'https://studio.youtube.com', color: '#FF0000' },
  { name: 'Gmail', url: 'https://mail.google.com', color: '#EA4335' },
  { name: 'Inna poczta e-mail', url: '', color: '#5E6AD2' },
  { name: 'Google Ads', url: 'https://ads.google.com', color: '#FBBC04' },
  { name: 'Google Analytics', url: 'https://analytics.google.com', color: '#F9AB00' },
  { name: 'Asana', url: 'https://app.asana.com', color: '#F06A6A' },
  { name: 'Trello', url: 'https://trello.com', color: '#0079BF' },
  { name: 'Slack', url: 'https://app.slack.com', color: '#4A154B' },
  { name: 'Canva', url: 'https://www.canva.com', color: '#00C4CC' },
  { name: 'Magento', url: '', color: '#EE672F' },
  { name: 'Ergonode', url: '', color: '#2DB37A' },
  { name: 'WordPress', url: '', color: '#21759B' },
  { name: 'Shopify', url: 'https://admin.shopify.com', color: '#5E8E3E' },
  { name: 'Allegro', url: 'https://allegro.pl', color: '#FF5A00' },
  { name: 'Dropbox', url: 'https://www.dropbox.com', color: '#0061FF' }
];
const QUICK_APPS = ['Facebook', 'Instagram', 'Asana', 'Magento', 'Ergonode', 'Inna poczta e-mail'];
const APP_PREFIX = '\u0000app:';
// Przyciski szybkiego dodawania: aplikacje już używane w skarbcu (najczęstsze najpierw, np. dopisane „Adobe”), potem domyślne
function quickApps(skip = () => false, max = 12){
  const used = new Map();
  entries.forEach(e => new Set(e.apps.map(a => a.name)).forEach(n => { const k = appKey(n), c = used.get(k); used.set(k, { name: c ? c.name : n, n: (c ? c.n : 0) + 1 }); }));
  const list = [...used.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'pl')).map(x => x.name);
  QUICK_APPS.forEach(n => { if (!list.some(x => appKey(x) === appKey(n))) list.push(n); });
  return list.filter(n => !skip(n)).slice(0, max);
}
const appKey = n => String(n || '').trim().toLowerCase();
const presetOf = n => APP_PRESETS.find(p => appKey(p.name) === appKey(n));
function appColor(n){
  const p = presetOf(n); if (p) return p.color;
  let h = 0; for (const c of appKey(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 48%)`;
}
// Adres strony: z listy gotowych albo ostatnio wpisany przy tej aplikacji na innym koncie (np. panel Magento firmy)
function appUrlFor(n){
  const k = appKey(n); if (!k) return '';
  for (const e of entries) for (const a of e.apps) if (appKey(a.name) === k && a.url) return a.url;
  return (presetOf(n) || {}).url || '';
}
function safeUrl(u){
  u = String(u || '').trim(); if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname ? x.href : ''; } catch (_){ return ''; }
}

let key = null, salt = null, kdf = KDF_NEW, entries = [];
// Ustawienia trzymane w skarbcu (zaszyfrowane razem z kontami)
const DEFAULT_TPL = 'Dzień dobry {imię}. Hasło do konta {email}: {hasło}';
const SECTIONS = [
  { k: 'access', label: 'Logowanie i hasła' },
  { k: 'apps', label: 'Aplikacje i strony' },
  { k: 'lics', label: 'Licencje' },
  { k: 'info', label: 'Dane użytkownika' },
  { k: 'notes', label: 'Uwagi' }
];
const defaultCfg = () => ({ sms: { provider: '', number: '', token: '', sender: '', connected: false, template: DEFAULT_TPL, ascii: true },
  sections: SECTIONS.map(x => x.k),
  ms: { tenant: '', clientId: '', refreshToken: '', account: '', org: '', connected: false, lastSync: '', lastError: '', auto: true, skipDisabled: true, write: false },
  // Ustawienia bezpieczeństwa: blokada zrzutów ekranu, autoblokada, ukrywanie haseł, czyszczenie schowka, wiek hasła
  sec: { capture: true, lockMin: 5, lockHide: false, revealSec: 30, clipSec: 30, maxAge: 180 },
  log: [],      // dziennik zdarzeń (zaszyfrowany razem ze skarbcem)
  leaks: {},    // wynik sprawdzenia wycieków: { idKonta: { h: początek SHA-1 hasła, n: liczba wystąpień } }
  leaksAt: '',
  lic: [] });   // wykorzystanie licencji z Microsoft 365
let cfg = defaultCfg();
function normCfg(c){
  const d = defaultCfg(); const sm = (c && c.sms) || {};
  Object.keys(d.sms).forEach(k => { if (sm[k] != null) d.sms[k] = typeof d.sms[k] === 'boolean' ? !!sm[k] : String(sm[k]); });
  if (!d.sms.template.trim()) d.sms.template = DEFAULT_TPL;
  d.sections = normSections(c && c.sections);
  const ms = (c && c.ms) || {};
  Object.keys(d.ms).forEach(k => { if (ms[k] != null) d.ms[k] = typeof d.ms[k] === 'boolean' ? !!ms[k] : String(ms[k]); });
  const sec = (c && c.sec) || {};
  Object.keys(d.sec).forEach(k => { if (sec[k] != null) d.sec[k] = typeof d.sec[k] === 'boolean' ? !!sec[k] : (Number.isFinite(+sec[k]) ? +sec[k] : d.sec[k]); });
  d.log = Array.isArray(c && c.log) ? c.log.filter(x => x && x.t && x.a).slice(-LOG_MAX).map(x => ({ t: String(x.t), a: String(x.a), d: String(x.d || '') })) : [];
  d.leaks = (c && c.leaks && typeof c.leaks === 'object') ? c.leaks : {};
  d.leaksAt = String((c && c.leaksAt) || '');
  d.lic = Array.isArray(c && c.lic) ? c.lic.filter(x => x && x.name).map(x => ({ name: String(x.name), used: +x.used || 0, total: +x.total || 0 })) : [];
  return d;
}
function normSections(list){
  const keys = SECTIONS.map(x => x.k), out = (Array.isArray(list) ? list : []).filter((k, i, a) => keys.includes(k) && a.indexOf(k) === i);
  // Nowa sekcja (np. „Aplikacje i strony” od 1.10.0) trafia za sekcję, po której stoi domyślnie
  keys.forEach((k, i) => { if (!out.includes(k)){ const p = i ? out.indexOf(keys[i - 1]) : -1; out.splice(p + 1, 0, k); } });
  return out;
}
async function setSections(order){
  cfg.sections = normSections(order); renderDetail(); renderSectionSettings(); await persist();
}
function moveSection(k, delta){
  const o = cfg.sections.slice(), i = o.indexOf(k), j = i + delta;
  if (i < 0 || j < 0 || j >= o.length) return;
  [o[i], o[j]] = [o[j], o[i]]; setSections(o);
}
const smsReady = () => !!(cfg.sms.connected && cfg.sms.provider && cfg.sms.number);
let picked = new Set(), anchor = null, checking = false;
let revealAlt = new Set();

/* ---------- model danych ---------- */
// Dodatkowe pola konta (poza imieniem, nazwiskiem, e-mailem, hasłem, licencją i uwagami)
const FIELDS = [
  { k: 'displayName', label: 'Nazwa wyświetlana' },
  { k: 'department', label: 'Dział' },
  { k: 'jobTitle', label: 'Stanowisko' },
  { k: 'phone', label: 'Telefon' },
  { k: 'mobile', label: 'Telefon komórkowy' },
  { k: 'office', label: 'Biuro / lokalizacja' }
];
const STR_KEYS = ['firstName', 'lastName', 'email', 'password', 'license', 'notes', 'msId', 'msState', 'msPwChanged', 'pwSet', ...FIELDS.map(f => f.k)];
const NO_LIC_RE = /^(brak( licencji)?|bez licencji|unlicensed|none|-)$/i;
// Licencje konta: zapisane jako tekst „A, B, C”
function licList(e){
  const l = String(e.license || '').split(/\s*[;,\n]\s*/).map(x => x.trim()).filter(x => x && !NO_LIC_RE.test(x));
  return l.length ? licJoin(l).split(', ') : [NO_LICENSE];
}
const canonLic = l => LICENSES.find(x => x.toLowerCase() === l.toLowerCase()) || l;
function licJoin(list){
  const out = [];
  list.map(x => String(x).trim()).filter(x => x && !NO_LIC_RE.test(x) && x !== NO_LICENSE).map(canonLic)
    .forEach(x => { if (!out.some(y => y.toLowerCase() === x.toLowerCase())) out.push(x); });
  return out.length ? out.join(', ') : NO_LICENSE;
}
function normEntry(e){
  const o = { ...e };
  STR_KEYS.forEach(k => { o[k] = o[k] == null ? '' : String(o[k]); });
  o.license = licJoin(licList(o));
  o.altPasswords = Array.isArray(o.altPasswords) ? o.altPasswords.filter(a => a && a.password).map(a => ({ label: String(a.label || ''), password: String(a.password) })) : [];
  o.extra = Array.isArray(o.extra) ? o.extra.filter(x => x && (x.label || x.value)).map(x => ({ label: String(x.label || ''), value: String(x.value || '') })) : [];
  o.apps = Array.isArray(o.apps) ? o.apps.filter(a => a && String(a.name || '').trim()).map(a => ({ id: String(a.id || crypto.randomUUID()), name: String(a.name).trim(),
    url: String(a.url || ''), login: String(a.login || ''), password: String(a.password || ''), note: String(a.note || ''), pwSet: String(a.pwSet || '') })) : [];
  if (!o.id) o.id = crypto.randomUUID();
  return o;
}
// Pole własne, którego nazwa wskazuje na hasło/PIN – pokazywane w kropkach
const SECRET_RE = /(hasl|password|passwd|pwd|\bpin\b|\bpuk\b|sekret|secret|token)/i;
const isSecretLabel = l => SECRET_RE.test(Array.from(String(l || ''), c => c === 'ł' || c === 'Ł' ? 'l' : (c.normalize('NFD')[0] || c)).join(''));
const fullName = e => `${e.firstName} ${e.lastName}`.trim() || e.displayName || e.email;
let sel = null, licFilter = '', query = '', reveal = false, editingId = null, idleTimer = null;

const $ = s => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();
const isMac = api.platform === 'darwin';
if (isMac){
  document.body.classList.add('mac');
  document.querySelectorAll('[title*="Ctrl+"]').forEach(n => n.title = n.title.replace(/Ctrl\+/g, '⌘'));
}

/* ---------- pomocnicze ---------- */
const b64 = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function plural(n, one, few, many){ if (n === 1) return one; const d = n % 10, dd = n % 100; return (d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14)) ? few : many; }
const kont = n => `${n} ${plural(n, 'konto', 'konta', 'kont')}`;
function el(tag, props, ...kids){
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)){
    if (v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  kids.flat().forEach(c => c != null && e.append(c));
  return e;
}
const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  copy: '<rect x="8" y="8" width="11" height="11" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16M10 6c.6-.1 1.3-.2 2-.2 6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3 3.7M6.6 7.4A16 16 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.3-1"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M16 14.3c2.3.1 4 1.6 4.5 4"/>',
  person: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.7 3.6-5.8 7-5.8s6.2 2.1 7 5.8"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r=".8"/><circle cx="15" cy="15" r=".8"/><circle cx="15" cy="9" r=".8"/><circle cx="9" cy="15" r=".8"/>'
};
function icon(name){ const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = ICONS[name]; return s; }
function hue(str){ let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function avatar(e, xl){
  const h = hue(e.email.toLowerCase());
  const ini = ((e.firstName[0] || '') + (e.lastName[0] || '')).toUpperCase() || '?';
  return el('div', { class: 'avatar' + (xl ? ' xl' : ''), text: ini, style: `background:linear-gradient(160deg,hsl(${h} 72% 64%),hsl(${(h + 25) % 360} 68% 46%))` });
}
const licColor = l => l === NO_LICENSE ? 'hsl(0 0% 60%)' : `hsl(${hue(l)} 65% 55%)`;
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }); };

let toastT;
function toast(msg, opts = {}){
  const t = $('#toast'); t.replaceChildren(msg);
  if (opts.action) t.append(el('button', { class: 'link', type: 'button', text: opts.action.label, onclick: opts.action.fn }));
  t.classList.toggle('bad', !!opts.bad); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), opts.action ? 5000 : 2400);
}
async function copy(text, label, secret, who){
  const sec = (cfg.sec && cfg.sec.clipSec) || CLIP_CLEAR_MS / 1000;
  await api.copy(text, secret ? sec * 1000 : 0);
  if (secret && who) logEv('Skopiowano hasło', `${who} – ${label}`);
  toast(secret ? `Skopiowano ${label}. Schowek wyczyści się za ${sec} s` : `Skopiowano ${label}`);
}

/* ---------- dziennik zdarzeń ---------- */
let logTimer = null;
function logEv(a, d = ''){
  if (!key) return;
  cfg.log.push({ t: new Date().toISOString(), a, d: String(d).slice(0, 500) });
  if (cfg.log.length > LOG_MAX) cfg.log.splice(0, cfg.log.length - LOG_MAX);
  // zapis zbiorczy co sekundę (kilka kopiowań pod rząd = jeden zapis)
  clearTimeout(logTimer); logTimer = setTimeout(() => { logTimer = null; persist(); }, 1000);
  if ($('#logDlg').open) renderLog();
}
async function flushLog(){ if (logTimer){ clearTimeout(logTimer); logTimer = null; await persist(); } }

/* ---------- okno ---------- */
document.querySelectorAll('[data-win]').forEach(b => b.addEventListener('click', () => api.win(b.dataset.win)));
$('#lights').addEventListener('dblclick', e => e.stopPropagation());
// macOS: okno przesuwane przez program (górny pasek, pasek wyszukiwania, ekran blokady); podwójne kliknięcie – powiększenie
if (isMac){
  document.body.classList.add('js-drag');
  let drag = null, raf = 0;
  const grip = t => t.closest('.drag') && !t.closest('button,input,select,textarea,label,a,.nodrag,[contenteditable]');
  document.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || !grip(ev.target) || document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    drag = { x: ev.screenX, y: ev.screenY, id: ev.pointerId, el: ev.target };
    try { ev.target.setPointerCapture(ev.pointerId); } catch (_) {}
    api.win('dragStart');
  });
  document.addEventListener('pointermove', ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.screenX - drag.x, dy = ev.screenY - drag.y;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => api.winDrag(dx, dy));
  });
  const end = ev => { if (!drag || (ev && ev.pointerId !== drag.id)) return; try { drag.el.releasePointerCapture(drag.id); } catch (_) {} drag = null; api.win('dragEnd'); };
  document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  window.addEventListener('blur', () => end());
  document.addEventListener('dblclick', ev => { if (grip(ev.target) && !document.querySelector('dialog[open]')) api.win('max'); });
}
window.addEventListener('blur', () => document.body.classList.add('blurred'));
window.addEventListener('focus', () => document.body.classList.remove('blurred'));

/* ---------- kryptografia ---------- */
/* Pasek postępu tworzenia klucza. scrypt nie raportuje postępu, więc pasek idzie według szacowanego czasu
   (kalibrowanego pomiarem z poprzednich prób) i domyka się na 100%, gdy klucz jest gotowy. */
let kdfMsPerUnit = 3500 / 2 ** 20; // ms na jednostkę N (pierwsze przybliżenie dla Apple M2)
function kdfProgress(label, expectMs){
  const box = $('#lock').hidden ? $('#kdfAppProg') : $('#kdfLockProg');
  const fill = box.querySelector('.kdf-fill'), lbl = box.querySelector('.kdf-lbl'), t0 = performance.now();
  const pop = box.hasAttribute('popover'); // nad aplikacją: popover, żeby był widoczny także nad otwartym oknem dialogowym
  lbl.textContent = label; fill.style.width = '0%';
  if (pop){ try { box.showPopover(); } catch (_) {} } else box.hidden = false;
  const hide = () => { if (pop){ try { box.hidePopover(); } catch (_) {} } else box.hidden = true; };
  let raf = 0;
  const tick = () => {
    const x = (performance.now() - t0) / expectMs;
    // do 90% według szacunku, potem coraz wolniej – pasek nie stanie w miejscu, ale też nie dojdzie do końca przed czasem
    const pct = x < 1 ? 90 * x : 90 + 9 * (1 - Math.exp(-(x - 1) * 1.5));
    fill.style.width = pct.toFixed(1) + '%'; box.setAttribute('aria-valuenow', Math.round(pct));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return ok => { cancelAnimationFrame(raf); fill.style.width = ok ? '100%' : '0%'; setTimeout(hide, ok ? 250 : 0); };
}
async function deriveKey(pw, s, params = KDF_NEW, label = 'Odszyfrowywanie skarbca…'){
  if (params.alg === 'scrypt'){
    const big = params.N >= 2 ** 18, t0 = performance.now();
    const done = big ? kdfProgress(label, Math.max(400, kdfMsPerUnit * params.N * params.p)) : null;
    let raw;
    try { raw = await api.kdfScrypt(pw, b64(s), { N: params.N, r: params.r, p: params.p }); }
    catch (e) { done && done(false); throw e; }
    if (big){ kdfMsPerUnit = (performance.now() - t0) / (params.N * params.p); done(true); }
    try { return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
    finally { raw.fill(0); }
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: s, iterations: params.iter || ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptData(k, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decryptData(k, iv, ct){
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, k, unb64(ct));
  const data = JSON.parse(dec.decode(pt));
  return Array.isArray(data) ? data.map(normEntry) : data;
}
async function readBlob(){ const t = await api.vaultRead(); if (!t) return null; try { return JSON.parse(t); } catch (_) { return null; } }
async function blobText(){
  // Klucz, sól i parametry odczytane raz, na początku – plik zawsze pasuje do klucza, którym go zaszyfrowano
  const k0 = key, s0 = salt, p0 = kdf, data = entries, c0 = cfg;
  const { iv, ct } = await encryptData(k0, data);
  const k = p0.alg === 'scrypt' ? { v: 2, kdf: { alg: 'scrypt', N: p0.N, r: p0.r, p: p0.p } } : { v: 1 };
  return JSON.stringify({ ...k, app: 'skarbiec-kont-office', salt: b64(s0), iv, ct, cfg: await encryptData(k0, c0) });
}
// Ustawia nowy klucz razem z solą i parametrami w jednym kroku (bez chwili, w której zapis użyłby mieszanki starych i nowych)
function setKey(k, s, p){ key = k; salt = s; kdf = p; }
// Skarbiec (lub kopia) zabezpieczony starszą metodą: po poprawnym odblokowaniu przechodzi na scrypt z nową solą
async function upgradeKdf(pw){
  if (!kdfWeak(kdf)) return;
  const before = key, s = crypto.getRandomValues(new Uint8Array(16));
  let k; try { k = await deriveKey(pw, s, KDF_NEW, 'Wzmacnianie zabezpieczenia skarbca…'); } catch (_) { toast('Nie udało się wzmocnić zabezpieczenia (za mało pamięci?). Skarbiec działa jak dotąd.', { bad: true }); return; }
  if (key !== before) return; // w międzyczasie zablokowano skarbiec albo zmieniono hasło
  setKey(k, s, KDF_NEW);
  await persist();
  await persist(); // drugi zapis: także vault.json.bak (poprzednia wersja) ma już nowe zabezpieczenie
  logEv('Wzmocniono zabezpieczenie skarbca', `scrypt N = ${KDF_NEW.N}, p = ${KDF_NEW.p}`);
  toast('Wzmocniono zabezpieczenie skarbca (scrypt). Zapisz nową kopię zapasową.');
}
async function readCfg(k, b){ if (!b.cfg) return defaultCfg(); try { return normCfg(await decryptData(k, b.cfg.iv, b.cfg.ct)); } catch (_) { return defaultCfg(); } }
// Zapamiętuje datę ustawienia hasła w skarbcu (porównanie z datą zmiany w Microsoft 365)
let pwSnap = new Map();
function snapPw(){ pwSnap = new Map(); entries.forEach(e => { pwSnap.set(e.id, e.password); e.apps.forEach(a => pwSnap.set(e.id + ':' + a.id, a.password)); }); }
function stampPw(){
  const now = new Date().toISOString();
  entries.forEach(e => {
    const old = pwSnap.get(e.id); if (old !== e.password){ if (e.password) e.pwSet = now; if (cfg.leaks) delete cfg.leaks[e.id]; }
    // Hasło aplikacji: nowe albo zmienione → nowa data ustawienia, stary wynik sprawdzenia wycieków nieważny
    e.apps.forEach(a => { const k = e.id + ':' + a.id; if (pwSnap.get(k) !== a.password){ if (a.password && (pwSnap.has(k) || !a.pwSet)) a.pwSet = now; if (cfg.leaks) delete cfg.leaks[k]; } });
  });
  snapPw();
}
// Hasło zmienione w Microsoft 365 później niż zapisane w skarbcu (z 2-minutowym marginesem)
function pwStale(e){
  if (!e.password || !e.msPwChanged || e.msState === 'gone') return false;
  const ms = Date.parse(e.msPwChanged), local = Date.parse(e.pwSet || e.created);
  return !isNaN(ms) && !isNaN(local) && ms > local + 120000;
}
// Zapisy jeden po drugim – równoległe zapisy (np. synchronizacja M365 w trakcie edycji) nie mogą się przeplatać
let saveChain = Promise.resolve();
function persist(){
  stampPw();
  const job = saveChain.then(async () => {
    if (!key) return;
    try { await api.vaultWrite(await blobText()); }
    catch (_) { toast('Nie udało się zapisać skarbca na dysku.', { bad: true }); }
  });
  saveChain = job.catch(() => {});
  return job;
}

/* ---------- blokada ---------- */
let lockMode = 'unlock';
// Nazwa, wersja i autor programu (ekran blokady i „Kopia i ustawienia”)
(async () => {
  try {
    const i = await api.appInfo();
    $('#lockAppVer').textContent = `wersja ${i.version}`;
    $('#lockVer').textContent = i.author ? `Autor: ${i.author} · © ${i.year}` : '';
    $('#aboutTxt').textContent = `${i.name}, wersja ${i.version}` + (i.author ? `. Autor: ${i.author}. © ${i.year}` : '') +
      '. Dane szyfrowane AES-256-GCM, klucz z hasła głównego tworzony algorytmem scrypt (N = 2²⁰, r = 8, p = 2 – ok. 1 GB pamięci i kilka sekund na próbę).';
  } catch (_) {}
})();

async function showLock(reason){
  if (key){ if (reason) logEv('Zablokowano', reason); await flushLog(); }
  clearTimeout(revealTimer);
  api.protect(true); // ekran blokady zawsze chroniony przed zrzutami
  msStop(); key = null; entries = []; cfg = defaultCfg(); setSel(null); checking = false; reveal = false;
  clearTimeout(idleTimer);
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  $('#list').replaceChildren(); $('#detailBody').replaceChildren();
  $('#app').hidden = true; $('#lock').hidden = false;
  $('#mp').value = ''; $('#mp2').value = ''; $('#lockErr').textContent = '';
  const blob = await readBlob();
  lockMode = blob ? 'unlock' : 'create';
  const foot = $('#lockFoot'); foot.replaceChildren();
  if (lockMode === 'create'){
    $('#lockLead').textContent = 'Ustal hasło główne (min. 10 znaków). Szyfruje ono wszystkie konta i nie da się go odzyskać.';
    $('#mp').placeholder = 'Nowe hasło główne';
    $('#mp2').hidden = false; $('#lockBtn').textContent = 'Utwórz skarbiec';
    foot.append('Masz kopię zapasową? Po utworzeniu skarbca przywrócisz ją w „Kopia i ustawienia”.');
  } else {
    $('#lockLead').textContent = 'Wpisz hasło główne, aby odblokować.';
    $('#mp').placeholder = 'Hasło główne';
    $('#mp2').hidden = true; $('#lockBtn').textContent = 'Odblokuj';
    foot.append(el('button', { class: 'link', type: 'button', text: 'Nie pamiętam hasła głównego', onclick: async () => {
      if (await askConfirm('Usunąć skarbiec?', 'Bez hasła głównego danych nie da się odczytać. Możesz usunąć skarbiec i zacząć od nowa lub przywrócić kopię zapasową.', 'Usuń skarbiec')){
        await api.vaultDelete(); showLock(); toast('Skarbiec usunięty');
      }
    } }));
  }
  setTimeout(() => $('#mp').focus(), 50);
}

// Nieudane próby odblokowania: od 3. próby rosnąca przerwa (15 s, 30 s, 60 s… maks. 5 min)
let failCount = 0, failUntil = 0, failTimer = null;
function lockCountdown(){
  clearInterval(failTimer);
  const btn = $('#lockBtn'), tick = () => {
    const left = Math.ceil((failUntil - Date.now()) / 1000);
    if (left <= 0){ clearInterval(failTimer); btn.disabled = false; btn.textContent = lockMode === 'create' ? 'Utwórz skarbiec' : 'Odblokuj'; return; }
    btn.disabled = true; btn.textContent = `Spróbuj ponownie za ${left} s`;
  };
  tick(); failTimer = setInterval(tick, 500);
}
$('#lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (Date.now() < failUntil) return;
  const pw = $('#mp').value, err = $('#lockErr'), btn = $('#lockBtn');
  err.textContent = ''; btn.disabled = true;
  try {
    if (lockMode === 'create'){
      if (pw.length < 10){ err.textContent = 'Hasło główne musi mieć co najmniej 10 znaków.'; return; }
      if (pw !== $('#mp2').value){ err.textContent = 'Hasła nie są takie same.'; return; }
      btn.textContent = 'Tworzenie skarbca…';
      const s = crypto.getRandomValues(new Uint8Array(16));
      const k = await deriveKey(pw, s, KDF_NEW, 'Tworzenie klucza szyfrowania…'); entries = []; cfg = defaultCfg(); setKey(k, s, KDF_NEW);
      logEv('Utworzono skarbiec');
      await persist(); openApp();
    } else {
      const blob = await readBlob();
      if (!blob){ showLock(); return; }
      const s = unb64(blob.salt), p = kdfOf(blob);
      let k;
      try { k = await deriveKey(pw, s, p); }
      catch (_){ err.textContent = 'Plik skarbca jest uszkodzony (nieprawidłowe parametry klucza).'; return; }
      try { entries = await decryptData(k, blob.iv, blob.ct); }
      catch (_){
        failCount++; err.textContent = 'Nieprawidłowe hasło główne.' + (failCount > 1 ? ` (nieudane próby: ${failCount})` : ''); $('#mp').select(); shake();
        if (failCount >= 3){ failUntil = Date.now() + Math.min(300, 15 * 2 ** (failCount - 3)) * 1000; setTimeout(lockCountdown, 0); }
        return;
      }
      snapPw(); cfg = await readCfg(k, blob); setKey(k, s, p); openApp();
      logEv('Odblokowano skarbiec', failCount ? `wcześniej nieudane próby: ${failCount}` : '');
      failCount = 0; failUntil = 0;
      await upgradeKdf(pw);
    }
  } finally { if (Date.now() >= failUntil){ btn.disabled = false; btn.textContent = lockMode === 'create' ? 'Utwórz skarbiec' : 'Odblokuj'; } }
});
function shake(){ $('#lockForm').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(0)' }], { duration: 320 }); }

/* ---------- aplikacja ---------- */
function openApp(){
  $('#mp').value = ''; $('#mp2').value = '';
  $('#lock').hidden = true; $('#app').hidden = false;
  query = ''; licFilter = ''; flt = {}; $('#search').value = '';
  setSel(null); checking = false; render(); resetIdle(); msStart();
  api.protect(cfg.sec.capture);
}
/* ---------- wyszukiwanie ---------- */
// Porównanie bez wielkości liter i polskich znaków; każdy znak zostaje jednym znakiem (do podświetlania)
const foldChar = c => c === 'ł' || c === 'Ł' ? 'l' : (c.normalize('NFD')[0] || c).toLowerCase();
const fold = str => Array.from(String(str || ''), foldChar).join('');
function searchText(e){
  const parts = [e.firstName, e.lastName, e.lastName + ' ' + e.firstName, e.email, e.license, e.notes,
    ...FIELDS.map(f => e[f.k]), ...e.extra.map(x => x.label + ' ' + x.value), ...e.altPasswords.map(a => a.label),
    ...e.apps.map(a => `${a.name} ${a.login} ${a.url.replace(/^https?:\/\/(www\.)?/, '')} ${a.note}`)];
  const digits = [e.phone, e.mobile].map(x => String(x || '').replace(/\D/g, '')).filter(Boolean);
  return fold(parts.concat(digits).join(' \u0001 '));
}
const tokens = () => fold(query).split(/\s+/).filter(Boolean);
// Konto imienne = konkretnej osoby (imię i nazwisko), a nie skrzynka wspólna/usługowa (biuro@, faktury@, skaner@…)
const GENERIC_RE = /^(biuro|office|info|kontakt|contact|admin|administrator|administracja|sekretariat|recepcja|ksiegowosc|accounting|faktur[ay]|invoices?|kadry|hr|sprzedaz|sales|handlowy|marketing|serwis|service|support|pomoc|helpdesk|it|noreply|no-reply|zamowieni[ae]|orders?|ofert[ay]|rekrutacja|praca|jobs|magazyn|logistyka|transport|dostawy|zarzad|dyrekcja|reklamacje|platnosci|rodo|iod|newsletter|skaner|scan|scanner|drukarka|printer|test\w*|kasa|bok|allusers|all|wszyscy|team|zespol|projekty?|produkcja|jakosc|bhp|spedycja|zakupy|purchase|dzial\w*|post|poczta|mail|webmaster|postmaster|hostmaster|abuse|root|system|alert\w*|monitoring|backup)$/;
function isNamed(e){
  if (!String(e.firstName || '').trim() || !String(e.lastName || '').trim()) return false;
  const local = fold(String(e.email || '').split('@')[0]).replace(/[0-9]+$/, '');
  return !GENERIC_RE.test(local) && !GENERIC_RE.test(fold(e.firstName));
}
function navMatch(e){
  if (!licFilter) return true;
  if (HEALTH[licFilter]) return HEALTH[licFilter].test(e);
  if (licFilter.startsWith(APP_PREFIX)) return hasApp(e, licFilter.slice(APP_PREFIX.length));
  return licFilter === MS_GONE ? e.msState === 'gone' : licFilter === PW_STALE ? pwStale(e) : licFilter === NAMED ? isNamed(e) : licList(e).includes(licFilter);
}

/* ---------- bezpieczeństwo haseł: siła, powtórzenia, wiek, wycieki ---------- */
const COMMON_RE = /(haslo|haselko|password|passw|qwerty|qwertz|asdf|zxcv|admin|office|outlook|microsoft|welcome|witaj|lato|zima|wiosna|jesien|polska|kochan|monika|mateusz|letmein|abc123|123456|111111|000000|test|firma|start|biuro|marzec|kwiecien|styczen|luty|maj|czerwiec|lipiec|sierpien|wrzesien|pazdziernik|listopad|grudzien)/;
const SEQ_RE = /(012|123|234|345|456|567|678|789|890|abc|bcd|cde|def|qwe|wer|ert|asd|sdf|zxc)/;
// Przybliżona entropia w bitach (z karami za typowe wzorce: słowa, lata, sekwencje, dane użytkownika)
function pwBits(pw, e){
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26; if (/[A-Z]/.test(pw)) pool += 26; if (/\d/.test(pw)) pool += 10; if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(pool || 1);
  const f = fold(pw);
  if (COMMON_RE.test(f)) bits -= 22;
  if (SEQ_RE.test(f)) bits -= 8;
  if (/(.)\1\1/.test(pw)) bits -= 10;
  if (/(19|20)\d\d/.test(pw)) bits -= 8;
  if (/^[A-Z]?[a-z]+[\d]+[^A-Za-z0-9]{0,2}$/.test(pw)) bits -= 15; // Słowo123!
  if (e){
    const own = [e.firstName, e.lastName, String(e.email || '').split('@')[0]].map(x => fold(x)).filter(x => x.length >= 3);
    if (own.some(x => f.includes(x))) bits -= 20;
  }
  return Math.max(0, Math.round(bits));
}
const pwLevel = (pw, e) => { const b = pwBits(pw, e); return b < 45 ? 'weak' : b < 65 ? 'medium' : 'strong'; };
// Hasła konta do oceny: główne (Microsoft 365) i hasła aplikacji. Klucz wycieku: id konta albo id konta:id aplikacji.
const hasApp = (e, n) => e.apps.some(a => appKey(a.name) === appKey(n));
function secrets(e){
  const out = e.password ? [{ k: e.id, what: 'Microsoft 365', pw: e.password, set: e.pwSet || e.created }] : [];
  e.apps.forEach(a => { if (a.password) out.push({ k: e.id + ':' + a.id, what: a.name, app: a, pw: a.password, set: a.pwSet || e.created }); });
  return out;
}
let reuseMap = new Map();
function buildReuse(){ reuseMap = new Map(); entries.forEach(e => secrets(e).forEach(s => reuseMap.set(s.pw, (reuseMap.get(s.pw) || 0) + 1))); }
const reuseOf = pw => pw ? (reuseMap.get(pw) || 1) - 1 : 0;
const reuseCount = e => e.password ? reuseOf(e.password) : 0;
const ageOf = t => { t = Date.parse(t); return isNaN(t) ? 0 : Math.floor((Date.now() - t) / 864e5); };
const pwAgeDays = e => ageOf(e.pwSet || e.created);
const leakN = k => cfg.leaks && cfg.leaks[k] && cfg.leaks[k].n > 0 ? cfg.leaks[k].n : 0;
const leakOf = e => e.password ? leakN(e.id) : 0;
const sWeak = (s, e) => pwLevel(s.pw, e) === 'weak', sOld = s => ageOf(s.set) > cfg.sec.maxAge;
const HEALTH = {
  '\u0000h-leak': { label: 'Hasła z wycieków', color: '#E5484D', test: e => secrets(e).some(s => leakN(s.k)) },
  '\u0000h-weak': { label: 'Słabe hasła', color: '#FF8B3E', test: e => secrets(e).some(s => sWeak(s, e)) },
  '\u0000h-reuse': { label: 'Powtórzone hasła', color: '#F5A524', test: e => secrets(e).some(s => reuseOf(s.pw) > 0) },
  '\u0000h-old': { label: 'Stare hasła', color: '#8E8E93', test: e => secrets(e).some(sOld) },
  '\u0000h-none': { label: 'Bez hasła', color: '#8E8E93', test: e => !e.password }
};
function healthIssues(e){
  const out = [];
  const where = s => s.app ? ` (${s.what})` : '';
  const others = s => { const l = []; entries.forEach(x => secrets(x).forEach(y => { if (y.pw === s.pw && y.k !== s.k) l.push(x === e ? y.what : `${x.email}${y.app ? ' – ' + y.what : ''}`); })); return l; };
  secrets(e).forEach(s => {
    const n = leakN(s.k), act = s.app ? { app: s.app } : { main: true };
    if (n) out.push({ bad: true, ...act, text: `Hasło${where(s)} występuje w znanych wyciekach danych (${n.toLocaleString('pl-PL')} razy). Zmień je jak najszybciej.` });
    if (sWeak(s, e)) out.push({ ...act, text: `Słabe hasło${where(s)} – łatwe do odgadnięcia (krótkie, typowe słowo, rok albo dane użytkownika).` });
    const o = reuseOf(s.pw) ? others(s) : [];
    if (o.length) out.push({ ...act, text: `To samo hasło${where(s)} jest też użyte w: ` + o.slice(0, 4).join(', ') + (o.length > 4 ? '…' : '') });
    if (sOld(s)) out.push({ ...act, text: `Hasło${where(s)} nie było zmieniane od ${ageOf(s.set)} dni (próg: ${cfg.sec.maxAge}).` });
  });
  return out;
}
function healthBlock(e){
  const iss = healthIssues(e); if (!iss.length) return null;
  const apps = [...new Map(iss.filter(x => x.app).map(x => [x.app.id, x.app])).values()];
  return el('div', { class: 'h-issues' + (iss.some(x => x.bad) ? ' bad' : '') },
    el('ul', null, iss.map(x => el('li', { text: x.text }))),
    el('div', { class: 'row-btns' },
      iss.some(x => x.main) ? el('button', { class: 'btn small', type: 'button', text: 'Zmień hasło…', onclick: () => newPassword(e) }) : null,
      ...apps.slice(0, 3).map(a => el('button', { class: 'btn small', type: 'button', text: `Nowe hasło: ${a.name}`, onclick: () => newAppPassword(e, a) }))));
}
/* Filtry łączone (pasek „Filtry” nad listą): rodzaj konta, licencja, dział, stanowisko, biuro */
const NONE = '\u0000none';
const FLT = [
  { k: 'kind', label: 'Rodzaj konta', vals: e => [isNamed(e) ? 'Imienne' : 'Wspólne / usługowe'] },
  { k: 'lic', label: 'Licencja', vals: e => licList(e) },
  { k: 'app', label: 'Aplikacja', vals: e => e.apps.length ? [...new Set(e.apps.map(a => a.name))] : [NONE] },
  { k: 'department', label: 'Dział', vals: e => [String(e.department || '').trim() || NONE] },
  { k: 'jobTitle', label: 'Stanowisko', vals: e => [String(e.jobTitle || '').trim() || NONE] },
  { k: 'office', label: 'Biuro', vals: e => [String(e.office || '').trim() || NONE] }
];
let flt = {};
const fltOn = () => FLT.filter(f => flt[f.k]);
const fltMatch = (e, skip) => FLT.every(f => f.k === skip || !flt[f.k] || f.vals(e).some(v => v.toLowerCase() === flt[f.k].toLowerCase()));
const fltVal = v => v === NONE ? '(brak)' : v;
const fltSummary = () => fltOn().map(f => `${f.label.toLowerCase()}: ${fltVal(flt[f.k])}`).join(', ');
function inFilter(e){ return navMatch(e) && fltMatch(e); }
const filterName = () => (HEALTH[licFilter] ? HEALTH[licFilter].label : licFilter.startsWith(APP_PREFIX) ? 'Dostęp: ' + licFilter.slice(APP_PREFIX.length) : licFilter === MS_GONE ? 'Brak w Microsoft 365' : licFilter === PW_STALE ? 'Hasło do sprawdzenia' : licFilter === NAMED ? 'Konta imienne' : licFilter || 'Wszystkie konta') +
  (fltOn().length ? ' · ' + fltSummary() : '');
let fltOpen = false;
function renderFilters(){
  const box = $('#filters'), n = fltOn().length;
  $('#fltN').hidden = !n; $('#fltN').textContent = n; $('#fltBtn').classList.toggle('on', fltOpen || !!n);
  $('#fltBtn').setAttribute('aria-expanded', String(fltOpen));
  box.hidden = !fltOpen; if (!fltOpen) return;
  const t = tokens();
  box.replaceChildren(...FLT.map(f => {
    // Liczby przy wartościach uwzględniają pozostałe filtry i wyszukiwanie (ile kont zostanie po wyborze)
    const counts = new Map();
    entries.filter(e => navMatch(e) && fltMatch(e, f.k) && (!t.length || (s => t.every(w => s.includes(w)))(searchText(e))))
      .forEach(e => new Set(f.vals(e).map(v => v.trim()).filter(Boolean)).forEach(v => counts.set(v, (counts.get(v) || 0) + 1)));
    const cur = flt[f.k] || '';
    if (cur && !counts.has(cur)) counts.set(cur, 0);
    const opts = [...counts.entries()].sort((a, b) => (a[0] === NONE) - (b[0] === NONE) || a[0].localeCompare(b[0], 'pl'));
    const s = el('select', { class: 'field small' + (cur ? ' on' : ''), 'aria-label': f.label, onchange: ev => { flt[f.k] = ev.target.value; setSel(null); render(); } },
      el('option', { value: '', text: `${f.label}: wszystkie` }),
      ...opts.map(([v, c]) => el('option', { value: v, text: `${f.label}: ${fltVal(v)} (${c})` })));
    s.value = cur;
    return s;
  }), el('button', { class: 'lh-btn', type: 'button', text: 'Wyczyść', disabled: !n, onclick: () => { flt = {}; setSel(null); render(); } }));
}
$('#fltBtn').addEventListener('click', () => { fltOpen = !fltOpen; renderFilters(); });
function visible(){
  const t = tokens();
  return entries.filter(e => inFilter(e) &&
      (!t.length || (s => t.every(w => s.includes(w)))(searchText(e))))
    .sort((a, b) => (a.lastName + ' ' + a.firstName).localeCompare(b.lastName + ' ' + b.firstName, 'pl'));
}
// Element z podświetlonymi fragmentami pasującymi do wyszukiwania
function hl(tag, cls, text){
  const node = el(tag, { class: cls }); text = String(text || '');
  const t = tokens(); if (!t.length){ node.textContent = text; return node; }
  const f = fold(text), mark = new Array(text.length).fill(false);
  t.forEach(w => { let i = f.indexOf(w); while (i >= 0){ for (let j = i; j < i + w.length; j++) mark[j] = true; i = f.indexOf(w, i + 1); } });
  let i = 0;
  while (i < text.length){ let j = i; while (j < text.length && mark[j] === mark[i]) j++;
    node.append(mark[i] ? el('mark', { text: text.slice(i, j) }) : document.createTextNode(text.slice(i, j))); i = j; }
  return node;
}
// Pole pasujące do wyszukiwania, gdy nie widać go w imieniu ani w adresie
function matchHint(e){
  const t = tokens(); if (!t.length) return null;
  const seen = fold(`${e.firstName} ${e.lastName} ${e.lastName} ${e.email}`);
  if (t.every(w => seen.includes(w))) return null;
  const hit = v => v && t.some(w => fold(v).includes(w) || (/^\d+$/.test(w) && String(v).replace(/\D/g, '').includes(w)));
  // Z licencji pokazujemy tylko te pasujące
  const lic = licList(e).filter(hit);
  const cands = [...FIELDS.map(f => [f.label, e[f.k]]), [lic.length > 1 ? 'Licencje' : 'Licencja', lic.join(', ')], ['Uwagi', e.notes], ...e.extra.map(x => [x.label, x.value]),
    ...e.apps.map(a => ['Dostęp', [a.name, a.login, a.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), a.note].filter(Boolean).join(' · ')])];
  for (const [l, v] of cands) if (hit(v)){
    // Długi tekst: fragment wokół pierwszego trafienia
    const f = fold(v), at = Math.max(0, Math.min(...t.map(w => f.indexOf(w)).filter(i => i >= 0)));
    const start = v.length > 48 && at > 16 ? at - 12 : 0;
    return [l, (start ? '…' : '') + v.slice(start)];
  }
  return null;
}
function render(){ renderNav(); renderFilters(); renderList(); renderDetail(); }

function renderNav(){
  const counts = new Map();
  entries.forEach(e => licList(e).forEach(l => counts.set(l, (counts.get(l) || 0) + 1)));
  const gone = entries.filter(e => e.msState === 'gone').length, stale = entries.filter(pwStale).length, named = entries.filter(isNamed).length;
  buildReuse();
  const hc = Object.fromEntries(Object.entries(HEALTH).map(([k, h]) => [k, entries.filter(h.test).length]));
  const apps = new Map();
  entries.forEach(e => new Set(e.apps.map(a => a.name)).forEach(n => { const k = appKey(n), c = apps.get(k); apps.set(k, { name: c ? c.name : n, n: (c ? c.n : 0) + 1 }); }));
  if (licFilter && !(licFilter.startsWith(APP_PREFIX) ? apps.has(appKey(licFilter.slice(APP_PREFIX.length))) : HEALTH[licFilter] ? hc[licFilter] : licFilter === MS_GONE ? gone : licFilter === PW_STALE ? stale : licFilter === NAMED ? named : counts.has(licFilter))) licFilter = '';
  const item = (label, val, n, lead) => el('button', { type: 'button', class: 'nav-item' + (licFilter === val ? ' on' : ''), title: label,
    onclick: () => { licFilter = val; setSel(null); render(); } }, lead, el('span', { class: 'nm', text: label }), el('span', { class: 'ct', text: String(n) }));
  const nav = $('#nav'); nav.replaceChildren(
    el('h4', { text: 'Skarbiec' }),
    item('Wszystkie konta', '', entries.length, icon('people'))
  );
  if (named && named < entries.length) nav.append(item('Konta imienne', NAMED, named, icon('person')));
  if (stale) nav.append(item('Hasło do sprawdzenia', PW_STALE, stale, el('span', { class: 'dot', style: 'background:#FF9F0A' })));
  if (gone) nav.append(item('Brak w Microsoft 365', MS_GONE, gone, el('span', { class: 'dot', style: 'background:var(--danger)' })));
  const hk = Object.keys(HEALTH).filter(k => hc[k]);
  if (entries.length){
    const h4 = el('h4', { class: 'nav-h-btn' }, el('span', { text: 'Bezpieczeństwo haseł' }),
      el('button', { class: 'link small', type: 'button', text: 'Raport', title: 'Przegląd bezpieczeństwa, wycieki, licencje', onclick: openHealth }));
    nav.append(h4);
    hk.forEach(k => nav.append(item(HEALTH[k].label, k, hc[k], el('span', { class: 'dot', style: `background:${HEALTH[k].color}` }))));
    if (!hk.length) nav.append(el('p', { class: 'nav-ok', text: '✓ Brak problemów' }));
  }
  if (apps.size){
    nav.append(el('h4', { text: 'Aplikacje i strony' }));
    [...apps.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl')).forEach(a =>
      nav.append(item(a.name, APP_PREFIX + a.name, a.n, el('span', { class: 'dot', style: `background:${appColor(a.name)}` }))));
  }
  if (counts.size){
    nav.append(el('h4', { text: 'Licencje' }));
    [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pl')).forEach(([l, n]) =>
      nav.append(item(l.replace(/^Microsoft 365 /, 'M365 ').replace(/^Office 365 /, 'O365 '), l, n, el('span', { class: 'dot', style: `background:${licColor(l)}` }))));
  }
}

/* ---------- zaznaczanie ---------- */
function setSel(id){ sel = id; anchor = id; picked = new Set(id ? [id] : []); }
const multi = () => picked.size > 1;
const checkMode = () => checking || multi();
const pickedEntries = () => visible().filter(e => picked.has(e.id));
function syncSel(list){
  const ids = new Set(list.map(e => e.id));
  picked = new Set([...picked].filter(id => ids.has(id)));
  if (sel && !ids.has(sel)) sel = null;
  if (sel && !picked.has(sel)) sel = picked.size ? [...picked][picked.size - 1] : null;
  if (!sel && picked.size) sel = [...picked][picked.size - 1];
  if (sel && !picked.size && !checking) picked.add(sel);
}
function refresh(){ renderList(); renderDetail(); }
function clickItem(ev, id){
  const list = visible();
  if (ev.shiftKey && anchor && list.some(e => e.id === anchor)){
    const a = list.findIndex(e => e.id === anchor), b = list.findIndex(e => e.id === id);
    const range = list.slice(Math.min(a, b), Math.max(a, b) + 1).map(e => e.id);
    picked = (ev.metaKey || ev.ctrlKey) ? new Set([...picked, ...range]) : new Set(range);
    sel = id;
  } else if (ev.metaKey || ev.ctrlKey || ev.forceToggle || checking){
    if (picked.has(id)){ picked.delete(id); if (sel === id) sel = picked.size ? [...picked][picked.size - 1] : null; }
    else { picked.add(id); sel = id; }
    anchor = id;
  } else {
    if (sel !== id){ reveal = false; revealAlt.clear(); }
    setSel(id);
  }
  refresh(); scrollToItem(id);
}
function selectAll(){
  const list = visible(); if (!list.length) return;
  picked = new Set(list.map(e => e.id)); if (!sel || !picked.has(sel)) sel = list[0].id; anchor = sel;
  refresh();
}
function exitSelect(){ checking = false; picked = new Set(sel ? [sel] : []); refresh(); }
function scrollToItem(id){ const li = id && $(`.item[data-id="${CSS.escape(id)}"]`); li && li.scrollIntoView({ block: 'nearest' }); }

function renderList(){
  const list = visible();
  syncSel(list);
  const cm = checkMode();
  const head = $('#listHead'); head.replaceChildren();
  head.append(el('span', { class: 'lh-txt', text: cm
    ? `Zaznaczono ${picked.size} z ${list.length}`
    : filterName() + ', ' + kont(list.length), title: filterName() }));
  if (fltOn().length && !cm) head.append(el('button', { class: 'lh-btn', type: 'button', text: 'Wyczyść filtry', onclick: () => { flt = {}; setSel(null); render(); } }));
  if (list.length){
    const lb = (text, fn, title) => el('button', { class: 'lh-btn', type: 'button', text, title, onclick: fn });
    if (cm){
      head.append(picked.size === list.length
        ? lb('Odznacz wszystkie', () => { picked = new Set(); sel = null; refresh(); })
        : lb('Zaznacz wszystkie', selectAll, isMac ? '⌘A' : 'Ctrl+A'));
      head.append(lb('Gotowe', exitSelect));
    } else {
      head.append(lb('Zaznacz', () => { checking = true; refresh(); }, 'Zaznacz kilka kont (także ' + (isMac ? '⌘' : 'Ctrl+') + 'klik, Shift+klik)'));
    }
  }
  const ul = $('#list'); ul.replaceChildren(); ul.classList.toggle('checking', cm);
  ul.setAttribute('aria-multiselectable', 'true');
  if (!list.length){
    ul.append(el('li', { class: 'list-empty', text: entries.length ? 'Brak wyników.' : 'Brak kont.' }));
    return;
  }
  list.forEach(e => {
    const on = picked.has(e.id);
    const box = el('span', { class: 'chk' + (on ? ' on' : ''), 'aria-hidden': 'true' });
    box.addEventListener('click', ev => { ev.stopPropagation(); clickItem({ forceToggle: true, shiftKey: ev.shiftKey }, e.id); });
    ul.append(el('li', { class: 'item' + (on ? ' on' : '') + (e.id === sel && cm ? ' cur' : ''), role: 'option', 'aria-selected': String(on), 'data-id': e.id,
      onclick: ev => clickItem(ev, e.id), ondblclick: () => { if (!checkMode()) openEditor(e); } },
      box, avatar(e), el('div', { class: 'tx' }, hl('div', 'nm', fullName(e)), hl('div', 'sub', e.email),
        (h => h ? el('div', { class: 'sub mhint' }, h[0] + ': ', hl('span', null, h[1])) : null)(matchHint(e)))));
  });
}
function select(id){ if (sel !== id){ reveal = false; revealAlt.clear(); } setSel(id); refresh(); scrollToItem(id); }

function renderBulk(box){
  const list = pickedEntries();
  if (!list.length){
    box.append(el('div', { class: 'd-empty' }, el('div', null, icon('people'), el('h3', { text: 'Zaznacz konta' }),
      el('p', { text: 'Klikaj konta na liście albo użyj „Zaznacz wszystkie”.' }))));
    return;
  }
  const names = list.slice(0, 8).map(e => el('li', null, el('b', { text: fullName(e) }), el('span', { text: ' ' + e.email })));
  if (list.length > 8) names.push(el('li', { class: 'more', text: `i ${kont(list.length - 8)} więcej` }));
  box.append(
    el('div', { class: 'd-head' }, el('div', { class: 'avatar xl bulk', text: String(list.length) }), el('div', null,
      el('h2', { text: `Zaznaczono ${kont(list.length)}` }), el('p', { text: 'Wybierz, co zrobić z zaznaczonymi kontami.' }))),
    el('ul', { class: 'group bulk-list' }, names),
    el('div', { class: 'd-actions' },
      el('button', { class: 'btn danger', type: 'button', text: `Usuń zaznaczone (${list.length})`, onclick: () => removeMany(list) }),
      el('button', { class: 'btn primary', type: 'button', text: 'Uzupełnij dane…', onclick: () => openBulk(list) }),
      el('button', { class: 'btn', type: 'button', text: `Zmień hasła (${list.length})…`, onclick: () => openPwChange(list) }),
      el('button', { class: 'btn', type: 'button', text: 'Dodaj dostęp do aplikacji…', onclick: () => openAppBulk(list) }),
      el('button', { class: 'btn', type: 'button', text: 'Eksportuj zaznaczone', onclick: () => exportRows(list) }),
      el('button', { class: 'btn', type: 'button', text: `Karty dostępu (${list.length})…`, onclick: () => openCard(list) }),
      el('button', { class: 'btn', type: 'button', text: 'Odznacz', onclick: exitSelect }))
  );
}

function renderDetail(){
  const box = $('#detailBody'); box.replaceChildren();
  if (multi() || (checking && !picked.size)){ renderBulk(box); return; }
  const e = entries.find(x => x.id === sel);
  if (!e){
    box.append(entries.length
      ? el('div', { class: 'd-empty' }, el('div', null, icon('key'), el('h3', { text: 'Wybierz konto' }), el('p', { text: 'Szczegóły i hasło pojawią się tutaj.' })))
      : el('div', { class: 'd-empty' }, el('div', null, icon('key'), el('h3', { text: 'Skarbiec jest pusty' }),
          el('p', { text: 'Dodaj pierwsze konto albo zaimportuj listę z Excela.' }),
          el('div', { class: 'd-actions', style: 'justify-content:center' },
            el('button', { class: 'btn primary', type: 'button', text: 'Dodaj konto', onclick: () => openEditor() }),
            el('button', { class: 'btn', type: 'button', text: 'Import z Excela', onclick: doImport })))));
    return;
  }
  const cb = (label, fn) => el('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick: fn });
  const copyBtn = (label, text, secret) => { const b = cb('Kopiuj ' + label, () => copy(text, label, secret, e.email)); b.append(icon('copy')); return b; };
  // Pokazanie hasła: wpis w dzienniku i automatyczne ukrycie po czasie z ustawień
  const showing = (on, what) => { if (on){ logEv('Wyświetlono hasło', `${e.email} – ${what}`); armReveal(); } };
  const row = (label, ...kids) => el('div', { class: 'g-row' }, el('span', { class: 'lbl', text: label }), ...kids);
  const pwRow = (label, pw, shown, toggle, copyLabel) => {
    const eye = cb(shown ? 'Ukryj hasło' : 'Pokaż hasło', toggle); eye.append(icon(shown ? 'eyeOff' : 'eye'));
    return row(label, el('span', { class: 'val pw' + (shown ? ' selectable' : ''), text: shown ? pw : '•'.repeat(12) }), eye, copyBtn(copyLabel, pw, true));
  };

  const access = el('div', { class: 'group' },
    row('Adres e-mail', el('span', { class: 'val selectable', text: e.email }), copyBtn('adres e-mail', e.email)),
    e.password
      ? pwRow('Hasło', e.password, reveal, () => { reveal = !reveal; showing(reveal, 'hasło'); renderDetail(); }, 'hasło')
      : row('Hasło', el('span', { class: 'val none', text: 'brak hasła' }),
          el('button', { class: 'btn small', type: 'button', text: 'Ustaw', onclick: () => openEditor(e, '#fPass') })),
    ...e.altPasswords.map((a, i) => { const k = e.id + ':' + i;
      return pwRow(a.label || `Hasło ${i + 2}`, a.password, revealAlt.has(k), () => { revealAlt.has(k) ? revealAlt.delete(k) : revealAlt.add(k); showing(revealAlt.has(k), a.label || `hasło ${i + 2}`); renderDetail(); }, a.label ? `hasło „${a.label}”` : `hasło ${i + 2}`); }));

  // Dostępy do innych aplikacji i stron
  const appsGroup = el('div', { class: 'group apps' },
    e.apps.length ? e.apps.map((a, i) => { const k = e.id + ':app:' + a.id, url = safeUrl(a.url);
      const open = url ? el('button', { class: 'btn small', type: 'button', text: 'Otwórz', title: url, onclick: () => { api.openUrl(url); logEv('Otwarto stronę aplikacji', `${e.email} – ${a.name}`); } }) : null;
      return el('div', { class: 'app-blk' },
        el('div', { class: 'g-row app-h' }, el('span', { class: 'app-ic', style: `background:${appColor(a.name)}`, text: a.name.slice(0, 1).toUpperCase() }),
          el('div', { class: 'fill' }, el('b', { text: a.name }), url ? el('small', { class: 'selectable', text: url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') }) : null),
          open, el('button', { class: 'btn small', type: 'button', text: 'Edytuj', onclick: () => openEditor(e, `.app-row[data-app="${CSS.escape(a.id)}"] .ap-login`) })),
        a.login ? row('Login', el('span', { class: 'val selectable', text: a.login }), copyBtn(`login (${a.name})`, a.login)) : null,
        a.password ? pwRow('Hasło', a.password, revealAlt.has(k), () => { revealAlt.has(k) ? revealAlt.delete(k) : revealAlt.add(k); showing(revealAlt.has(k), a.name); renderDetail(); }, `hasło (${a.name})`)
          : row('Hasło', el('span', { class: 'val none', text: 'brak hasła' }), el('button', { class: 'btn small', type: 'button', text: 'Wygeneruj', onclick: () => newAppPassword(e, a) })),
        a.note ? row('Uwagi', el('span', { class: 'val notes selectable', text: a.note })) : null);
    }) : [],
    el('div', { class: 'g-row app-add' }, el('span', { class: 'lbl', text: e.apps.length ? 'Dodaj' : 'Brak dostępów' }),
      el('div', { class: 'chips' }, quickApps(n => hasApp(e, n), 8).map(n => el('button', { class: 'chip', type: 'button', text: '+ ' + n, onclick: () => openEditor(e, null, n) })),
        el('button', { class: 'chip', type: 'button', text: '+ Inna…', onclick: () => openEditor(e, null, '') }))));
  const lics = licList(e);
  const licGroup = el('div', { class: 'group' }, row(lics.length > 1 ? 'Licencje' : 'Licencja',
    el('div', { class: 'val lic-list' }, lics.map(l => el('div', null, el('span', { class: 'dot', style: `background:${licColor(l)}` }), l)))));

  const info = FIELDS.filter(f => e[f.k]).map(f => [f.label, e[f.k], /phone|mobile/i.test(f.k)]);
  const infoGroup = (info.length || e.extra.length) ? el('div', { class: 'group' },
    info.map(([l, v, c]) => row(l, el('span', { class: 'val selectable', text: v }), c ? copyBtn(l.toLowerCase(), v) : null)),
    e.extra.map((x, i) => { const l = x.label || 'Pole';
      if (!isSecretLabel(l)) return row(l, el('span', { class: 'val selectable', text: x.value }), copyBtn(l.toLowerCase(), x.value));
      const k = e.id + ':x:' + i;
      return pwRow(l, x.value, revealAlt.has(k), () => { revealAlt.has(k) ? revealAlt.delete(k) : revealAlt.add(k); showing(revealAlt.has(k), l); renderDetail(); }, `„${l}”`); })) : null;
  const notesGroup = e.notes ? el('div', { class: 'group' }, row('Uwagi', el('span', { class: 'val notes selectable', text: e.notes }))) : null;
  const groups = { access, apps: appsGroup, lics: licGroup, info: infoGroup, notes: notesGroup };
  const shown = cfg.sections.filter(k => groups[k]);
  const section = k => {
    const meta = SECTIONS.find(x => x.k === k), pos = shown.indexOf(k);
    const mv = (d, label, sym) => el('button', { class: 'sec-mv', type: 'button', title: label, 'aria-label': `${label}: ${meta.label}`, text: sym,
      disabled: (d < 0 ? pos === 0 : pos === shown.length - 1) ? '' : null, onclick: () => moveSection(k, d < 0 ? -1 : 1) });
    const head = el('div', { class: 'sec-h', draggable: 'true', title: 'Przeciągnij, aby zmienić kolejność' },
      el('span', { class: 'grip', 'aria-hidden': 'true', text: '⋮⋮' }), el('span', { class: 'sec-t', text: meta.label }),
      mv(-1, 'Przesuń wyżej', '↑'), mv(1, 'Przesuń niżej', '↓'));
    const sec = el('section', { class: 'dsec', 'data-sec': k }, head, groups[k]);
    head.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/x-sec', k); ev.dataTransfer.effectAllowed = 'move'; sec.classList.add('dragging'); });
    head.addEventListener('dragend', () => { sec.classList.remove('dragging'); document.querySelectorAll('.dsec').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
    const where = ev => { const r = sec.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2 ? 'before' : 'after'; };
    sec.addEventListener('dragover', ev => {
      if (!ev.dataTransfer.types.includes('text/x-sec')) return;
      ev.preventDefault(); const w = where(ev);
      sec.classList.toggle('drop-before', w === 'before'); sec.classList.toggle('drop-after', w === 'after');
    });
    sec.addEventListener('dragleave', () => sec.classList.remove('drop-before', 'drop-after'));
    sec.addEventListener('drop', ev => {
      const from = ev.dataTransfer.getData('text/x-sec'); if (!from) return;
      ev.preventDefault(); const w = where(ev);
      if (from === k) return;
      const o = cfg.sections.filter(x => x !== from); o.splice(o.indexOf(k) + (w === 'after' ? 1 : 0), 0, from); setSections(o);
    });
    return sec;
  };

  box.append(...[
    el('div', { class: 'd-head' }, avatar(e, true), el('div', null,
      el('h2', { class: 'selectable', text: fullName(e) }),
      el('p', { text: [e.jobTitle, e.department].filter(Boolean).join(' · ') || (e.displayName && e.displayName !== fullName(e) ? e.displayName : lics.join(', ')) }))),
    pwStale(e) ? el('div', { class: 'pw-warn' },
      el('span', { text: `Hasło zmieniono w Microsoft 365 ${fmtDate(e.msPwChanged)}, a w skarbcu zapisano je ${fmtDate(e.pwSet || e.created)}. Hasło w skarbcu może być nieaktualne.` }),
      el('div', { class: 'row-btns' },
        el('button', { class: 'btn small', type: 'button', text: 'Wpisz aktualne hasło', onclick: () => openEditor(e, '#fPass') }),
        el('button', { class: 'btn small', type: 'button', text: 'Hasło jest aktualne', onclick: async () => {
          e.pwSet = new Date(Math.max(Date.now(), Date.parse(e.msPwChanged) + 1000 || 0)).toISOString(); pwSnap.set(e.id, e.password); msStaleSeen = Math.max(0, msStaleSeen - 1); await persist(); render(); toast('Oznaczono hasło jako aktualne'); } }))) : null,
    healthBlock(e),
    e.msState === 'gone' ? el('p', { class: 'd-warn', text: 'Tego konta nie ma już w Microsoft 365 (usunięte albo z zablokowanym logowaniem). Dane w skarbcu zostały zachowane.' }) : null,
    ...shown.map(section),
    !infoGroup ? el('p', { class: 'd-hint' }, 'Brak dodatkowych danych. ', el('button', { class: 'link', type: 'button', text: 'Uzupełnij dane', onclick: () => openEditor(e, '#fDept') })) : null,
    el('p', { class: 'd-meta', text: (e.msId ? 'Synchronizowane z Microsoft 365 · ' : '') + `Dodano ${fmtDate(e.created)}` + (e.updated && e.updated !== e.created ? `, zmieniono ${fmtDate(e.updated)}` : '') }),
    el('div', { class: 'd-actions' },
      el('button', { class: 'btn', type: 'button', text: 'Edytuj', onclick: () => openEditor(e) }),
      el('button', { class: 'btn', type: 'button', text: e.password ? 'Nowe hasło' : 'Wygeneruj hasło', title: 'Wygeneruj i zapisz nowe hasło', onclick: () => newPassword(e) }),
      smsButton(e),
      el('button', { class: 'btn', type: 'button', text: 'Karta dostępu…', title: 'Karta z loginem i hasłem do wydruku lub PDF', onclick: () => openCard([e]) }),
      el('button', { class: 'btn', type: 'button', text: 'Usuń konto', style: 'color:var(--danger)', onclick: () => removeEntry(e) }))
  ].filter(Boolean));
}

$('#search').addEventListener('input', e => {
  query = e.target.value;
  const list = visible();
  // Przy wyszukiwaniu od razu pokazuj pierwsze pasujące konto
  if (query.trim() && list.length && !multi() && !checking && !list.some(x => x.id === sel)) setSel(list[0].id);
  if (fltOpen) renderFilters();
  renderList(); renderDetail();
});
$('#search').addEventListener('keydown', e => {
  const list = visible();
  if (e.key === 'Enter' || e.key === 'ArrowDown'){
    e.preventDefault(); if (!list.length) return;
    if (!list.some(x => x.id === sel) || e.key === 'Enter') select((list.find(x => x.id === sel) || list[0]).id);
    $('#list').focus();
  } else if (e.key === 'Escape'){
    e.preventDefault();
    if (query){ e.target.value = ''; query = ''; renderList(); renderDetail(); } else $('#list').focus();
  }
});
$('#addBtn').addEventListener('click', () => openEditor());
$('#lockNow').addEventListener('click', () => showLock('ręcznie'));
$('#list').addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Delete', 'Backspace', 'Escape'].includes(e.key)) return;
  if (e.key === 'Backspace' && !(isMac && e.metaKey)) return; // ⌘⌫ usuwa na Macu
  e.preventDefault();
  const list = visible(); if (!list.length) return;
  const i = list.findIndex(x => x.id === sel);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    const n = list[e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0)];
    if (e.shiftKey) clickItem({ shiftKey: true }, n.id); else select(n.id);
  }
  else if (e.key === 'Escape'){ if (checkMode()) exitSelect(); }
  else if (e.key === 'Enter' && i >= 0 && !multi()) openEditor(list[i]);
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
});
const inTextField = () => { const a = document.activeElement; return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type)) || a.isContentEditable); };
document.addEventListener('keydown', e => {
  if ($('#app').hidden || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'n'){ e.preventDefault(); openEditor(); }
  else if (mod && e.key.toLowerCase() === 'f'){ e.preventDefault(); $('#search').focus(); }
  else if (mod && e.key.toLowerCase() === 'l'){ e.preventDefault(); showLock('ręcznie (skrót klawiszowy)'); }
  else if (mod && e.key.toLowerCase() === 'a' && !inTextField()){ e.preventDefault(); selectAll(); $('#list').focus(); }
  // Pisanie poza polem tekstowym od razu trafia do wyszukiwarki
  else if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ' && !inTextField()){ $('#search').focus(); }
  else if (!inTextField() && e.target !== $('#list') && (e.key === 'Delete' || (mod && e.key === 'Backspace'))){ e.preventDefault(); deleteSelection(); }
});

// Polecenia z menu aplikacji (macOS)
if (api.onMenu) api.onMenu(cmd => {
  if (cmd === 'lock'){ if (key) showLock('menu, uśpienie komputera lub blokada ekranu'); return; }
  if (cmd === 'selectAll' && (inTextField() || $('#app').hidden || document.querySelector('dialog[open]'))){ document.execCommand('selectAll'); return; }
  if ($('#app').hidden || document.querySelector('dialog[open]')) return;
  if (cmd === 'selectAll'){ selectAll(); $('#list').focus(); return; }
  if (cmd === 'delete'){ if (!inTextField()) deleteSelection(); return; }
  if (cmd === 'new') openEditor();
  else if (cmd === 'search'){ $('#search').focus(); $('#search').select(); }
  else if (cmd === 'import') $('#importBtn').click();
  else if (cmd === 'export') $('#exportBtn').click();
  else if (cmd === 'settings') $('#settingsBtn').click();
  else if (cmd === 'health'){ if (!document.querySelector('dialog[open]')) openHealth(); }
  else if (cmd === 'log'){ if (!document.querySelector('dialog[open]')) openLog(); }
});

/* ---------- edytor ---------- */
const FIELD_IDS = { displayName: '#fDisp', department: '#fDept', jobTitle: '#fJob', office: '#fOffice', phone: '#fPhone', mobile: '#fMobile' };
const allLicenses = () => [...new Set([...LICENSES, ...entries.flatMap(licList)])].filter(l => l !== NO_LICENSE).sort((a, b) => a.localeCompare(b, 'pl'));
function fillDatalist(id, values){ $(id).replaceChildren(...[...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pl')).map(v => el('option', { value: v }))); }

function pwInput(cls, value, label){ return el('input', { class: 'field mono ' + cls, type: 'password', spellcheck: 'false', value, 'aria-label': label }); }
function altRow(a = { label: '', password: '' }){
  const pw = pwInput('alt-pw', a.password, 'Kolejne hasło');
  const show = el('button', { class: 'btn', type: 'button', text: 'Pokaż', onclick: () => { const h = pw.type === 'password'; pw.type = h ? 'text' : 'password'; show.textContent = h ? 'Ukryj' : 'Pokaż'; } });
  return el('div', { class: 'xrow alt' },
    el('input', { class: 'field alt-label', placeholder: 'Opis, np. stare hasło, PIN, konto VPN', value: a.label, 'aria-label': 'Opis hasła' }),
    pw, show,
    el('button', { class: 'btn', type: 'button', text: 'Generuj', onclick: () => { pw.value = genPassword(16); pw.type = 'text'; show.textContent = 'Ukryj'; } }),
    el('button', { class: 'icon-btn rm', type: 'button', title: 'Usuń to hasło', 'aria-label': 'Usuń to hasło', text: '×', onclick: ev => ev.currentTarget.closest('.xrow').remove() }));
}
function extraRow(x = { label: '', value: '' }){
  return el('div', { class: 'xrow extra' },
    el('input', { class: 'field ex-label', placeholder: 'Nazwa pola, np. Numer karty', value: x.label, list: 'dlExtra', 'aria-label': 'Nazwa pola' }),
    el('input', { class: 'field ex-value', placeholder: 'Wartość', value: x.value, 'aria-label': 'Wartość pola' }),
    el('button', { class: 'icon-btn rm', type: 'button', title: 'Usuń pole', 'aria-label': 'Usuń pole', text: '×', onclick: ev => ev.currentTarget.closest('.xrow').remove() }));
}
// Dostęp do aplikacji/strony w edytorze konta
function appRow(a = {}){
  const id = a.id || crypto.randomUUID();
  const name = el('input', { class: 'field ap-name', placeholder: 'Aplikacja lub strona, np. Facebook', value: a.name || '', list: 'dlApps', 'aria-label': 'Aplikacja lub strona' });
  const url = el('input', { class: 'field ap-url', placeholder: 'Adres strony, np. panel.firma.pl', value: a.url || '', spellcheck: 'false', 'aria-label': 'Adres strony' });
  const login = el('input', { class: 'field ap-login', placeholder: 'Login lub e-mail', value: a.login != null ? a.login : $('#fEmail').value.trim(), spellcheck: 'false', 'aria-label': 'Login' });
  const pw = pwInput('ap-pw', a.password || '', 'Hasło do aplikacji');
  const show = el('button', { class: 'btn', type: 'button', text: 'Pokaż', onclick: () => { const h = pw.type === 'password'; pw.type = h ? 'text' : 'password'; show.textContent = h ? 'Ukryj' : 'Pokaż'; } });
  const dot = el('span', { class: 'app-ic sm', style: `background:${appColor(a.name)}`, text: (a.name || '?').slice(0, 1).toUpperCase() });
  name.addEventListener('input', () => {
    const p = presetOf(name.value) || [...$('#dlApps').options].find(o => appKey(o.value) === appKey(name.value));
    if (p && !url.value.trim()) url.value = appUrlFor(name.value);
    dot.style.background = appColor(name.value); dot.textContent = (name.value.trim() || '?').slice(0, 1).toUpperCase();
  });
  name.addEventListener('change', renderAppQuick);
  return el('div', { class: 'app-row', 'data-app': id, 'data-pwset': a.pwSet || '' },
    el('div', { class: 'xrow' }, dot, name, url,
      el('button', { class: 'icon-btn rm', type: 'button', title: 'Usuń ten dostęp', 'aria-label': 'Usuń ten dostęp', text: '×', onclick: ev => { ev.currentTarget.closest('.app-row').remove(); renderAppQuick(); } })),
    el('div', { class: 'xrow' }, login, pw, show,
      el('button', { class: 'btn', type: 'button', text: 'Generuj', onclick: () => { pw.value = genPassword(16); pw.type = 'text'; show.textContent = 'Ukryj'; } })),
    el('input', { class: 'field ap-note', placeholder: 'Uwagi, np. rola administratora, kody 2FA na telefonie służbowym', value: a.note || '', 'aria-label': 'Uwagi do dostępu' }));
}
function addAppRow(n){
  const r = appRow(n != null ? { name: n, url: appUrlFor(n) } : {}); $('#appList').append(r); renderAppQuick();
  const f = r.querySelector(n ? '.ap-login' : '.ap-name'); f.focus(); f.scrollIntoView({ block: 'center' });
}
function readApps(){
  return [...$('#appList').querySelectorAll('.app-row')].map(r => ({ id: r.dataset.app, pwSet: r.dataset.pwset, name: r.querySelector('.ap-name').value.trim(),
    url: r.querySelector('.ap-url').value.trim(), login: r.querySelector('.ap-login').value.trim(), password: r.querySelector('.ap-pw').value, note: r.querySelector('.ap-note').value.trim() }))
    .filter(a => a.name || a.password || a.url);
}
function renderAppQuick(){
  // bez aplikacji, które już są w edytowanym koncie
  const inForm = new Set([...$('#appList').querySelectorAll('.ap-name')].map(i => appKey(i.value)));
  $('#appQuick').replaceChildren(...quickApps(n => inForm.has(appKey(n))).map(n => el('button', { class: 'chip', type: 'button', text: '+ ' + n, onclick: () => addAppRow(n) })),
    el('button', { class: 'chip', type: 'button', text: '+ Inna…', onclick: () => addAppRow() }));
}
const allAppNames = () => [...new Set([...APP_PRESETS.map(p => p.name), ...entries.flatMap(x => x.apps.map(a => a.name))])];
$('#altAdd').addEventListener('click', () => { const r = altRow(); $('#altList').append(r); r.querySelector('input').focus(); });
$('#extraAdd').addEventListener('click', () => { const r = extraRow(); $('#extraList').append(r); r.querySelector('input').focus(); });

function openEditor(e, focusSel, addApp){
  editingId = e ? e.id : null;
  $('#editTitle').textContent = e ? 'Edytuj konto' : 'Nowe konto';
  $('#fFirst').value = e ? e.firstName : ''; $('#fLast').value = e ? e.lastName : '';
  $('#fEmail').value = e ? e.email : ''; $('#fPass').value = e ? e.password : genPassword(16);
  $('#fPass').type = e ? 'password' : 'text'; $('#fShow').textContent = e ? 'Pokaż' : 'Ukryj';
  $('#fNotes').value = e ? (e.notes || '') : '';
  Object.entries(FIELD_IDS).forEach(([k, id]) => { $(id).value = e ? (e[k] || '') : ''; });
  $('#altList').replaceChildren(...(e ? e.altPasswords : []).map(altRow));
  $('#extraList').replaceChildren(...(e ? e.extra : []).map(extraRow));
  $('#appList').replaceChildren(...(e ? e.apps : []).map(appRow));
  fillDatalist('#dlApps', allAppNames());
  const appF = !e && licFilter.startsWith(APP_PREFIX) ? licFilter.slice(APP_PREFIX.length) : addApp;
  if (appF != null) $('#appList').append(appRow(appF ? { name: appF, url: appUrlFor(appF) } : {}));
  renderAppQuick();
  // licencje
  const mine = e ? licList(e).filter(l => l !== NO_LICENSE) : (licFilter && licFilter !== NO_LICENSE && !licFilter.startsWith('\u0000') ? [licFilter] : [LICENSES[1]]);
  const known = allLicenses();
  $('#fLics').replaceChildren(...known.map(l => el('label', { class: 'check lic' },
    (c => { c.checked = mine.includes(l); return c; })(el('input', { type: 'checkbox', value: l })), el('span', { text: l }))));
  $('#fLicOther').value = mine.filter(l => !known.includes(l)).join(', ');
  fillDatalist('#dlDept', entries.map(x => x.department)); fillDatalist('#dlJob', entries.map(x => x.jobTitle));
  fillDatalist('#dlOffice', entries.map(x => x.office)); fillDatalist('#dlExtra', entries.flatMap(x => x.extra.map(y => y.label)));
  $('#editErr').textContent = '';
  $('#editor').showModal(); $('#editForm').scrollTop = 0;
  const fSel = focusSel || (addApp != null ? `#appList .app-row:last-child ${addApp ? '.ap-login' : '.ap-name'}` : '#fFirst');
  setTimeout(() => { const f = $(fSel) || $('#fFirst'); f.focus(); f.scrollIntoView({ block: 'center' }); }, 30);
}
$('#editCancel').addEventListener('click', () => $('#editor').close());
$('#fShow').addEventListener('click', () => { const p = $('#fPass'), s = p.type === 'password'; p.type = s ? 'text' : 'password'; $('#fShow').textContent = s ? 'Ukryj' : 'Pokaż'; });
$('#fGen').addEventListener('click', () => { $('#fPass').value = genPassword(16); $('#fPass').type = 'text'; $('#fShow').textContent = 'Ukryj'; });

function rnd(n){ const a = new Uint32Array(1), lim = Math.floor(2 ** 32 / n) * n; do { crypto.getRandomValues(a); } while (a[0] >= lim); return a[0] % n; }
const PW_SETS = { up: 'ABCDEFGHJKLMNPQRSTUVWXYZ', low: 'abcdefghijkmnopqrstuvwxyz', dig: '23456789', sym: '!@#$%&*?-_+=' };
function genPassword(len, opt){
  const sets = Object.keys(PW_SETS).filter(k => !opt || opt[k]).map(k => PW_SETS[k]);
  if (!sets.length) sets.push(PW_SETS.low, PW_SETS.dig);
  const all = sets.join(''), out = sets.map(s => s[rnd(s.length)]);
  while (out.length < len) out.push(all[rnd(all.length)]);
  for (let i = out.length - 1; i > 0; i--){ const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

$('#editForm').addEventListener('submit', async ev => {
  ev.preventDefault(); revealAlt.clear();
  const err = $('#editErr');
  const lics = [...$('#fLics').querySelectorAll('input:checked')].map(c => c.value).concat($('#fLicOther').value.split(','));
  const d = { firstName: $('#fFirst').value.trim(), lastName: $('#fLast').value.trim(), email: $('#fEmail').value.trim(),
    password: $('#fPass').value, license: licJoin(lics), notes: $('#fNotes').value.trim(),
    altPasswords: [...$('#altList').querySelectorAll('.xrow')].map(r => ({ label: r.querySelector('.alt-label').value.trim(), password: r.querySelector('.alt-pw').value })).filter(a => a.password),
    extra: [...$('#extraList').querySelectorAll('.xrow')].map(r => ({ label: r.querySelector('.ex-label').value.trim(), value: r.querySelector('.ex-value').value.trim() })).filter(x => x.value),
    apps: readApps() };
  const badApp = d.apps.find(a => !a.name);
  if (badApp){ err.textContent = 'Wpisz nazwę aplikacji lub strony przy każdym dostępie.'; return; }
  const badUrl = d.apps.find(a => a.url && !safeUrl(a.url));
  if (badUrl){ err.textContent = `Nieprawidłowy adres strony przy „${badUrl.name}”.`; return; }
  d.apps.forEach(a => { if (a.url) a.url = safeUrl(a.url); });
  Object.entries(FIELD_IDS).forEach(([k, id]) => { d[k] = $(id).value.trim(); });
  if (!d.firstName && !d.lastName && !d.displayName){ err.textContent = 'Uzupełnij imię i nazwisko albo nazwę wyświetlaną.'; return; }
  if (!EMAIL_RE.test(d.email)){ err.textContent = 'Wpisz poprawny adres e-mail.'; return; }
  const dup = entries.find(x => x.email.toLowerCase() === d.email.toLowerCase() && x.id !== editingId);
  if (dup){ err.textContent = `Adres ${d.email} jest już w skarbcu (${fullName(dup)}).`; return; }
  const now = new Date().toISOString();
  const before = editingId ? (entries.find(x => x.id === editingId) || { apps: [] }).apps.map(a => a.name) : [];
  const after = d.apps.map(a => a.name), gone = before.filter(n => !after.includes(n)), added = after.filter(n => !before.includes(n));
  if (editingId){ const i = entries.findIndex(x => x.id === editingId); entries[i] = normEntry({ ...entries[i], ...d, updated: now }); setSel(editingId); }
  else { const id = crypto.randomUUID(); entries.push(normEntry({ id, ...d, created: now, updated: now })); setSel(id); if (licFilter && !inFilter(entries[entries.length - 1])) licFilter = ''; }
  logEv(editingId ? 'Zmieniono konto' : 'Dodano konto', d.email);
  if (added.length) logEv('Dodano dostęp do aplikacji', `${d.email} – ${added.join(', ')}`);
  if (gone.length) logEv('Usunięto dostęp do aplikacji', `${d.email} – ${gone.join(', ')}`);
  await persist(); $('#editor').close(); render();
  toast(editingId ? 'Zapisano zmiany' : 'Dodano konto');
});

async function newPassword(e){
  if (e.msId && e.msState !== 'gone' && msReady()) return openPwChange([e]);
  if (!(await askConfirm('Wygenerować nowe hasło?', e.password ? `Obecne hasło konta ${e.email} zostanie zapisane jako „Poprzednie hasło”. Pamiętaj, aby ustawić nowe też w Microsoft 365.` : `Konto ${e.email} dostanie nowe hasło. Pamiętaj, aby ustawić je też w Microsoft 365.`, 'Wygeneruj'))) return;
  if (e.password){
    // Poprzednie hasło zostaje jako hasło alternatywne (do wglądu lub przywrócenia)
    e.altPasswords = e.altPasswords.filter(a => a.label !== 'Poprzednie hasło');
    e.altPasswords.unshift({ label: 'Poprzednie hasło', password: e.password });
  }
  e.password = genPassword(16); e.updated = new Date().toISOString();
  revealAlt.clear();
  logEv('Nowe hasło (tylko w skarbcu)', e.email);
  await persist(); reveal = true; renderDetail(); armReveal();
  copy(e.password, 'nowe hasło', true);
}

async function newAppPassword(e, a){
  if (!(await askConfirm(`Nowe hasło: ${a.name}?`, (a.password ? `Obecne hasło do „${a.name}” (${a.login || e.email}) zostanie zachowane jako „Poprzednie hasło (${a.name})”. ` : '') + `Pamiętaj, aby ustawić nowe hasło także w samej aplikacji „${a.name}”.`, 'Wygeneruj'))) return;
  if (a.password){
    e.altPasswords = e.altPasswords.filter(x => x.label !== `Poprzednie hasło (${a.name})`);
    e.altPasswords.push({ label: `Poprzednie hasło (${a.name})`, password: a.password });
  }
  a.password = genPassword(16); e.updated = new Date().toISOString();
  logEv('Nowe hasło do aplikacji', `${e.email} – ${a.name}`);
  await persist(); revealAlt.add(e.id + ':app:' + a.id); render(); armReveal();
  copy(a.password, `nowe hasło (${a.name})`, true);
}

/* ---------- dostęp do aplikacji dla wielu kont ---------- */
let abList = [];
function abSkipInfo(){
  const n = $('#abName').value.trim(), have = n ? abList.filter(e => hasApp(e, n)).length : 0;
  $('#abSkip').textContent = have ? `Konta, które mają już dostęp „${n}”: ${have} – zostaną pominięte.` : '';
  $('#abGo').textContent = `Dodaj (${abList.length - have})`;
}
function openAppBulk(list){
  abList = list.slice();
  $('#abTitle').textContent = `Dodaj dostęp do aplikacji: ${kont(list.length)}`;
  $('#abWho').textContent = list.slice(0, 6).map(fullName).join(', ') + (list.length > 6 ? ` i ${list.length - 6} więcej` : '');
  $('#abName').value = ''; $('#abUrl').value = ''; $('#abUrl').dataset.touched = ''; $('#abErr').textContent = '';
  fillDatalist('#dlApps', allAppNames()); abSkipInfo();
  $('#appBulkDlg').showModal(); setTimeout(() => $('#abName').focus(), 30);
}
$('#abName').addEventListener('input', () => { if (!$('#abUrl').dataset.touched) $('#abUrl').value = appUrlFor($('#abName').value); abSkipInfo(); });
$('#abUrl').addEventListener('input', () => { $('#abUrl').dataset.touched = $('#abUrl').value ? '1' : ''; });
$('#abCancel').addEventListener('click', () => $('#appBulkDlg').close());
$('#appBulkForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = $('#abName').value.trim(), url = $('#abUrl').value.trim(), err = $('#abErr');
  if (!name){ err.textContent = 'Wpisz nazwę aplikacji lub strony.'; $('#abName').focus(); return; }
  if (url && !safeUrl(url)){ err.textContent = 'Nieprawidłowy adres strony.'; $('#abUrl').focus(); return; }
  const lm = document.querySelector('input[name=abLogin]:checked').value, gen = document.querySelector('input[name=abPw]:checked').value === 'gen';
  const nm = (presetOf(name) || {}).name || allAppNames().find(x => appKey(x) === appKey(name)) || name;
  const now = new Date().toISOString(), done = [];
  abList.forEach(x => { const e = entries.find(y => y.id === x.id); if (!e || hasApp(e, nm)) return;
    e.apps.push({ id: crypto.randomUUID(), name: nm, url: safeUrl(url), login: lm === 'email' ? e.email : lm === 'local' ? e.email.split('@')[0] : '', password: gen ? genPassword(16) : '', note: '', pwSet: gen ? now : '' });
    e.updated = now; done.push(e); });
  $('#appBulkDlg').close();
  if (!done.length){ toast('Wszystkie zaznaczone konta mają już ten dostęp'); return; }
  logEv('Dodano dostęp do aplikacji', `${nm} → ${done.map(e => e.email).join(', ')}`);
  await persist(); render();
  toast(`Dodano dostęp „${nm}”: ${kont(done.length)}` + (gen ? '. Ustaw te hasła także w samej aplikacji.' : ''), gen ? { action: { label: 'Eksportuj listę', fn: () => exportRows(done, false) } } : {});
});

/* ---------- hasło SMS-em ---------- */
const deacc = str => Array.from(String(str), c => c === 'ł' ? 'l' : c === 'Ł' ? 'L' : (c.normalize('NFD')[0] || c)).join('');
const pwOptions = e => [...(e.password ? [{ label: 'Hasło', password: e.password }] : []),
  ...e.altPasswords.map((a, i) => ({ label: a.label || `Hasło ${i + 2}`, password: a.password })),
  ...e.apps.filter(a => a.password).map(a => ({ label: `${a.name} – hasło`, password: a.password, app: a.name, login: a.login || e.email }))];
const APP_SMS_TPL = 'Dzień dobry {imię}. {aplikacja} – login: {login}, hasło: {hasło}';
const fmtNum = n => { const m = String(n).match(/^\+48(\d{3})(\d{3})(\d{3})$/); return m ? `+48 ${m[1]} ${m[2]} ${m[3]}` : n; };
function normNumber(n){
  let x = String(n || '').replace(/[\s\-().\/]/g, '');
  if (x.startsWith('00')) x = '+' + x.slice(2);
  if (/^\d{9}$/.test(x)) x = '+48' + x; else if (/^48\d{9}$/.test(x)) x = '+' + x;
  return /^\+\d{8,15}$/.test(x) ? x : '';
}
// Treść SMS: pola z konta podstawione; hasło wstawiane osobno (nie jest zmieniane przez „bez polskich znaków”)
function smsMessage(tpl, e, pw, masked){
  const vals = { 'imię': e.firstName, imie: e.firstName, nazwisko: e.lastName, email: e.email, opis: pw ? pw.label : '',
    login: (pw && pw.login) || e.email, aplikacja: (pw && pw.app) || 'Microsoft 365' };
  let t = tpl.replace(/\{(imię|imie|nazwisko|email|opis|login|aplikacja)\}/gi, (_m, k) => vals[k.toLowerCase()] || '');
  if (cfg.sms.ascii) t = deacc(t);
  return t.replace(/\{(hasło|haslo)\}/gi, () => pw ? (masked ? '•'.repeat(pw.password.length) : pw.password) : '');
}
function smsParts(t){
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåÄÖÑÜ§äöñüà€]*$/.test(t), one = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  return { n: t.length <= one ? 1 : Math.ceil(t.length / multi), len: t.length, gsm };
}
function smsButton(e){
  if (!pwOptions(e).length) return null;
  const ready = smsReady();
  return el('button', { class: 'btn' + (ready ? '' : ' off'), type: 'button', text: 'Wyślij hasło SMS…',
    title: ready ? 'Wyślij hasło na telefon użytkownika' : 'Najpierw podłącz numer firmowy w „Kopia i ustawienia”',
    onclick: () => ready ? openSms(e) : askConfirm('Podłącz numer firmowy', 'Aby wysyłać hasła SMS-em, połącz program ze swoim numerem firmowym (iPhone lub bramka SMSAPI) w „Kopia i ustawienia”.', 'Podłącz teraz')
      .then(ok => { if (ok){ openSettings(); openSmsSetup(); } }) });
}
let smsEntry = null;
function smsPreview(){
  const e = smsEntry; if (!e) return;
  const pw = pwOptions(e)[+$('#smsPw').value || 0];
  const masked = smsMessage($('#smsText').value, e, pw, true), real = smsParts(smsMessage($('#smsText').value, e, pw, false));
  $('#smsPrev').textContent = '';
  $('#smsPrev').append(el('span', { text: masked }), el('small', { text: `${real.len} znaków · ${real.n} ${plural(real.n, 'SMS', 'SMS-y', 'SMS-ów')}` + (real.gsm ? '' : ' (polskie znaki — 70 na SMS)') }));
}
function openSms(e){
  smsEntry = e;
  const opts = pwOptions(e);
  $('#smsPw').replaceChildren(...opts.map((o, i) => el('option', { value: String(i), text: o.label })));
  $('#smsPwWrap').hidden = opts.length < 2;
  $('#smsTo').value = fmtNum(normNumber(e.mobile) || normNumber(e.phone) || e.mobile || e.phone || '');
  $('#smsText').value = cfg.sms.template;
  $('#smsFrom').textContent = `${fullName(e)} · z numeru ${fmtNum(cfg.sms.number)} (${cfg.sms.provider === 'messages' ? 'iPhone' : 'SMSAPI'})`;
  $('#smsSendErr').textContent = ''; $('#smsManual').hidden = true; $('#smsGo').disabled = false; smsPreview();
  $('#smsDlg').showModal(); setTimeout(() => ($('#smsTo').value ? $('#smsGo') : $('#smsTo')).focus(), 30);
}
$('#smsText').addEventListener('input', smsPreview);
$('#smsPw').addEventListener('change', () => {
  // Hasło aplikacji: treść z nazwą aplikacji i loginem (o ile treść nie była zmieniana ręcznie)
  const pw = pwOptions(smsEntry)[+$('#smsPw').value || 0], t = $('#smsText').value;
  if (t === cfg.sms.template || t === APP_SMS_TPL) $('#smsText').value = pw && pw.app ? APP_SMS_TPL : cfg.sms.template;
  smsPreview();
});
$('#smsSendCancel').addEventListener('click', () => $('#smsDlg').close());
$('#smsForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const e = smsEntry, to = normNumber($('#smsTo').value), err = $('#smsSendErr');
  if (!to){ err.textContent = 'Wpisz prawidłowy numer telefonu, np. +48 600 100 200.'; $('#smsTo').focus(); return; }
  const tpl = $('#smsText').value;
  if (!/\{(hasło|haslo)\}/i.test(tpl)){ err.textContent = 'Treść musi zawierać {hasło}.'; return; }
  const pw = pwOptions(e)[+$('#smsPw').value || 0];
  err.textContent = ''; $('#smsGo').disabled = true; $('#smsGo').textContent = 'Wysyłanie…';
  const r = await api.smsSend(cfg.sms, to, smsMessage(tpl, e, pw, false)).catch(x => ({ ok: false, error: String(x.message || x) }));
  $('#smsGo').disabled = false; $('#smsGo').textContent = 'Wyślij SMS';
  if (!r || !r.ok){ err.textContent = (r && r.error) || 'Nie udało się wysłać SMS.'; $('#smsManual').hidden = !(r && r.manual) || cfg.sms.provider !== 'messages'; return; }
  $('#smsDlg').close();
  logEv('Wysłano hasło SMS-em', `${e.email} → ${String(r.to || to).replace(/\d(?=\d{3})/g, '•')}`);
  smsRemember(e, to);
  toast(`Wysłano SMS z hasłem na ${fmtNum(r.to || to)}`);
});
async function smsRemember(e, to){
  // Zapamiętaj numer, jeśli konto go nie miało
  const cur = entries.find(x => x.id === e.id);
  if (cur && !normNumber(cur.mobile) && !normNumber(cur.phone)){ cur.mobile = fmtNum(to); cur.updated = new Date().toISOString(); await persist(); renderDetail(); }
}
// Wysyłka ręczna: treść do schowka + Wiadomości z odbiorcą
$('#smsManualGo').addEventListener('click', async () => {
  const e = smsEntry, to = normNumber($('#smsTo').value), err = $('#smsSendErr');
  if (!to){ err.textContent = 'Wpisz prawidłowy numer telefonu.'; return; }
  const pw = pwOptions(e)[+$('#smsPw').value || 0];
  await api.copy(smsMessage($('#smsText').value, e, pw, false), 60000);
  const r = await api.smsCompose(to).catch(x => ({ ok: false, error: String(x.message || x) }));
  if (!r || !r.ok){ err.textContent = (r && r.error) || 'Nie udało się otworzyć Wiadomości.'; return; }
  $('#smsDlg').close(); smsRemember(e, to);
  toast('Treść SMS w schowku (60 s). W Wiadomościach wklej ⌘V i naciśnij Enter.');
});

/* ---------- Microsoft 365: synchronizacja (tylko pobieranie) ---------- */
const MS_GONE = '\u0000ms-gone', PW_STALE = '\u0000pw-stale', NAMED = '\u0000named';
const MS_EVERY = 15 * 60 * 1000;
const MS_SYNC_FIELDS = ['firstName', 'lastName', 'displayName', 'department', 'jobTitle', 'phone', 'mobile', 'office'];
let msTimer = null, msBusy = false, msGen = 0, msStaleSeen = 0;
const msReady = () => !!(cfg.ms.connected && cfg.ms.refreshToken);
function msStop(){ clearInterval(msTimer); msTimer = null; msGen++; msBusy = false; }
function msStart(){
  msStop(); msStaleSeen = entries.filter(pwStale).length; renderMsSide();
  if (msReady() && cfg.ms.auto){ msSync({ quiet: true }); msTimer = setInterval(() => msSync({ quiet: true }), MS_EVERY); }
}
function renderMsSide(){
  const b = $('#msSyncBtn'); b.hidden = !msReady();
  b.classList.toggle('busy', msBusy); b.classList.toggle('bad', !!cfg.ms.lastError && !msBusy);
  const t = cfg.ms.lastSync ? new Date(cfg.ms.lastSync).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '';
  $('#msSyncTxt').textContent = msBusy ? 'Synchronizacja…' : cfg.ms.lastError ? 'Microsoft 365: błąd' : `Microsoft 365${t ? ' · ' + t : ''}`;
  b.title = cfg.ms.lastError || (cfg.ms.lastSync ? `Ostatnia synchronizacja: ${fmtDate(cfg.ms.lastSync)}. Kliknij, aby pobrać teraz.` : 'Pobierz dane z Microsoft 365');
}
// Scalanie: Microsoft 365 jest źródłem danych katalogowych i licencji; hasła, uwagi i własne pola zostają nietknięte
function msApply(users){
  const now = new Date().toISOString(), sum = { added: 0, updated: 0, gone: 0, back: 0 };
  const byId = new Map(), byMail = new Map();
  entries.forEach(e => { if (e.msId) byId.set(e.msId, e); if (e.email) byMail.set(e.email.toLowerCase(), e); });
  const seen = new Set();
  users.forEach(u => {
    if (cfg.ms.skipDisabled && !u.enabled) return;
    const e = byId.get(u.msId) || byMail.get(String(u.email).toLowerCase()) || byMail.get(String(u.upn).toLowerCase());
    const lic = licJoin(u.licenses);
    if (!e){
      if (!u.email) return;
      const n = normEntry({ firstName: u.firstName, lastName: u.lastName, email: u.email, password: '', license: lic, notes: '',
        displayName: u.displayName, department: u.department, jobTitle: u.jobTitle, phone: u.phone, mobile: u.mobile, office: u.office,
        msId: u.msId, msState: '', msPwChanged: u.pwChanged || '', altPasswords: [], extra: [], created: now, updated: now });
      if (!n.firstName && !n.lastName && u.displayName){ const p = u.displayName.trim().split(/\s+/); n.firstName = p.shift() || ''; n.lastName = p.join(' '); }
      entries.push(n); seen.add(n.id); sum.added++; return;
    }
    if (seen.has(e.id)) return;
    seen.add(e.id);
    const before = JSON.stringify(e);
    if (e.msState === 'gone') sum.back++;
    e.msId = u.msId; e.msState = ''; e.msPwChanged = u.pwChanged || '';
    if (u.email) e.email = u.email;
    MS_SYNC_FIELDS.forEach(f => { if (u[f]) e[f] = u[f]; });
    e.license = lic;
    if (JSON.stringify(e) !== before){ e.updated = now; sum.updated++; }
  });
  entries.forEach(e => { if (e.msId && !seen.has(e.id) && e.msState !== 'gone'){ e.msState = 'gone'; e.updated = now; sum.gone++; } });
  return sum;
}
async function msSync(opts = {}){
  if (!msReady() || msBusy) return;
  const gen = msGen; msBusy = true; renderMsSide(); $('#msSyncNow').disabled = true;
  const r = await api.msSync(cfg.ms).catch(x => ({ ok: false, error: String(x.message || x) }));
  if (gen !== msGen) return; // skarbiec zablokowany w trakcie
  msBusy = false; $('#msSyncNow').disabled = false;
  if (r && r.refreshToken) cfg.ms.refreshToken = r.refreshToken;
  if (!r || !r.ok){
    cfg.ms.lastError = (r && r.error) || 'Nie udało się pobrać danych z Microsoft 365.';
    if (r && r.relogin){ cfg.ms.connected = false; cfg.ms.refreshToken = ''; msStop(); }
    await persist(); renderMsSide(); renderMsSettings();
    if (!opts.quiet || (r && r.relogin)) toast(cfg.ms.lastError, { bad: true });
    return;
  }
  const sum = msApply(r.users);
  if (Array.isArray(r.licUsage)) cfg.lic = r.licUsage.map(x => ({ name: x.name, used: x.used, total: x.total }));
  cfg.ms.lastSync = new Date().toISOString(); cfg.ms.lastError = '';
  if (sum.added || sum.gone) logEv('Synchronizacja Microsoft 365', `nowe: ${sum.added}, usunięte w M365: ${sum.gone}, zaktualizowane: ${sum.updated}`);
  await persist(); render(); renderMsSide(); renderMsSettings();
  const stale = entries.filter(pwStale).length, newStale = stale > msStaleSeen ? stale - msStaleSeen : 0; msStaleSeen = stale;
  const parts = [sum.added && `${sum.added} nowych`, sum.updated && `${sum.updated} zaktualizowanych`, sum.gone && `${sum.gone} usuniętych w M365`,
    newStale && `${newStale} ${plural(newStale, 'hasło', 'hasła', 'haseł')} do sprawdzenia`].filter(Boolean);
  if (parts.length || !opts.quiet) toast(parts.length ? `Microsoft 365: ${parts.join(', ')}` : 'Microsoft 365: bez zmian');
}
$('#msSyncBtn').addEventListener('click', () => msSync());

/* ustawienia: podłączenie konta administratora */
let msLoginUri = '';
function renderMsSettings(){
  if (!$('#settings').open) return;
  const on = msReady(), m = cfg.ms;
  $('#msState').textContent = on
    ? `Podłączone: ${m.account}${m.org ? ' · ' + m.org : ''}`.replace(/\.?$/, '. ') + (m.lastError ? `Błąd: ${m.lastError}` : m.lastSync ? `Ostatnia synchronizacja: ${fmtDate(m.lastSync)}.` : '')
    : (m.lastError ? m.lastError + ' ' : '') + 'Niepodłączone. Po podłączeniu lista kont będzie na bieżąco pobierana z Microsoft 365 (tylko odczyt).';
  if (on && !msWantWrite) $('#msSetup').hidden = true;
  $('#msToggle').hidden = on || !$('#msSetup').hidden; $('#msOn').hidden = !on || !$('#msSetup').hidden;
  $('#msAuto').checked = m.auto; $('#msSkipDisabled').checked = m.skipDisabled; $('#msOnErr').textContent = '';
  $('#msWriteState').textContent = m.write
    ? 'Włączona. Hasła zmieniasz w oknie „Zmień hasła” (zaznacz konta → Zmień hasła). Synchronizacja nadal tylko pobiera dane.'
    : 'Wyłączona – program tylko odczytuje dane. Po włączeniu możesz nadawać nowe hasła wybranym użytkownikom.';
  $('#msWriteBtn').textContent = m.write ? 'Wyłącz' : 'Włącz…';
}
function topDomain(){
  const c = new Map(); entries.forEach(e => { const d = (e.email.split('@')[1] || '').toLowerCase(); if (d) c.set(d, (c.get(d) || 0) + 1); });
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || '';
}
let msWantWrite = false;
function openMsSetup(write){
  msWantWrite = write === true;
  $('#msSetupInfo').hidden = msWantWrite; $('#msSetupWrite').hidden = !msWantWrite;
  $('#msLogin').textContent = msWantWrite ? 'Zaloguj się i włącz zmianę haseł' : 'Zaloguj się w Microsoft 365';
  $('#msTenant').value = cfg.ms.tenant && !/^[0-9a-f-]{36}$/i.test(cfg.ms.tenant) ? cfg.ms.tenant : topDomain();
  $('#msClient').value = cfg.ms.clientId; $('#msErr').textContent = ''; $('#msCodeBox').hidden = true;
  $('#msLogin').disabled = false; $('#msSetup').hidden = false; $('#msToggle').hidden = true;
}
$('#msToggle').addEventListener('click', () => openMsSetup(false));
$('#msWriteBtn').addEventListener('click', async () => {
  if (!cfg.ms.write){ openMsSetup(true); $('#msOn').hidden = true; return; }
  cfg.ms.write = false; api.msForgetWrite(); await persist(); renderMsSettings(); toast('Wyłączono zmianę haseł w Microsoft 365');
});
$('#msCancel').addEventListener('click', () => { api.msLoginCancel(); $('#msSetup').hidden = true; msWantWrite = false; renderMsSettings(); });
$('#msCopyCode').addEventListener('click', () => copy($('#msCode').textContent, 'kod'));
$('#msOpenAgain').addEventListener('click', () => api.msOpenLogin(msLoginUri));
$('#msLogin').addEventListener('click', async () => {
  const err = $('#msErr'), btn = $('#msLogin');
  const tenant = $('#msTenant').value.trim().replace(/^https?:\/\//, '').replace(/^.*@/, '');
  const clientId = $('#msClient').value.trim();
  if (tenant && !/^[A-Za-z0-9.-]+$/.test(tenant)){ err.textContent = 'Wpisz domenę organizacji, np. firma.pl.'; return; }
  if (clientId && !/^[0-9a-f-]{36}$/i.test(clientId)){ err.textContent = 'Identyfikator aplikacji ma postać 00000000-0000-0000-0000-000000000000.'; return; }
  err.textContent = ''; btn.disabled = true;
  const c = { tenant, clientId, write: msWantWrite };
  const st = await api.msLoginStart(c).catch(x => ({ ok: false, error: String(x.message || x) }));
  if (!st || !st.ok){ err.textContent = (st && st.error) || 'Nie udało się rozpocząć logowania.'; btn.disabled = false; return; }
  msLoginUri = st.uri; $('#msCode').textContent = st.userCode; $('#msCodeBox').hidden = false;
  api.copy(st.userCode, 0); api.msOpenLogin(st.uri);
  const r = await api.msLoginWait().catch(x => ({ ok: false, error: String(x.message || x) }));
  btn.disabled = false; $('#msCodeBox').hidden = true;
  if (!r || !r.ok){ if (!(r && r.canceled)) err.textContent = (r && r.error) || 'Nie udało się zalogować.'; return; }
  if (!key) return; // zablokowano w trakcie
  const wasOn = msReady();
  Object.assign(cfg.ms, { tenant: r.tenantId || tenant, clientId, refreshToken: r.refreshToken, account: r.account, org: r.org, connected: true, lastError: '', write: !!r.write });
  api.msForgetWrite();
  const wantedWrite = msWantWrite; msWantWrite = false;
  $('#msSetup').hidden = true;
  await persist(); renderMsSettings();
  if (wantedWrite) toast(r.write ? `Włączono zmianę haseł (${r.account})` : 'Zalogowano, ale Microsoft nie przyznał uprawnienia do zmiany haseł. Sprawdź rolę konta i zgodę administratora.', { bad: !r.write });
  else toast(`Podłączono Microsoft 365: ${r.account}`);
  if (wasOn) return;
  msStart(); if (!cfg.ms.auto) msSync();
});
$('#msSyncNow').addEventListener('click', () => msSync());
$('#msAuto').addEventListener('change', async () => { cfg.ms.auto = $('#msAuto').checked; await persist(); msStart(); });
$('#msSkipDisabled').addEventListener('change', async () => { cfg.ms.skipDisabled = $('#msSkipDisabled').checked; await persist(); });
$('#msOff').addEventListener('click', async () => {
  $('#settings').close();
  const ok = await askConfirm('Odłączyć Microsoft 365?', 'Synchronizacja zostanie wyłączona, a zapisany dostęp usunięty ze skarbca. Konta i ich dane zostaną w skarbcu.', 'Odłącz');
  if (ok){
    msStop(); cfg.ms = { ...defaultCfg().ms, tenant: cfg.ms.tenant, clientId: cfg.ms.clientId };
    entries.forEach(e => { e.msState = ''; });
    await persist(); render(); renderMsSide(); toast('Odłączono Microsoft 365');
  }
  openSettings();
});

/* ---------- potwierdzenie ---------- */
function askConfirm(title, msg, yes){
  return new Promise(resolve => {
    const d = $('#confirmDlg'); let r = false;
    $('#cTitle').textContent = title; $('#cMsg').textContent = msg; $('#cYes').textContent = yes || 'Usuń';
    $('#cYes').className = 'btn ' + (/usu/i.test(yes || 'Usuń') ? 'danger' : 'primary');
    const y = () => { r = true; d.close(); }, n = () => d.close();
    $('#cYes').addEventListener('click', y); $('#cNo').addEventListener('click', n);
    d.addEventListener('close', () => { $('#cYes').removeEventListener('click', y); $('#cNo').removeEventListener('click', n); resolve(r); }, { once: true });
    d.showModal(); $('#cNo').focus();
  });
}
async function removeEntry(e){
  if (!(await askConfirm('Usunąć konto?', `${e.firstName} ${e.lastName} (${e.email}) zostanie usunięty ze skarbca.`, 'Usuń konto'))) return;
  await removeIds([e.id], 'Usunięto konto');
}
async function removeMany(list){
  if (list.length === 1) return removeEntry(list[0]);
  const all = list.length === entries.length;
  const msg = (all ? `Ze skarbca zostaną usunięte wszystkie konta (${list.length}).` : `Ze skarbca zostanie usuniętych ${kont(list.length)}.`)
    + ' Zaraz po usunięciu możesz to jeszcze cofnąć.';
  if (!(await askConfirm(all ? 'Usunąć wszystkie konta?' : `Usunąć ${kont(list.length)}?`, msg, `Usuń ${kont(list.length)}`))) return;
  await removeIds(list.map(e => e.id), `Usunięto ${kont(list.length)}`);
}
async function removeIds(ids, msg){
  const gone = new Set(ids);
  const list = visible(), i = list.findIndex(x => gone.has(x.id));
  const removed = entries.filter(x => gone.has(x.id));
  entries = entries.filter(x => !gone.has(x.id));
  const rest = list.filter(x => !gone.has(x.id));
  const next = rest[Math.min(Math.max(i, 0), rest.length - 1)];
  checking = false; setSel(next ? next.id : null);
  logEv('Usunięto konta', `${removed.length}: ` + removed.map(x => x.email).slice(0, 30).join(', ') + (removed.length > 30 ? '…' : ''));
  await persist(); render();
  toast(msg, { action: { label: 'Cofnij', fn: async () => {
    if (!key) return;
    const have = new Set(entries.map(x => x.id));
    entries.push(...removed.filter(x => !have.has(x.id)));
    picked = new Set(removed.map(x => x.id)); sel = removed[0] ? removed[0].id : null; anchor = sel;
    logEv('Cofnięto usunięcie', kont(removed.length));
    await persist(); render(); $('#toast').classList.remove('show'); toast('Przywrócono ' + kont(removed.length));
  } } });
}
function deleteSelection(){
  const list = pickedEntries();
  if (list.length > 1) removeMany(list);
  else { const e = entries.find(x => x.id === sel); if (e) removeEntry(e); }
}

/* ---------- Excel: eksport ---------- */
$('#exportBtn').addEventListener('click', () => {
  if (!entries.length){ toast('Skarbiec jest pusty, nie ma czego eksportować.'); return; }
  exportRows(multi() ? pickedEntries() : visible(), multi());
});
async function exportRows(list, onlyPicked = true){
  const rows = list.map(({ id, ...r }) => r);
  const what = onlyPicked && multi() ? ` (zaznaczone konta)` : licFilter.startsWith(APP_PREFIX) || HEALTH[licFilter] ? ` (${filterName()})` : (licFilter === MS_GONE ? ' usunięte w Microsoft 365' : licFilter === PW_STALE ? ' z hasłem do sprawdzenia' : licFilter === NAMED ? ' (konta imienne)' : licFilter ? ` z licencją ${licFilter}` : '') + (fltOn().length ? ` (${fltSummary()})` : '');
  const ok = await askConfirm('Eksportować do Excela?',
    `Plik będzie zawierał ${kont(rows.length)}${what} z hasłami zapisanymi jawnym tekstem. Chroń go jak hasła.`, 'Eksportuj');
  if (!ok) return;
  try {
    const r = await api.excelExport(rows);
    if (r && r.ok) logEv('Eksport do Excela', `${kont(rows.length)} → ${r.filePath}`);
    if (r && r.ok) toast(`Wyeksportowano ${kont(rows.length)}`, { action: { label: 'Pokaż plik', fn: () => api.showInFolder(r.filePath) } });
  } catch (_){ toast('Nie udało się zapisać pliku. Zamknij go w Excelu i spróbuj ponownie.', { bad: true }); }
}

/* ---------- uzupełnianie danych wielu kont ---------- */
const BULK = [
  ...FIELDS.filter(f => f.k !== 'displayName').map(f => ({ v: f.k, label: f.label })),
  { v: 'licAdd', label: 'Dodaj licencję', value: 'Licencja do dodania', noEmpty: true },
  { v: 'licDel', label: 'Usuń licencję', value: 'Licencja do usunięcia', noEmpty: true },
  { v: 'notesAdd', label: 'Dopisz do uwag', value: 'Tekst do dopisania', noEmpty: true },
  { v: 'extra', label: 'Własne pole…', value: 'Wartość' }
];
let bulkList = [];
$('#bkField').append(...BULK.map(b => el('option', { value: b.v, text: b.label })));
function bulkUpdateForm(){
  const b = BULK.find(x => x.v === $('#bkField').value);
  $('#bkLabelWrap').hidden = b.v !== 'extra';
  $('#bkOnlyEmptyWrap').hidden = !!b.noEmpty;
  $('#bkValueLbl').textContent = b.value || 'Wartość';
  const vals = b.v === 'licAdd' ? allLicenses() : b.v === 'licDel' ? [...new Set(bulkList.flatMap(licList))].filter(l => l !== NO_LICENSE)
    : FIELDS.some(f => f.k === b.v) ? entries.map(e => e[b.v]) : [];
  fillDatalist('#dlBulk', vals);
}
$('#bkField').addEventListener('change', bulkUpdateForm);
function openBulk(list){
  bulkList = list;
  $('#bulkTitle').textContent = `Uzupełnij dane: ${kont(list.length)}`;
  $('#bkValue').value = ''; $('#bkLabel').value = ''; $('#bulkErr').textContent = '';
  fillDatalist('#dlExtra', entries.flatMap(x => x.extra.map(y => y.label)));
  bulkUpdateForm(); $('#bulkDlg').showModal(); setTimeout(() => $('#bkField').focus(), 30);
}
$('#bulkCancel').addEventListener('click', () => $('#bulkDlg').close());
$('#bulkForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = $('#bkField').value, v = $('#bkValue').value.trim(), label = $('#bkLabel').value.trim(), onlyEmpty = $('#bkOnlyEmpty').checked;
  if (f === 'extra' && !label){ $('#bulkErr').textContent = 'Podaj nazwę pola.'; return; }
  if (!v && BULK.find(x => x.v === f).noEmpty){ $('#bulkErr').textContent = 'Wpisz wartość.'; return; }
  const now = new Date().toISOString(); let n = 0;
  bulkList.forEach(x => {
    const e = entries.find(y => y.id === x.id); if (!e) return;
    const before = JSON.stringify(e);
    if (f === 'licAdd') e.license = licJoin([...licList(e), v]);
    else if (f === 'licDel') e.license = licJoin(licList(e).filter(l => l.toLowerCase() !== canonLic(v).toLowerCase()));
    else if (f === 'notesAdd') e.notes = e.notes ? `${e.notes}\n${v}` : v;
    else if (f === 'extra'){
      const cur = e.extra.find(y => y.label.toLowerCase() === label.toLowerCase());
      if (!cur){ if (v) e.extra.push({ label, value: v }); }
      else if (!onlyEmpty || !cur.value){ if (v) cur.value = v; else e.extra = e.extra.filter(y => y !== cur); }
    }
    else if (!onlyEmpty || !e[f]) e[f] = v;
    if (JSON.stringify(e) !== before){ e.updated = now; n++; }
  });
  $('#bulkDlg').close();
  if (n){ await persist(); render(); }
  toast(n ? `Zaktualizowano ${kont(n)}` : 'Nic nie zmieniono — pola były już wypełnione');
});

/* ---------- zmiana haseł wielu kont: generator + Microsoft 365 ---------- */
let pwRows = [], pwRunning = false, pwStop = false, pwDone = [];
const pwOpt = () => ({ up: $('#pwUp').checked, low: $('#pwLow').checked, dig: $('#pwDig').checked, sym: $('#pwSym').checked });
const pwLen = () => +$('#pwLen').value;
const pwKinds = () => Object.values(pwOpt()).filter(Boolean).length;
const msAdminAcct = e => !!cfg.ms.account && [e.email].some(x => String(x || '').toLowerCase() === cfg.ms.account.toLowerCase());
// Czy konto można zmienić w Microsoft 365; zwraca powód pominięcia albo ''
function pwSkip(e, useMs){
  if (!useMs) return '';
  if (!e.msId) return 'nie ma go w Microsoft 365 (brak powiązania)';
  if (e.msState === 'gone') return 'usunięte w Microsoft 365';
  if (msAdminAcct(e)) return 'konto administratora podłączone do Skarbca – zmień je w centrum administracyjnym';
  return '';
}
function pwSample(){ $('#pwSample').textContent = genPassword(pwLen(), pwOpt()); $('#pwLenV').textContent = pwLen(); }
function pwUseMs(){ return msReady() && cfg.ms.write && $('#pwMs').checked; }
function pwRender(){
  const useMs = pwUseMs(), ok = pwRows.filter(x => !x.skip).length;
  $('#pwForceWrap').hidden = !useMs;
  const note = $('#pwMsNote');
  note.hidden = msReady() && cfg.ms.write;
  note.replaceChildren(...(!msReady()
    ? ['Microsoft 365 nie jest podłączony – hasła zmienią się ', el('b', { text: 'tylko w Skarbcu' }), '. Ustaw je potem ręcznie w centrum administracyjnym albo podłącz konto administratora w „Kopia i ustawienia”.']
    : ['Zmiana haseł w Microsoft 365 jest wyłączona – hasła zmienią się ', el('b', { text: 'tylko w Skarbcu' }), '. ',
       el('button', { class: 'link', type: 'button', text: 'Włącz zmianę haseł…', onclick: () => { $('#pwDlg').close(); openSettings(); openMsSetup(true); $('#msOn').hidden = true; } })]));
  $('#pwMs').disabled = !(msReady() && cfg.ms.write); if ($('#pwMs').disabled) $('#pwMs').checked = false;
  pwRows.forEach(x => { x.skip = pwSkip(x.e, useMs); });
  $('#pwList').replaceChildren(...pwRows.map(x => {
    const st = x.state === 'ok' ? '✓ zmienione' : x.state === 'err' ? x.error : x.state === 'run' ? 'zmieniam…' : x.skip ? 'pominięte: ' + x.skip : '';
    return el('li', { class: 'pw-row ' + (x.state || (x.skip ? 'skip' : '')) }, el('b', { text: fullName(x.e) }), el('span', { class: 'em', text: x.e.email }),
      el('span', { class: 'st', text: st, title: st }));
  }));
  const n = pwRows.filter(x => !x.skip && x.state !== 'ok').length;
  $('#pwGo').textContent = pwRunning ? 'Zmieniam…' : pwRows.length === 1 ? 'Ustaw nowe hasło' : `Zmień hasła (${n})`;
  $('#pwGo').disabled = pwRunning || !n || pwKinds() < 3;
  $('#pwErr').textContent = pwKinds() < 3 ? 'Zaznacz co najmniej 3 rodzaje znaków (wymóg Microsoft 365).' : '';
  $('#pwCancel').textContent = pwRunning ? 'Zatrzymaj' : pwDone.length ? 'Gotowe' : 'Anuluj';
  $('#pwExport').hidden = pwRunning || !pwDone.length;
  [...$('#pwGen').querySelectorAll('input')].concat([$('#pwMs'), $('#pwForce')]).forEach(i => { if (pwRunning) i.disabled = true; });
  if (!pwRunning){ [...$('#pwGen').querySelectorAll('input'), $('#pwForce')].forEach(i => { i.disabled = false; }); $('#pwMs').disabled = !(msReady() && cfg.ms.write); }
}
function openPwChange(list){
  pwRows = list.map(e => ({ e, state: '', error: '', skip: '' })); pwDone = []; pwStop = false; pwRunning = false;
  $('#pwTitle').textContent = list.length === 1 ? `Nowe hasło: ${fullName(list[0])}` : `Zmiana haseł: ${kont(list.length)}`;
  $('#pwLead').textContent = 'Program wygeneruje nowe hasła, zapisze je w Skarbcu i – jeśli zaznaczysz – ustawi je w Microsoft 365.';
  $('#pwMs').checked = msReady() && cfg.ms.write; $('#pwForce').checked = false;
  $('#pwProg').hidden = true; pwSample(); pwRender(); $('#pwDlg').showModal();
}
['pwUp', 'pwLow', 'pwDig', 'pwSym', 'pwLen'].forEach(id => $('#' + id).addEventListener('input', () => { pwSample(); pwRender(); }));
$('#pwReroll').addEventListener('click', pwSample);
$('#pwMs').addEventListener('change', pwRender);
$('#pwDlg').addEventListener('cancel', ev => { if (pwRunning){ ev.preventDefault(); pwStop = true; } });
$('#pwCancel').addEventListener('click', () => { if (pwRunning){ pwStop = true; $('#pwCancel').disabled = true; } else $('#pwDlg').close(); });
$('#pwExport').addEventListener('click', () => exportRows(pwDone.filter(e => entries.includes(e)), false));
$('#pwForm').addEventListener('submit', async ev => {
  ev.preventDefault(); if (pwRunning) return;
  const useMs = pwUseMs(), force = useMs && $('#pwForce').checked, todo = pwRows.filter(x => !x.skip && x.state !== 'ok');
  if (!todo.length || pwKinds() < 3) return;
  const where = useMs ? 'w Skarbcu i w Microsoft 365' : 'tylko w Skarbcu (nie w Microsoft 365)';
  $('#pwDlg').close();
  const yes = await askConfirm(`Zmienić ${todo.length === 1 ? 'hasło' : 'hasła'} ${kont(todo.length)}?`,
    `Nowe hasła zostaną ustawione ${where}.` + (useMs ? ' Użytkownicy będą musieli zalogować się nowym hasłem na wszystkich urządzeniach (Outlook, telefon, Teams).' + (force ? ' Przy logowaniu zostaną poproszeni o ustawienie własnego hasła.' : '') : '') +
    ' Dotychczasowe hasła zostaną zapisane jako „Poprzednie hasło”.', 'Zmień hasła');
  $('#pwDlg').showModal();
  if (!yes) return;
  pwRunning = true; pwStop = false; $('#pwCancel').disabled = false;
  const prog = $('#pwProg'); prog.hidden = false; prog.max = todo.length; prog.value = 0;
  const k0 = key; let fatal = '';
  for (const x of todo){
    if (pwStop || key !== k0 || !entries.includes(x.e)) break;
    x.state = 'run'; pwRender();
    const pw = genPassword(pwLen(), pwOpt());
    let r = { ok: true };
    if (useMs){
      r = await api.msSetPassword(cfg.ms, x.e.msId, pw, force).catch(err => ({ ok: false, error: String(err.message || err) }));
      if (r && r.refreshToken) cfg.ms.refreshToken = r.refreshToken;
    }
    if (key !== k0) break; // skarbiec zablokowany w trakcie – hasło w M365 mogło się zmienić, ale nie zapiszemy go
    if (r && r.ok){
      const e = x.e, now = new Date().toISOString();
      if (e.password && e.password !== pw){
        e.altPasswords = e.altPasswords.filter(a => a.label !== 'Poprzednie hasło');
        e.altPasswords.unshift({ label: 'Poprzednie hasło', password: e.password });
      }
      e.password = pw; e.updated = now; if (useMs) e.msPwChanged = now;
      await persist(); // zapis po każdym koncie – nowe hasło nie zginie, nawet gdy coś przerwie operację
      x.state = 'ok'; pwDone.push(e);
    } else {
      x.state = 'err'; x.error = (r && r.error) || 'Nieznany błąd';
      if (r && r.fatal){ fatal = x.error; if (r.needWrite){ cfg.ms.write = false; await persist(); } break; }
    }
    prog.value++; resetIdle(); pwRender();
  }
  pwRows.forEach(x => { if (x.state === 'run') x.state = ''; });
  pwRunning = false; $('#pwCancel').disabled = false; prog.hidden = true;
  if (key !== k0) return;
  revealAlt.clear(); render(); pwRender();
  const bad = pwRows.filter(x => x.state === 'err').length;
  $('#pwErr').textContent = fatal || '';
  if (pwDone.length) logEv(useMs ? 'Zmiana haseł w Skarbcu i Microsoft 365' : 'Zmiana haseł (tylko w Skarbcu)', `${pwDone.length}: ` + pwDone.map(x => x.email).slice(0, 40).join(', ') + (force ? ' · wymuszona zmiana przy logowaniu' : '') + (bad ? ` · błędy: ${bad}` : ''));
  toast(`Zmieniono ${plural(pwDone.length, 'hasło', 'hasła', 'haseł')}: ${pwDone.length}` + (bad ? `, błędy: ${bad}` : '') + (pwStop ? ' (zatrzymano)' : ''), { bad: !!bad || !!fatal });
});

/* ---------- automatyczne ukrywanie pokazanych haseł ---------- */
let revealTimer = null;
function armReveal(){
  clearTimeout(revealTimer);
  const s = cfg.sec.revealSec; if (!s) return;
  revealTimer = setTimeout(() => { if (reveal || revealAlt.size){ reveal = false; revealAlt.clear(); renderDetail(); } }, s * 1000);
}
// Zminimalizowanie / ukrycie okna: blokada (opcja)
api.onHidden(() => { if (key && cfg.sec.lockHide) showLock('zminimalizowano lub ukryto okno'); });

/* ---------- ustawienia bezpieczeństwa ---------- */
const SEC_IDS = { capture: '#secCapture', lockHide: '#secLockHide', lockMin: '#secLockMin', revealSec: '#secReveal', clipSec: '#secClip', maxAge: '#secAge' };
const SEC_NAMES = { capture: 'blokada zrzutów ekranu', lockHide: 'blokada po zminimalizowaniu', lockMin: 'autoblokada (min)', revealSec: 'ukrywanie hasła (s)', clipSec: 'czyszczenie schowka (s)', maxAge: 'wiek hasła (dni)' };
function renderSecSettings(){
  Object.entries(SEC_IDS).forEach(([k, id]) => { const n = $(id); if (n.type === 'checkbox') n.checked = !!cfg.sec[k]; else n.value = String(cfg.sec[k]); });
}
Object.entries(SEC_IDS).forEach(([k, id]) => $(id).addEventListener('change', async ev => {
  const n = ev.target, v = n.type === 'checkbox' ? n.checked : +n.value;
  if (k === 'capture' && !v && !(await askConfirmTop('Wyłączyć blokadę zrzutów ekranu?', 'Hasła widoczne w oknie Skarbca będzie można przechwycić zrzutem ekranu, nagraniem albo podczas udostępniania ekranu.', 'Wyłącz'))){ n.checked = true; return; }
  cfg.sec[k] = v;
  logEv('Zmieniono ustawienia bezpieczeństwa', `${SEC_NAMES[k]}: ${typeof v === 'boolean' ? (v ? 'włączone' : 'wyłączone') : v}`);
  if (k === 'capture') api.protect(v);
  if (k === 'lockMin') resetIdle();
  if (k === 'maxAge') render();
  await persist();
}));
// Potwierdzenie z poziomu otwartych ustawień (confirmDlg otwiera się nad nimi)
const askConfirmTop = (t, m, y) => askConfirm(t, m, y);
$('#secHealth').addEventListener('click', () => { $('#settings').close(); openHealth(); });
$('#secLog').addEventListener('click', () => { $('#settings').close(); openLog(); });

/* ---------- przegląd bezpieczeństwa ---------- */
function openHealth(){ renderHealth(); $('#healthDlg').showModal(); }
function renderHealth(){
  buildReuse();
  const withPw = entries.filter(e => secrets(e).length), bad = new Set(), nApp = entries.reduce((n, e) => n + e.apps.filter(a => a.password).length, 0);
  // Wynik liczony z kont, które mają hasło („Bez hasła” to brak danych w skarbcu, a nie zagrożenie)
  const rows = Object.entries(HEALTH).map(([k, h]) => { const list = entries.filter(h.test); if (k !== '\u0000h-none') list.forEach(e => bad.add(e.id)); return [k, h, list.length]; });
  const okPct = withPw.length ? Math.round(100 * (withPw.length - bad.size) / withPw.length) : 100;
  const lv = okPct >= 90 ? 'good' : okPct >= 60 ? 'mid' : 'bad';
  const strong = withPw.filter(e => secrets(e).every(x => pwLevel(x.pw, e) === 'strong')).length;
  $('#hScore').replaceChildren(
    el('div', { class: 'h-big ' + lv, text: okPct + '%' }),
    el('div', null, el('b', { text: okPct >= 90 ? 'Dobrze' : okPct >= 60 ? 'Do poprawy' : 'Wymaga uwagi' }),
      el('p', { class: 'muted small', text: `Konta bez zastrzeżeń: ${withPw.length - bad.size} z ${withPw.length}. Tylko silne hasła: ${strong}.` + (nApp ? ` Sprawdzono też hasła aplikacji i stron: ${nApp}.` : '') + (entries.length - withPw.length ? ` Konta bez hasła w skarbcu: ${entries.length - withPw.length}.` : '') +
        (cfg.leaksAt ? ` Wycieki sprawdzono ${fmtDate(cfg.leaksAt)}.` : ' Wycieków jeszcze nie sprawdzano.') })));
  $('#hRows').replaceChildren(...rows.map(([k, h, n]) => el('div', { class: 'g-row' },
    el('span', { class: 'dot', style: `background:${n ? h.color : '#30A46C'}` }), el('span', { class: 'fill', text: h.label }),
    el('b', { class: 'h-n', text: String(n) }),
    el('button', { class: 'btn small', type: 'button', text: 'Pokaż', disabled: n ? null : '', onclick: () => { $('#healthDlg').close(); licFilter = k; flt = {}; setSel(null); render(); } }))));
  $('#hLeakState').textContent = cfg.leaksAt ? `Ostatnie sprawdzenie: ${fmtDate(cfg.leaksAt)} – hasła z wycieków: ${entries.reduce((n, e) => n + secrets(e).filter(x => leakN(x.k)).length, 0)}. Zmienione od tego czasu hasła wymagają ponownego sprawdzenia.` : 'Jeszcze nie sprawdzano. Wymaga połączenia z internetem.';
  const lic = cfg.lic.filter(x => x.total || x.used);
  $('#hLicBox').hidden = !lic.length;
  $('#hLic').replaceChildren(...lic.sort((a, b) => b.total - a.total).map(x => {
    const pct = x.total ? Math.min(100, Math.round(100 * x.used / x.total)) : 100, free = x.total - x.used;
    return el('div', { class: 'lu-row' }, el('span', { class: 'lu-n', text: x.name }),
      el('div', { class: 'lu-bar' }, el('div', { class: 'lu-fill' + (pct >= 100 ? ' full' : pct >= 90 ? ' hi' : ''), style: `width:${pct}%` })),
      el('span', { class: 'lu-c', text: `${x.used} / ${x.total}` + (x.total ? (free > 0 ? ` · wolne: ${free}` : free < 0 ? ` · brakuje: ${-free}` : ' · brak wolnych') : '') }));
  }));
  if (cfg.ms.lastSync) $('#hLicNote').textContent = `Przypisane / kupione – stan z ${fmtDate(cfg.ms.lastSync)}.`;
}
$('#hClose').addEventListener('click', () => $('#healthDlg').close());
$('#hLog').addEventListener('click', () => { $('#healthDlg').close(); openLog(); });

// Have I Been Pwned – zakres k-anonimowości: tylko 5 znaków skrótu SHA-1 opuszcza komputer
async function sha1Hex(s){ return [...new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase(); }
let leakRunning = false;
$('#hLeakGo').addEventListener('click', async () => {
  if (leakRunning) return;
  const list = entries.flatMap(secrets); if (!list.length){ toast('Brak haseł do sprawdzenia'); return; }
  const btn = $('#hLeakGo'), prog = $('#hLeakProg'), st = $('#hLeakState'), k0 = key;
  leakRunning = true; btn.disabled = true; prog.hidden = false; prog.value = 0;
  try {
    const byHash = new Map();
    for (const x of list){ const h = await sha1Hex(x.pw); if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(x); }
    const prefixes = [...new Set([...byHash.keys()].map(h => h.slice(0, 5)))];
    prog.max = prefixes.length;
    const found = new Map(); let failed = 0;
    for (const p of prefixes){
      if (key !== k0) return;
      st.textContent = `Sprawdzanie… ${prog.value + 1} z ${prefixes.length}`;
      const r = await api.hibpRange(p).catch(() => ({ ok: false }));
      if (!r || !r.ok){ failed++; if (failed >= 3 && !found.size && prog.value < 3){ st.textContent = (r && r.error) || 'Brak połączenia z serwisem.'; return; } prog.value++; continue; }
      r.text.split(/\r?\n/).forEach(line => { const [suf, n] = line.trim().split(':'); if (suf && +n > 0) found.set(p + suf.toUpperCase(), +n); });
      prog.value++;
    }
    if (key !== k0) return;
    const leaks = {};
    byHash.forEach((xs, h) => xs.forEach(x => { leaks[x.k] = { h: h.slice(0, 10), n: found.get(h) || 0 }; }));
    cfg.leaks = leaks; cfg.leaksAt = new Date().toISOString();
    const nBad = list.filter(x => leaks[x.k].n > 0).length;
    logEv('Sprawdzono wycieki haseł', `${list.length} haseł, w wyciekach: ${nBad}` + (failed ? `, nieudane zapytania: ${failed}` : ''));
    await persist(); render(); renderHealth();
    toast(nBad ? `Hasła z wycieków: ${nBad}. Zmień je jak najszybciej.` : 'Żadne hasło nie występuje w znanych wyciekach', { bad: !!nBad });
  } finally { leakRunning = false; btn.disabled = false; prog.hidden = true; }
});

/* ---------- dziennik zdarzeń ---------- */
function openLog(){ $('#logQ').value = ''; renderLog(); $('#logDlg').showModal(); }
function renderLog(){
  const t = fold($('#logQ').value).split(/\s+/).filter(Boolean);
  const list = cfg.log.slice().reverse().filter(x => !t.length || (s => t.every(w => s.includes(w)))(fold(`${fmtDate(x.t)} ${x.a} ${x.d}`)));
  $('#logList').replaceChildren(...(list.length ? list.slice(0, 500).map(x => el('li', { class: 'log-row' },
    el('span', { class: 'log-t', text: fmtDate(x.t) }), el('b', { text: x.a }), el('span', { class: 'log-d', text: x.d, title: x.d })))
    : [el('li', { class: 'list-empty', text: cfg.log.length ? 'Brak pasujących zdarzeń.' : 'Dziennik jest pusty.' })]),
    ...(list.length > 500 ? [el('li', { class: 'list-empty', text: `Pokazano 500 najnowszych z ${list.length}. Pełny dziennik: eksport do Excela.` })] : []));
}
$('#logQ').addEventListener('input', renderLog);
$('#logClose').addEventListener('click', () => $('#logDlg').close());
$('#logExport').addEventListener('click', async () => {
  const r = await api.logExport(cfg.log.slice().reverse()).catch(() => null);
  if (r && r.ok){ logEv('Eksport dziennika zdarzeń', r.filePath); toast('Zapisano dziennik', { action: { label: 'Pokaż plik', fn: () => api.showInFolder(r.filePath) } }); }
});

/* ---------- karta dostępu (PDF / druk) ---------- */
let cardList = [];
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function openCard(list){
  cardList = list.slice();
  $('#cardTitle').textContent = list.length === 1 ? `Karta dostępu: ${fullName(list[0])}` : `Karty dostępu: ${kont(list.length)}`;
  const noPw = list.filter(e => !e.password).length;
  $('#cardPw').checked = true; $('#cardPw').nextElementSibling.textContent = 'Dołącz hasła' + (noPw ? ` (brak hasła Microsoft 365: ${noPw})` : '');
  const nApps = list.reduce((n, e) => n + e.apps.length, 0);
  $('#cardAppsWrap').hidden = !nApps; $('#cardApps').checked = !!nApps;
  $('#cardApps').nextElementSibling.textContent = `Dołącz dostępy do aplikacji i stron (${nApps})`;
  $('#cardDlg').showModal();
}
function cardHtml(){
  const pw = $('#cardPw').checked, apps = $('#cardApps').checked, how = $('#cardHow').checked, note = $('#cardNote').value.trim(), org = cfg.ms.org || '';
  const today = new Date().toLocaleDateString('pl-PL', { dateStyle: 'long' });
  const page = e => `<section class="card">
    <header><div class="org">${escH(org)}</div><div class="date">${escH(today)}</div></header>
    <h1>Dane dostępowe do konta Microsoft 365</h1>
    <p class="who">${escH(fullName(e))}${e.jobTitle || e.department ? `<br><span>${escH([e.jobTitle, e.department].filter(Boolean).join(' · '))}</span>` : ''}</p>
    <table>
      <tr><th>Login (adres e-mail)</th><td class="mono">${escH(e.email)}</td></tr>
      ${pw ? `<tr><th>Hasło</th><td class="mono pw">${e.password ? escH(e.password) : '<i>nie ustawiono</i>'}</td></tr>` : ''}
      ${licList(e).filter(l => l !== NO_LICENSE).length ? `<tr><th>Licencje</th><td>${escH(licList(e).filter(l => l !== NO_LICENSE).join(', '))}</td></tr>` : ''}
    </table>
    ${apps && e.apps.length ? `<h2>Inne aplikacje i strony</h2><table class="apps">
      <tr><th>Aplikacja</th><th>Login</th>${pw ? '<th>Hasło</th>' : ''}</tr>
      ${e.apps.map(a => `<tr><td><b>${escH(a.name)}</b>${a.url ? `<br><span class="url">${escH(a.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</span>` : ''}</td>
        <td class="mono sm">${escH(a.login || e.email)}</td>${pw ? `<td class="mono sm pw2">${a.password ? escH(a.password) : '<i>nie ustawiono</i>'}</td>` : ''}</tr>`).join('')}
    </table>` : ''}
    ${pw && (e.password || (apps && e.apps.some(a => a.password))) ? `<p class="hint">W haśle rozróżniane są wielkie i małe litery. Hasło nie zawiera podobnych znaków (0/O, 1/l/I).</p>` : ''}
    ${how ? `<h2>Jak się zalogować</h2><ol>
      <li>Otwórz <b>outlook.office.com</b> (poczta) albo <b>www.office.com</b> (Word, Excel, Teams, OneDrive) lub aplikację Outlook/Teams.</li>
      <li>Wpisz login (adres e-mail) i hasło z tej karty.</li>
      <li>Jeśli pojawi się prośba o ustawienie nowego hasła lub weryfikację (np. aplikacja Microsoft Authenticator), postępuj zgodnie z instrukcją na ekranie.</li>
      <li>Hasło zmienisz na stronie <b>mysignins.microsoft.com</b> → Hasło.</li></ol>` : ''}
    ${note ? `<h2>Informacje</h2><p class="note">${escH(note).replace(/\n/g, '<br>')}</p>` : ''}
    <p class="warn">Nie udostępniaj hasła nikomu – także osobom podającym się za dział IT. Po zapamiętaniu hasła zniszcz tę kartę.</p>
    <footer><div>Wydał(a): ……………………………</div><div>Odebrał(a): ……………………………</div></footer>
  </section>`;
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Karta dostępu</title><style>
    @page{size:A4;margin:18mm}*{box-sizing:border-box}body{font:11pt/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#111;margin:0}
    .card{page-break-after:always;min-height:250mm;display:flex;flex-direction:column}.card:last-child{page-break-after:auto}
    header{display:flex;justify-content:space-between;color:#555;font-size:10pt;border-bottom:1px solid #ccc;padding-bottom:6px}
    .org{font-weight:600;color:#111}h1{font-size:17pt;margin:18px 0 6px}h2{font-size:12pt;margin:18px 0 6px}
    .who{font-size:13pt;font-weight:600;margin:0 0 14px}.who span{font-size:10.5pt;font-weight:400;color:#555}
    table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:500;color:#555;width:38%;padding:9px 10px;border:1px solid #ccc;background:#f5f6f8}
    td{padding:9px 10px;border:1px solid #ccc}.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12pt}.pw{font-size:15pt;letter-spacing:.06em;font-weight:600}
    .hint{color:#555;font-size:9.5pt;margin:6px 0 0}table.apps th{width:auto}.sm{font-size:10.5pt}.pw2{font-weight:600;letter-spacing:.04em}.url{color:#555;font-size:9.5pt}ol{padding-left:20px;margin:0}li{margin:3px 0}.note{white-space:normal}
    .warn{margin-top:18px;padding:8px 10px;border:1px solid #e0b400;background:#fff8db;border-radius:4px;font-size:10pt}
    footer{margin-top:auto;display:flex;justify-content:space-between;color:#555;font-size:10pt;padding-top:30px}
  </style></head><body>${cardList.map(page).join('')}</body></html>`;
}
$('#cardCancel').addEventListener('click', () => $('#cardDlg').close());
$('#cardPdf').addEventListener('click', async () => {
  const name = cardList.length === 1 ? `Karta dostępu – ${fullName(cardList[0])}` : `Karty dostępu – ${kont(cardList.length)}`;
  const r = await api.cardPdf(cardHtml(), name).catch(() => null);
  if (r && r.ok){ $('#cardDlg').close(); logEv('Karta dostępu (PDF)', cardList.map(e => e.email).join(', ') + ($('#cardPw').checked ? ' · z hasłem' : '') + ($('#cardApps').checked && !$('#cardAppsWrap').hidden ? ' · z aplikacjami' : '') + ` → ${r.filePath}`);
    toast('Zapisano PDF. Usuń plik po przekazaniu.', { action: { label: 'Pokaż plik', fn: () => api.showInFolder(r.filePath) } }); }
});
$('#cardForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const r = await api.cardPrint(cardHtml()).catch(() => null);
  if (r && r.ok){ $('#cardDlg').close(); logEv('Karta dostępu (wydruk)', cardList.map(e => e.email).join(', ') + ($('#cardPw').checked ? ' · z hasłem' : '') + ($('#cardApps').checked && !$('#cardAppsWrap').hidden ? ' · z aplikacjami' : '')); toast('Wysłano do drukarki'); }
});

/* ---------- Excel: import ---------- */
const norm = s => String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const COLS = {
  firstName: ['imie', 'imiona', 'firstname', 'givenname'],
  lastName: ['nazwisko', 'lastname', 'surname', 'familyname'],
  fullName: ['imieinazwisko', 'nazwiskoiimie', 'uzytkownik', 'pracownik', 'osoba', 'name', 'nazwa', 'fullname'],
  displayName: ['nazwawyswietlana', 'displayname'],
  email: ['email', 'adresemail', 'mail', 'emailaddress', 'userprincipalname', 'upn', 'login', 'username', 'konto', 'nazwauzytkownika',
    'kontonazwauzytkownika', 'nazwaglownegouzytkownika', 'glownyadresemail', 'adres', 'primarysmtpaddress'],
  password: ['haslo', 'password', 'haslo1', 'password1', 'haslotymczasowe', 'temporarypassword', 'haslopoczatkowe'],
  license: ['licencja', 'licencje', 'typlicencji', 'license', 'licenses', 'przypisanelicencje', 'assignedlicenses', 'produkt', 'produkty'],
  notes: ['uwagi', 'notes', 'notatki', 'opis', 'komentarz', 'komentarze'],
  department: ['dzial', 'department', 'departament', 'wydzial', 'zespol'],
  jobTitle: ['stanowisko', 'title', 'jobtitle', 'funkcja'],
  phone: ['telefon', 'tel', 'phone', 'phonenumber', 'officephone', 'telefonsluzbowy', 'numertelefonu', 'telefonstacjonarny', 'telefonbiurowy'],
  mobile: ['telefonkomorkowy', 'komorka', 'telkom', 'telefonkom', 'nrkomorki', 'mobile', 'mobilephone', 'cellphone'],
  office: ['biuro', 'lokalizacja', 'office', 'location', 'miasto', 'city', 'siedziba', 'oddzial']
};
const SKIP_COLS = ['utworzono', 'zmieniono', 'created', 'updated', 'lp', 'nr', 'id'];
const ALT_PW_RE = /^((haslo|password|pass|pwd)(\d+|alt\w*|alternatywne\w*|zapasowe|dodatkowe|drugie|trzecie|stare|poprzednie|old\w*|backup|\w+)|(stare|poprzednie|dawne|tymczasowe|zapasowe|alternatywne|drugie|kolejne|dodatkowe|old|previous|temp\w*|backup|alt\w*)(haslo|password|pass|pwd)\d*|pin\d*|puk\d*)$/;
const ALT_LABEL_RE = /^(opishasla|etykietahasla|passwordlabel)(\d+)$/;
const COL_LABELS = { firstName: 'Imię', lastName: 'Nazwisko', fullName: 'Imię i nazwisko', displayName: 'Nazwa wyświetlana', email: 'E-mail', password: 'Hasło',
  license: 'Licencje', notes: 'Uwagi', department: 'Dział', jobTitle: 'Stanowisko', phone: 'Telefon', mobile: 'Telefon komórkowy', office: 'Biuro' };

// Rozpoznaje kolumny w wierszu nagłówka
function mapHeader(header){
  const idx = {}, alts = [], altLabels = {}, other = [];
  header.forEach((h, i) => {
    const n = norm(h); if (!n) return;
    for (const [k, keys] of Object.entries(COLS)) if (idx[k] == null && keys.includes(n)){ idx[k] = i; return; }
    if (Object.values(idx).includes(i)) return;
    let m;
    if ((m = n.match(ALT_LABEL_RE))){ altLabels[m[2]] = i; return; }
    if (ALT_PW_RE.test(n)){ alts.push({ i, header: String(h).trim(), num: (n.match(/\d+$/) || [''])[0] }); return; }
    if (SKIP_COLS.includes(n)) return;
    other.push({ i, header: String(h).trim() });
  });
  if (idx.email == null){ // awaryjnie: kolumna, której nazwa zawiera „mail”
    const i = header.findIndex((h, j) => /mail|upn/.test(norm(h)) && !Object.values(idx).includes(j));
    if (i >= 0){ idx.email = i; const o = other.findIndex(x => x.i === i); if (o >= 0) other.splice(o, 1); }
  }
  return { idx, alts, altLabels, other, score: Object.keys(idx).length + (idx.email != null ? 3 : 0) };
}
// Szuka wiersza nagłówka (nad tabelą bywa tytuł) i najlepszego arkusza
function analyzeSheet(sh){
  let best = null;
  sh.rows.slice(0, 25).forEach((row, r) => { const m = mapHeader(row); if (!best || m.score > best.score) best = { ...m, headerRow: r }; });
  return best ? { ...best, sheet: sh } : { score: 0, sheet: sh, idx: {}, alts: [], altLabels: {}, other: [], headerRow: 0 };
}

let pendingImport = null, importSource = null, pendingApps = [];
// Arkusz z dostępami do aplikacji (np. „Aplikacje” z eksportu): kolumny E-mail, Aplikacja, Login, Hasło, Adres strony, Uwagi
function appSheetRows(sh){
  const kind = n => /^(e?mail|adresemail|emailkonta|kontomicrosoft|kontom365)$/.test(n) ? 'email' : /^(aplikacja|aplikacje|serwis|usluga|system|program|strona|portal)$/.test(n) ? 'name'
    : /^(login|uzytkownik|nazwauzytkownika|username|user)$/.test(n) ? 'login' : /^(haslo|password|pass)$/.test(n) ? 'password'
    : /^(adres|adresstrony|url|link|www|adreswww)$/.test(n) ? 'url' : /^(uwagi|notatki|opis|notes)$/.test(n) ? 'note' : '';
  for (let h = 0; h < Math.min(10, sh.rows.length); h++){
    const idx = {}; sh.rows[h].forEach((c, i) => { const k = kind(norm(c || '')); if (k && idx[k] == null) idx[k] = i; });
    if (idx.email == null || idx.name == null) continue;
    const g = (r, k) => idx[k] == null ? '' : String(r[idx[k]] ?? '').trim();
    return sh.rows.slice(h + 1).map(r => ({ email: g(r, 'email').toLowerCase(), name: g(r, 'name'), login: g(r, 'login'), password: g(r, 'password'), url: safeUrl(g(r, 'url')), note: g(r, 'note') }))
      .filter(x => EMAIL_RE.test(x.email) && x.name);
  }
  return null;
}
async function doImport(){
  const r = await api.excelImport();
  if (!r || r.canceled) return;
  if (!r.ok){ toast(r.error, { bad: true }); return; }
  const appSheets = r.sheets.map(sh => [sh, appSheetRows(sh)]).filter(x => x[1]);
  pendingApps = appSheets.flatMap(x => x[1]);
  const analyses = r.sheets.filter(sh => !appSheets.some(x => x[0] === sh)).map(analyzeSheet);
  let usable = analyses.filter(a => a.idx.email != null);
  // Plik tylko z dostępami do aplikacji: dopisz je do kont, które są w skarbcu (albo w pliku)
  if (!usable.length && pendingApps.length) usable = [{ score: 0, idx: { email: 0 }, alts: [], altLabels: {}, other: [], headerRow: 0, sheet: { name: appSheets[0][0].name + ' (tylko dostępy)', rows: [['E-mail']], nums: [1] } }];
  if (!usable.length){ toast('Nie znaleziono kolumny z adresem e-mail. Użyj szablonu importu.', { bad: true }); return; }
  importSource = { file: r.file, analyses: usable };
  const bestI = usable.reduce((b, a, i) => a.score > usable[b].score ? i : b, 0);
  const sheetSel = $('#impSheet');
  sheetSel.replaceChildren(...usable.map((a, i) => el('option', { value: String(i), text: `${a.sheet.name} (${a.sheet.rows.length - a.headerRow - 1} wierszy)` })));
  sheetSel.value = String(bestI);
  $('#impSheetWrap').hidden = usable.length < 2;
  $('#impFile').textContent = `Plik: ${r.file}`;
  prepareImport(usable[bestI]);
  $('#importDlg').showModal();
}
$('#impSheet').addEventListener('change', () => prepareImport(importSource.analyses[+$('#impSheet').value]));

function prepareImport(a){
  const { idx, alts, altLabels, other } = a;
  const rows = a.sheet.rows.slice(a.headerRow + 1);
  const get = (row, k) => idx[k] == null ? '' : String(row[idx[k]] ?? '').trim();
  const fresh = [], updates = [], errors = []; const seen = new Set();
  rows.forEach((row, i) => {
    const line = (a.sheet.nums || [])[a.headerRow + 1 + i] || a.headerRow + i + 2;
    let first = get(row, 'firstName'), last = get(row, 'lastName');
    const email = get(row, 'email'), display = get(row, 'displayName');
    const named = get(row, 'fullName') || display;
    if ((!first || !last) && named && /\s/.test(named)){ const p = named.split(/\s+/); first = first || p[0] || ''; last = last || p.slice(1).join(' '); }
    if (!email && !first && !last) return;
    if (!EMAIL_RE.test(email)){ errors.push(`Wiersz ${line}: nieprawidłowy adres e-mail „${email}”`); return; }
    const k = email.toLowerCase();
    if (seen.has(k)){ errors.push(`Wiersz ${line}: adres ${email} powtarza się w pliku`); return; }
    seen.add(k);
    if (!first && !last){ const lp = email.split('@')[0].split(/[._-]/); first = cap(lp[0] || ''); last = cap(lp.slice(1).join(' ')); }
    const d = { firstName: first, lastName: last, email, password: get(row, 'password'), notes: get(row, 'notes'), displayName: display,
      license: idx.license == null ? '' : licJoin(get(row, 'license').split(/\s*[;,\n]\s*/)),
      altPasswords: alts.map(x => ({ label: altLabels[x.num] != null ? String(row[altLabels[x.num]] ?? '').trim() : (x.num ? '' : x.header), password: String(row[x.i] ?? '').trim() })).filter(x => x.password),
      extraRaw: other.map(x => ({ i: x.i, label: x.header, value: String(row[x.i] ?? '').trim() })).filter(x => x.value) };
    ['department', 'jobTitle', 'phone', 'mobile', 'office'].forEach(f => { d[f] = get(row, f); });
    const ex = entries.find(x => x.email.toLowerCase() === k);
    ex ? updates.push({ ex, d }) : fresh.push(d);
  });
  pendingImport = { fresh, updates, hasLicense: idx.license != null };
  const known = new Set([...entries.map(x => x.email.toLowerCase()), ...fresh.map(d => d.email.toLowerCase())]);
  const appsOk = pendingApps.filter(x => known.has(x.email)), appsOut = pendingApps.length - appsOk.length;
  $('#impAppsWrap').hidden = !pendingApps.length; $('#impApps').checked = !!appsOk.length;
  $('#impAppsLbl').textContent = `Dodaj dostępy do aplikacji z pliku (${appsOk.length}: ${[...new Set(appsOk.map(x => x.name))].slice(0, 6).join(', ')})` + (appsOut ? `. Pominięte – brak konta w skarbcu: ${appsOut}` : '');
  const noPw = fresh.filter(d => !d.password).length;
  $('#impStats').replaceChildren(
    el('div', { class: 'g-row' }, el('span', { class: 'lbl', text: 'Nowe konta' }), el('span', { class: 'val stat', text: String(fresh.length) })),
    el('div', { class: 'g-row' }, el('span', { class: 'lbl', text: 'Już w skarbcu' }), el('span', { class: 'val stat', text: String(updates.length) })),
    el('div', { class: 'g-row' }, el('span', { class: 'lbl', text: 'Bez hasła' }), el('span', { class: 'val stat', text: String(noPw) })),
    el('div', { class: 'g-row' }, el('span', { class: 'lbl', text: 'Pominięte' }), el('span', { class: 'val stat', text: String(errors.length), style: errors.length ? 'color:var(--danger)' : '' })));
  const header = a.sheet.rows[a.headerRow] || [];
  $('#impMap').textContent = 'Rozpoznane kolumny: ' + [
    ...Object.entries(idx).map(([k, i]) => `${COL_LABELS[k]} ← „${header[i]}”`),
    ...alts.map(x => `kolejne hasło ← „${x.header}”`)].join(', ') + (a.headerRow ? ` (nagłówek w wierszu ${(a.sheet.nums || [])[a.headerRow] || a.headerRow + 1})` : '');
  $('#impErrors').replaceChildren(...errors.slice(0, 50).map(t => el('div', { text: t })), errors.length > 50 ? el('div', { text: `…i ${errors.length - 50} więcej` }) : '');
  $('#impUpdateLbl').textContent = `Zaktualizuj konta, które już są w skarbcu (${updates.length})`;
  $('#impUpdWrap').hidden = !updates.length; $('#impModeWrap').hidden = !$('#impUpdate').checked;
  $('#impGenLbl').textContent = `Wygeneruj hasła dla nowych kont bez hasła (${noPw}). Bez zaznaczenia konta zostaną dodane bez hasła — uzupełnisz je później.`;
  $('#impGen').checked = false;
  $('#impAdd').checked = true;
  $('#impAddLbl').textContent = `Dodaj nowe konta z pliku (${fresh.length}). Odznacz, aby tylko uzupełnić konta, które już są w skarbcu.`;
  $('#impAddWrap').hidden = !fresh.length;
  $('#impGenWrap').hidden = !noPw;
  const usedOther = other.filter(x => fresh.concat(updates.map(u => u.d)).some(d => d.extraRaw.some(y => y.i === x.i)));
  $('#impExtra').replaceChildren(...usedOther.map(x => el('label', { class: 'check lic' },
    (c => { c.checked = usedOther.length <= 8; return c; })(el('input', { type: 'checkbox', value: String(x.i) })), el('span', { text: x.header }))));
  $('#impExtraWrap').hidden = !usedOther.length;
  impGoState();
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
$('#importBtn').addEventListener('click', doImport);
$('#impUpdate').addEventListener('change', () => { $('#impModeWrap').hidden = !$('#impUpdate').checked; });
$('#impCancel').addEventListener('click', () => { pendingImport = null; $('#importDlg').close(); });
function impGoState(){
  const p = pendingImport; if (!p) return;
  const add = $('#impAdd').checked && p.fresh.length, upd = $('#impUpdate').checked && p.updates.length;
  $('#impGo').disabled = !add && !upd && !($('#impApps').checked && pendingApps.length);
  $('#impGenWrap').hidden = !$('#impAdd').checked || !p.fresh.some(d => !d.password);
}
$('#impAdd').addEventListener('change', impGoState);
$('#impApps').addEventListener('change', impGoState);
$('#impUpdate').addEventListener('change', impGoState);
$('#impGo').addEventListener('click', async () => {
  if (!pendingImport) return;
  const now = new Date().toISOString(); let added = 0, changed = 0;
  const extraCols = new Set([...$('#impExtra').querySelectorAll('input:checked')].map(c => +c.value));
  const finish = d => { const { extraRaw, ...rest } = d; rest.extra = extraRaw.filter(x => extraCols.has(x.i)).map(({ label, value }) => ({ label, value })); return rest; };
  if ($('#impAdd').checked) pendingImport.fresh.forEach(d0 => {
    const d = finish(d0);
    if (!d.password && $('#impGen').checked) d.password = genPassword(16);
    entries.push(normEntry({ id: crypto.randomUUID(), ...d, created: now, updated: now })); added++;
  });
  const overwrite = document.querySelector('input[name="impMode"]:checked').value === 'overwrite';
  if ($('#impUpdate').checked) pendingImport.updates.forEach(({ ex, d: d0 }) => {
    const d = finish(d0); let diff = false;
    const set = (f, v) => { if (ex[f] !== v){ ex[f] = v; diff = true; } };
    for (const f of ['firstName', 'lastName', 'password', 'notes', ...FIELDS.map(x => x.k)]){
      if (d[f] && (overwrite || !ex[f])) set(f, d[f]);
    }
    if (pendingImport.hasLicense && d.license){
      const exEmpty = licList(ex)[0] === NO_LICENSE;
      if (overwrite ? true : exEmpty && d.license !== NO_LICENSE) set('license', d.license);
    }
    d.altPasswords.forEach(a => { if (a.password !== ex.password && !ex.altPasswords.some(x => x.password === a.password)){ ex.altPasswords.push(a); diff = true; } });
    d.extra.forEach(x => {
      const cur = ex.extra.find(y => y.label.toLowerCase() === x.label.toLowerCase());
      if (!cur){ ex.extra.push(x); diff = true; } else if (overwrite && cur.value !== x.value){ cur.value = x.value; diff = true; }
    });
    if (diff){ ex.updated = now; changed++; }
  });
  let appsN = 0;
  if ($('#impApps').checked) pendingApps.forEach(x => {
    const e = entries.find(y => y.email.toLowerCase() === x.email); if (!e) return;
    const cur = e.apps.find(a => appKey(a.name) === appKey(x.name) && (!x.login || !a.login || a.login.toLowerCase() === x.login.toLowerCase()));
    if (!cur){ e.apps.push({ id: crypto.randomUUID(), name: (presetOf(x.name) || {}).name || x.name, url: x.url || appUrlFor(x.name), login: x.login, password: x.password, note: x.note, pwSet: x.password ? now : '' }); e.updated = now; appsN++; return; }
    let diff = false; const set = (f, v) => { if (v && cur[f] !== v && (overwrite || !cur[f])){ cur[f] = v; diff = true; } };
    ['login', 'password', 'url', 'note'].forEach(f => set(f, x[f]));
    if (diff){ e.updated = now; appsN++; }
  });
  pendingImport = null; pendingApps = []; $('#importDlg').close();
  await persist(); render();
  logEv('Import z Excela', `${added} nowych, ${changed} zaktualizowanych` + (appsN ? `, dostępy do aplikacji: ${appsN}` : ''));
  toast(`Zaimportowano: ${added} nowych, ${changed} zaktualizowanych` + (appsN ? `, dostępy do aplikacji: ${appsN}` : ''));
});

/* ---------- ustawienia ---------- */
let pendingBackup = null;
function renderSectionSettings(){
  const box = $('#secOrder'); if (!box) return;
  box.replaceChildren(...cfg.sections.map((k, i) => el('li', null,
    el('span', { text: SECTIONS.find(x => x.k === k).label }),
    el('button', { class: 'sec-mv', type: 'button', text: '↑', title: 'Wyżej', disabled: i === 0 ? '' : null, onclick: () => moveSection(k, -1) }),
    el('button', { class: 'sec-mv', type: 'button', text: '↓', title: 'Niżej', disabled: i === cfg.sections.length - 1 ? '' : null, onclick: () => moveSection(k, 1) }))));
}
$('#secReset').addEventListener('click', () => setSections(SECTIONS.map(x => x.k)));
function openSettings(){
  ['#newMp', '#newMp2', '#bkPw'].forEach(s => $(s).value = ''); ['#mpErr', '#bkErr'].forEach(s => $(s).textContent = '');
  $('#bkPwRow').hidden = true; pendingBackup = null; $('#msSetup').hidden = true; renderSmsSettings(); renderSectionSettings(); renderSecSettings(); $('#settings').showModal(); renderMsSettings();
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', () => $('#settings').close());
$('#settings').addEventListener('close', async () => {
  if (!$('#msCodeBox').hidden){ api.msLoginCancel(); $('#msCodeBox').hidden = true; }
  // zapis treści szablonu SMS po zamknięciu ustawień
  if (!key || !smsReady()) return;
  const tpl = $('#smsTpl').value.trim() || DEFAULT_TPL, ascii = $('#smsAscii').checked;
  if (tpl !== cfg.sms.template || ascii !== cfg.sms.ascii){ cfg.sms.template = tpl; cfg.sms.ascii = ascii; await persist(); }
});

/* SMS: podłączenie numeru firmowego */
const SMS_HELP = {
  messages: 'SMS-y wyjdą z numeru Twojego iPhone’a. Warunki: ten sam Apple ID na iPhonie i Macu oraz na iPhonie: Ustawienia → Aplikacje → Wiadomości → Przekazywanie wiadomości tekstowych → włącz ten Mac. Przy pierwszym połączeniu macOS zapyta o zgodę na sterowanie aplikacją Wiadomości.',
  smsapi: 'SMS-y wyjdą przez bramkę SMSAPI.pl. Token wygenerujesz w panelu SMSAPI: Ustawienia API → Tokeny API (uprawnienie SMS). Numer firmowy możesz dodać tam jako pole nadawcy po weryfikacji.'
};
const smsProv = () => (document.querySelector('input[name=smsProv]:checked') || {}).value || 'messages';
function renderSmsSettings(){
  const on = smsReady(), sm = cfg.sms;
  $('#smsState').textContent = on
    ? `Podłączony: ${fmtNum(sm.number)} · ${sm.provider === 'messages' ? 'przez iPhone’a (Wiadomości)' : 'przez SMSAPI.pl'}`
    : 'Niepodłączony. Po podłączeniu w szczegółach konta pojawi się „Wyślij hasło SMS…”.';
  $('#smsToggle').hidden = on; $('#smsToggle').textContent = 'Podłącz…';
  $('#smsSetup').hidden = true; $('#smsOn').hidden = !on;
  $('#smsTpl').value = sm.template; $('#smsAscii').checked = sm.ascii; $('#smsOnErr').textContent = '';
}
function smsProvChanged(){ const p = smsProv(); $('#smsApiWrap').hidden = p !== 'smsapi'; $('#smsHelp').textContent = SMS_HELP[p]; }
function openSmsSetup(){
  const sm = cfg.sms;
  document.querySelectorAll('input[name=smsProv]').forEach(r => { r.checked = r.value === (sm.provider || 'messages'); });
  $('#smsNumber').value = sm.number ? fmtNum(sm.number) : ''; $('#smsToken').value = sm.token; $('#smsSender').value = sm.sender;
  $('#smsErr').textContent = ''; smsProvChanged();
  $('#smsToggle').hidden = true; $('#smsOn').hidden = true; $('#smsSetup').hidden = false;
  setTimeout(() => $('#smsNumber').focus(), 30);
}
document.querySelectorAll('input[name=smsProv]').forEach(r => r.addEventListener('change', smsProvChanged));
$('#smsToggle').addEventListener('click', openSmsSetup);
$('#smsCancel').addEventListener('click', renderSmsSettings);
$('#smsConnect').addEventListener('click', async () => {
  const err = $('#smsErr'), btn = $('#smsConnect');
  const c = { provider: smsProv(), number: normNumber($('#smsNumber').value), token: $('#smsToken').value.trim(), sender: $('#smsSender').value.trim() };
  if (!c.number){ err.textContent = 'Podaj swój numer firmowy, np. +48 600 100 200.'; $('#smsNumber').focus(); return; }
  if (c.provider === 'smsapi' && !c.token){ err.textContent = 'Wklej token API z panelu SMSAPI.'; $('#smsToken').focus(); return; }
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Łączenie…';
  const r = await api.smsCheck(c).catch(x => ({ ok: false, error: String(x.message || x) }));
  btn.disabled = false; btn.textContent = 'Połącz';
  if (!r || !r.ok){ err.textContent = (r && r.error) || 'Nie udało się połączyć.'; return; }
  if (c.provider !== 'smsapi'){ c.token = ''; c.sender = ''; }
  Object.assign(cfg.sms, c, { connected: true });
  await persist(); renderSmsSettings(); renderDetail();
  toast(`Podłączono numer ${fmtNum(c.number)}. ${r.info || ''}`.trim());
});
$('#smsTest').addEventListener('click', async () => {
  const b = $('#smsTest'); b.disabled = true; $('#smsOnErr').textContent = '';
  const r = await api.smsSend(cfg.sms, cfg.sms.number, cfg.sms.ascii ? 'Skarbiec: test wysylki SMS.' : 'Skarbiec: test wysyłki SMS.')
    .catch(x => ({ ok: false, error: String(x.message || x) }));
  b.disabled = false;
  if (r && r.ok) toast(`Wysłano SMS testowy na ${fmtNum(cfg.sms.number)}`); else $('#smsOnErr').textContent = (r && r.error) || 'Nie udało się wysłać.';
});
$('#smsOff').addEventListener('click', async () => {
  $('#settings').close();
  if (!(await askConfirm('Odłączyć numer firmowy?', 'Wysyłanie haseł SMS-em zostanie wyłączone, a zapisany token usunięty.', 'Odłącz'))){ openSettings(); return; }
  const keep = { template: cfg.sms.template, ascii: cfg.sms.ascii };
  cfg.sms = { ...defaultCfg().sms, ...keep }; await persist(); renderDetail(); openSettings(); toast('Odłączono numer firmowy');
});
$('#bkSave').addEventListener('click', async () => {
  const r = await api.backupExport(await blobText());
  if (r && r.ok) logEv('Zapisano kopię zapasową', r.filePath);
  if (r && r.ok) toast('Zapisano kopię zapasową', { action: { label: 'Pokaż plik', fn: () => api.showInFolder(r.filePath) } });
});
$('#bkLoad').addEventListener('click', async () => {
  const r = await api.backupImport(); if (!r || r.canceled) return;
  if (!r.ok){ toast(r.error, { bad: true }); return; }
  try { const b = JSON.parse(r.text); if (!b.salt || !b.iv || !b.ct) throw 0; pendingBackup = b; }
  catch (_){ toast('To nie jest plik kopii skarbca.', { bad: true }); return; }
  $('#bkPwRow').hidden = false; $('#bkErr').textContent = ''; $('#bkPw').focus();
});
$('#bkRestore').addEventListener('click', async () => {
  if (!pendingBackup) return;
  const b = pendingBackup; let k, data, s;
  const pw = $('#bkPw').value, p = kdfOf(b);
  try { s = unb64(b.salt); k = await deriveKey(pw, s, p, 'Odszyfrowywanie kopii…'); data = await decryptData(k, b.iv, b.ct); }
  catch (_){ $('#bkErr').textContent = 'Nie udało się odszyfrować kopii. Sprawdź hasło.'; return; }
  if (!Array.isArray(data)){ $('#bkErr').textContent = 'Kopia ma nieprawidłowy format.'; return; }
  $('#settings').close();
  if (!(await askConfirm('Zastąpić obecne dane?', `Kopia zawiera ${kont(data.length)}. Obecna lista zostanie zastąpiona, a hasłem głównym stanie się hasło kopii.`, 'Przywróć'))) return;
  msStop(); setKey(k, s, p); entries = data; snapPw(); if (b.cfg) cfg = await readCfg(k, b); setSel(null); licFilter = ''; msStart();
  $('#bkPw').value = '';
  logEv('Przywrócono dane z kopii zapasowej', kont(data.length));
  await persist(); render(); toast('Przywrócono dane z kopii');
  await upgradeKdf(pw);
});
$('#tplSave').addEventListener('click', async () => {
  const r = await api.excelTemplate([...LICENSES, NO_LICENSE]);
  if (r && r.ok) toast('Zapisano szablon', { action: { label: 'Pokaż plik', fn: () => api.showInFolder(r.filePath) } });
});
$('#changeMp').addEventListener('click', async () => {
  const a = $('#newMp').value, b = $('#newMp2').value, err = $('#mpErr'); err.textContent = '';
  if (a.length < 10){ err.textContent = 'Hasło główne musi mieć co najmniej 10 znaków.'; return; }
  if (a !== b){ err.textContent = 'Hasła nie są takie same.'; return; }
  const btn = $('#changeMp'), before = key, s = crypto.getRandomValues(new Uint8Array(16));
  btn.disabled = true; btn.textContent = 'Zmieniam…';
  let k; try { k = await deriveKey(a, s, KDF_NEW, 'Tworzenie nowego klucza…'); } finally { btn.disabled = false; btn.textContent = 'Zmień hasło'; }
  if (key !== before) return;
  setKey(k, s, KDF_NEW);
  await persist(); $('#newMp').value = ''; $('#newMp2').value = '';
  logEv('Zmieniono hasło główne');
  toast('Zmieniono hasło główne. Zapisz nową kopię zapasową.');
});

/* ---------- autoblokada ---------- */
function resetIdle(){
  clearTimeout(idleTimer);
  const min = (cfg.sec && cfg.sec.lockMin) || IDLE_MS / 60000;
  if (key) idleTimer = setTimeout(() => { if (key){ showLock('brak aktywności przez ' + min + ' min'); toast(`Zablokowano po ${min} ${plural(min, 'minucie', 'minutach', 'minutach')} bezczynności`); } }, min * 60000);
}
['pointerdown', 'keydown', 'mousemove', 'wheel'].forEach(ev => window.addEventListener(ev, () => { if (key) resetIdle(); }, { passive: true }));

showLock();
})();
