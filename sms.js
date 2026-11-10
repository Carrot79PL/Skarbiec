'use strict';
// Wysyłanie SMS: przez iPhone'a połączonego z Makiem (aplikacja Wiadomości) albo przez bramkę SMSAPI.pl
const { execFile } = require('child_process');

const PROVIDERS = ['messages', 'smsapi'];

// Numer w formacie +48XXXXXXXXX (bez spacji); 9 cyfr = numer polski
function normNumber(n) {
  let s = String(n || '').replace(/[\s\-().\/]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\d{9}$/.test(s)) s = '+48' + s;
  else if (/^48\d{9}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : '';
}

function osa(script, args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { err.osa = String(stderr || err.message); return reject(err); }
      resolve(String(stdout).trim());
    });
  });
}
function osaError(err) {
  const m = err.osa || err.message || '';
  if (/NO_SMS/.test(m)) return 'Na tym Macu nie ma konta SMS. Na iPhonie z numerem firmowym włącz: Ustawienia → Aplikacje → Wiadomości → Przekazywanie wiadomości tekstowych → ten Mac.';
  if (/-1743|not authori[sz]ed|nie ma uprawnie/i.test(m)) return 'Brak zgody na sterowanie aplikacją Wiadomości. Zezwól w: Ustawienia systemowe → Prywatność i ochrona → Automatyzacja → Skarbiec → Wiadomości.';
  if (err.killed) return 'Aplikacja Wiadomości nie odpowiada.';
  return 'Nie udało się wysłać przez Wiadomości: ' + m.replace(/^.*execution error: /s, '').trim().slice(0, 200);
}

const SMS_ACCOUNT = `
    set smsAccts to {}
    repeat with a in accounts
      -- niektóre konta (np. RCS, nowe typy w macOS 27) zgłaszają błąd przy odczycie typu – pomijamy je
      try
        if service type of a is SMS then set end of smsAccts to (contents of a)
      end try
    end repeat
    if (count of smsAccts) is 0 then error "NO_SMS"`;

async function messagesCheck() {
  if (process.platform !== 'darwin') throw new Error('Wysyłanie przez iPhone’a działa tylko na macOS.');
  try {
    const out = await osa(`tell application "Messages"${SMS_ACCOUNT}
    set a to item 1 of smsAccts
    try
      return description of a
    on error
      return "SMS"
    end try
  end tell`, []);
    return { ok: true, info: 'iPhone połączony (konto SMS: ' + (out || 'SMS') + ')' };
  } catch (e) { return { ok: false, error: osaError(e) }; }
}

async function messagesSend(to, text) {
  if (process.platform !== 'darwin') return { ok: false, error: 'Wysyłanie przez iPhone’a działa tylko na macOS.' };
  try {
    await osa(`on run argv
  set num to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages"${SMS_ACCOUNT}
    set acct to item 1 of smsAccts
    set errs to ""
    -- 1) odbiorca w koncie SMS; 2) rozmowa SMS po identyfikatorze; 3) format rozmów nowszych macOS
    try
      send msg to participant num of acct
      return "participant"
    on error e number n
      set errs to errs & "participant " & n & "; "
    end try
    repeat with cid in {"SMS;-;" & num, "any;-;" & num}
      try
        send msg to chat id (contents of cid)
        return "chat"
      on error e number n
        set errs to errs & (contents of cid) & " " & n & "; "
      end try
    end repeat
    error "SEND_FAILED " & errs
  end tell
end run`, [to, text]);
    return { ok: true };
  } catch (e) {
    const m = String(e.osa || e.message || '');
    if (/SEND_FAILED/.test(m)) return { ok: false, manual: true, error: 'Wiadomości (macOS) odrzuciły automatyczne wysłanie SMS do tego numeru (' + (m.match(/SEND_FAILED ([^"]*)/) || ['', ''])[1].replace(/;\s*$/, '').slice(0, 160) + ').' };
    return { ok: false, manual: /-10000|-1708|-1728/.test(m), error: osaError(e) };
  }
}

const SMSAPI = 'https://api.smsapi.pl';
async function smsapi(pathname, token, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(SMSAPI + pathname, {
      method: body ? 'POST' : 'GET', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 || (j && (j.error === 101 || j.error === 102 || j.error === 103))) return { ok: false, error: 'Nieprawidłowy token SMSAPI.' };
    if (!r.ok || !j || j.error) return { ok: false, error: 'SMSAPI: ' + ((j && j.message) || 'błąd ' + r.status) };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'SMSAPI nie odpowiada.' : 'Brak połączenia z SMSAPI: ' + e.message };
  } finally { clearTimeout(t); }
}

function validCfg(cfg) {
  if (!cfg || !PROVIDERS.includes(cfg.provider)) return 'Wybierz sposób wysyłania.';
  if (!normNumber(cfg.number)) return 'Podaj prawidłowy numer firmowy.';
  if (cfg.provider === 'smsapi' && !/^[A-Za-z0-9._-]{10,200}$/.test(String(cfg.token || ''))) return 'Podaj token SMSAPI.';
  return '';
}

async function check(cfg) {
  const bad = validCfg(cfg); if (bad) return { ok: false, error: bad };
  if (cfg.provider === 'messages') return messagesCheck();
  const r = await smsapi('/profile', cfg.token);
  if (!r.ok) return r;
  const p = r.data.points != null ? `, punkty: ${r.data.points}` : '';
  return { ok: true, info: `Konto SMSAPI: ${r.data.username || r.data.email || r.data.name || 'połączone'}${p}` };
}

async function send(cfg, to, text) {
  const bad = validCfg(cfg); if (bad) return { ok: false, error: bad };
  const num = normNumber(to);
  if (!num) return { ok: false, error: 'Nieprawidłowy numer odbiorcy.' };
  text = String(text || '').trim();
  if (!text || text.length > 900) return { ok: false, error: 'Treść SMS jest pusta albo za długa.' };
  if (cfg.provider === 'messages') return { ...(await messagesSend(num, text)), to: num };
  const body = { to: num.slice(1), message: text, format: 'json', encoding: 'utf-8' };
  if (cfg.sender) body.from = String(cfg.sender).slice(0, 11);
  const r = await smsapi('/sms.do', cfg.token, body);
  return r.ok ? { ok: true, to: num } : r;
}

// Otwiera Wiadomości z rozmową z odbiorcą (treść użytkownik wkleja ze schowka)
function compose(to) {
  const num = normNumber(to);
  if (!num) return { ok: false, error: 'Nieprawidłowy numer odbiorcy.' };
  return { ok: true, url: 'sms:' + num };
}

module.exports = { check, send, compose, normNumber };
