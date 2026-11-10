'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const excel = require('./excel');
const sms = require('./sms');
const ms365 = require('./ms365');

const isMac = process.platform === 'darwin';
const vaultPath = () => path.join(app.getPath('userData'), 'vault.json');
let win = null;

const PKG = (() => { try { return require('./package.json'); } catch (_) { return {}; } })();
const APP_INFO = { name: 'Skarbiec', version: PKG.version || app.getVersion(), author: PKG.author || '', year: 2026 };

// Do wersji 1.4.x program nazywał się „Skarbiec kont Office” i trzymał dane w folderze o tej nazwie.
// Przy pierwszym uruchomieniu pod nową nazwą kopiujemy skarbiec (stary folder zostaje jako zapas).
function migrateOldData() {
  try {
    const dir = app.getPath('userData');
    if (path.basename(dir) !== 'Skarbiec' || fs.existsSync(path.join(dir, 'vault.json'))) return;
    const old = path.join(app.getPath('appData'), 'Skarbiec kont Office');
    if (!fs.existsSync(path.join(old, 'vault.json'))) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['vault.json.bak', 'vault.json']) {
      const src = path.join(old, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
  } catch (_) { /* brak dostępu – program zacznie z pustym skarbcem, stare dane zostają nietknięte */ }
}
migrateOldData();

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 760, minWidth: 900, minHeight: 560,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1d2230' : '#dde5f0'),
    title: 'Skarbiec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      devTools: !app.isPackaged // w zainstalowanej aplikacji nie da się otworzyć narzędzi deweloperskich
    }
  });
  // Ochrona przed zrzutami i nagrywaniem/udostępnianiem ekranu: okno jest pomijane (czarne) w przechwyconym obrazie.
  // Włączona od startu; po odblokowaniu stosowane jest ustawienie ze skarbca.
  win.setContentProtection(true);
  win.on('minimize', () => win.webContents.send('win:hidden'));
  win.on('hide', () => win.webContents.send('win:hidden'));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('win:state', { max: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { max: false }));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; });
}

/* ---------- menu macOS ---------- */
const send = (cmd) => () => { if (win) win.webContents.send('menu:cmd', cmd); };
function buildMacMenu() {
  const name = 'Skarbiec';
  return Menu.buildFromTemplate([
    { label: name, submenu: [
      { role: 'about', label: `O programie ${name}` },
      { type: 'separator' },
      { label: 'Kopia i ustawienia…', accelerator: 'Cmd+,', click: send('settings') },
      { type: 'separator' },
      { role: 'services', label: 'Usługi' },
      { type: 'separator' },
      { role: 'hide', label: `Ukryj ${name}` },
      { role: 'hideOthers', label: 'Ukryj pozostałe' },
      { role: 'unhide', label: 'Pokaż wszystkie' },
      { type: 'separator' },
      { role: 'quit', label: `Zakończ ${name}` }
    ] },
    { label: 'Plik', submenu: [
      { label: 'Nowe konto', accelerator: 'Cmd+N', click: send('new') },
      { type: 'separator' },
      { label: 'Import z Excela…', accelerator: 'Shift+Cmd+I', click: send('import') },
      { label: 'Eksport do Excela…', accelerator: 'Shift+Cmd+E', click: send('export') },
      { type: 'separator' },
      { label: 'Usuń zaznaczone', accelerator: 'Cmd+Backspace', registerAccelerator: false, click: send('delete') },
      { type: 'separator' },
      { label: 'Przegląd bezpieczeństwa…', accelerator: 'Shift+Cmd+B', click: send('health') },
      { label: 'Dziennik zdarzeń…', accelerator: 'Shift+Cmd+D', click: send('log') },
      { type: 'separator' },
      { label: 'Zablokuj skarbiec', accelerator: 'Cmd+L', click: send('lock') },
      { type: 'separator' },
      { role: 'close', label: 'Zamknij okno' }
    ] },
    { label: 'Edycja', submenu: [
      { role: 'undo', label: 'Cofnij' },
      { role: 'redo', label: 'Przywróć' },
      { type: 'separator' },
      { role: 'cut', label: 'Wytnij' },
      { role: 'copy', label: 'Kopiuj' },
      { role: 'paste', label: 'Wklej' },
      { label: 'Zaznacz wszystko', accelerator: 'Cmd+A', click: send('selectAll') },
      { type: 'separator' },
      { label: 'Szukaj', accelerator: 'Cmd+F', click: send('search') }
    ] },
    { label: 'Widok', submenu: [
      { role: 'togglefullscreen', label: 'Pełny ekran' }
    ] },
    { role: 'window', label: 'Okno', submenu: [
      { role: 'minimize', label: 'Minimalizuj' },
      { role: 'zoom', label: 'Powiększ' },
      { type: 'separator' },
      { role: 'front', label: 'Przenieś wszystko na wierzch' }
    ] }
  ]);
}

if (isMac) {
  app.setAboutPanelOptions({
    applicationName: APP_INFO.name,
    applicationVersion: APP_INFO.version,
    version: '',
    copyright: `Autor: ${APP_INFO.author}\n© ${APP_INFO.year} ${APP_INFO.author}`,
    credits: 'Szyfrowanie AES-256-GCM, klucz z hasła głównego: scrypt (N = 2^20, r = 8, p = 2, ok. 1 GB pamięci).'
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(isMac ? buildMacMenu() : null);
  createWindow();
  // Zablokuj skarbiec przy uśpieniu komputera lub zablokowaniu ekranu
  const lockNow = () => { if (win) win.webContents.send('menu:cmd', 'lock'); };
  powerMonitor.on('suspend', lockNow);
  powerMonitor.on('lock-screen', lockNow);
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });

/* ---------- okno ---------- */
ipcMain.handle('app:info', () => APP_INFO);
ipcMain.on('win:close', () => win && win.close());
ipcMain.on('win:min', () => win && win.minimize());
ipcMain.on('win:max', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
// Przesuwanie okna za górny pasek (macOS): obsługiwane w programie, bo strefy przeciągania systemu
// (-webkit-app-region) w Electron 33 na nowszych macOS potrafią nie reagować
let dragFrom = null;
ipcMain.on('win:dragStart', () => { if (win && !win.isFullScreen()) dragFrom = win.getPosition(); });
ipcMain.on('win:dragMove', (_e, dx, dy) => {
  if (!win || !dragFrom || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  // | 0: liczba całkowita bez „-0” (Electron odrzuca -0 i ułamki jako współrzędne okna)
  const x = Math.round(dragFrom[0] + dx) | 0, y = Math.round(dragFrom[1] + dy) | 0;
  try { win.setPosition(x, y); } catch (_) { /* pojedynczy nieudany krok przesuwania pomijamy */ }
});
ipcMain.on('win:dragEnd', () => { dragFrom = null; });

/* ---------- skarbiec ---------- */
/* ---------- klucz z hasła głównego: scrypt (odporny na łamanie kartami graficznymi) ---------- */
// Parametry tylko z dozwolonego zakresu – zmanipulowany plik skarbca nie może zażądać np. kilku GB pamięci
function scryptParams(p){
  const N = +(p && p.N), r = +(p && p.r), q = +(p && p.p);
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 20 || r !== 8 || !Number.isInteger(q) || q < 1 || q > 4) return null;
  return { N, r, p: q };
}
ipcMain.handle('kdf:scrypt', (_e, pw, saltB64, params) => new Promise((resolve, reject) => {
  const p = scryptParams(params), salt = Buffer.from(String(saltB64 || ''), 'base64');
  if (!p || typeof pw !== 'string' || pw.length > 1024 || salt.length < 16) return reject(new Error('Nieprawidłowe parametry klucza'));
  require('crypto').scrypt(pw.normalize('NFC'), salt, 32, { ...p, maxmem: 160 * p.N * p.r + 1024 * 1024 * 16 }, (err, key) => err ? reject(err) : resolve(new Uint8Array(key)));
}));

ipcMain.handle('vault:read', async () => {
  try { return await fsp.readFile(vaultPath(), 'utf8'); } catch (_) { return null; }
});
ipcMain.handle('vault:write', async (_e, text) => {
  if (typeof text !== 'string' || text.length > 50e6) throw new Error('Nieprawidłowe dane');
  const p = vaultPath(), tmp = p + '.tmp';
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(tmp, text, 'utf8');
  try { await fsp.copyFile(p, p + '.bak'); } catch (_) { /* brak poprzedniej wersji */ }
  await fsp.rename(tmp, p);
  return true;
});
ipcMain.handle('vault:delete', async () => {
  for (const f of [vaultPath(), vaultPath() + '.bak']) { try { await fsp.unlink(f); } catch (_) {} }
  return true;
});

/* ---------- schowek z auto-czyszczeniem ---------- */
// Hasła na macOS: znaczniki org.nspasteboard.Concealed/Transient (menedżery schowka ich nie zapisują) i tylko ten Mac
// (bez schowka uniwersalnego na iPhone/iPada). Tekst trafia do skryptu przez stdin – nie pojawia się w liście procesów.
const { execFile } = require('child_process');
function writeConcealed(text){
  return new Promise(resolve => {
    const script = `ObjC.import('AppKit');
var t = ${JSON.stringify(text)};
var pb = $.NSPasteboard.generalPasteboard;
pb.prepareForNewContentsWithOptions(1);
pb.declareTypesOwner($(['public.utf8-plain-text', 'org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'org.nspasteboard.AutoGeneratedType']), $());
pb.setStringForType($(t), 'public.utf8-plain-text');
pb.setStringForType($(''), 'org.nspasteboard.ConcealedType');
pb.setStringForType($(''), 'org.nspasteboard.TransientType');
'ok';`;
    const p = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { timeout: 5000 }, (err, out) => resolve(!err && /ok/.test(out)));
    p.stdin.end(script);
  });
}
ipcMain.handle('clip:write', async (_e, text, clearAfter) => {
  if (typeof text !== 'string') return false;
  const secret = clearAfter > 0;
  const ok = secret && isMac && await writeConcealed(text);
  if (!ok || clipboard.readText() !== text) clipboard.writeText(text);
  if (secret) setTimeout(() => { if (clipboard.readText() === text) clipboard.clear(); }, Math.min(clearAfter, 300000));
  return true;
});
ipcMain.handle('clip:clearIf', (_e, text) => { if (typeof text === 'string' && text && clipboard.readText() === text) clipboard.clear(); });

/* ---------- ochrona ekranu ---------- */
ipcMain.handle('win:protect', (_e, on) => { if (win) win.setContentProtection(!!on); return true; });

/* ---------- sprawdzanie wycieków haseł (Have I Been Pwned, k-anonimowość) ---------- */
// Wysyłane jest tylko 5 pierwszych znaków skrótu SHA-1 hasła; odpowiedź z dopełnieniem (Add-Padding) ukrywa nawet liczbę wyników.
ipcMain.handle('hibp:range', async (_e, prefix) => {
  if (!/^[0-9A-F]{5}$/.test(String(prefix || ''))) return { ok: false, error: 'Nieprawidłowe zapytanie' };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch('https://api.pwnedpasswords.com/range/' + prefix, { headers: { 'Add-Padding': 'true', 'User-Agent': 'Skarbiec-desktop' }, signal: ctl.signal });
    if (!r.ok) return { ok: false, error: 'Serwis odpowiedział błędem ' + r.status };
    return { ok: true, text: (await r.text()).slice(0, 2e6) };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'Serwis nie odpowiada' : 'Brak połączenia z internetem' }; }
  finally { clearTimeout(t); }
});

/* ---------- karta dostępu: PDF i druk ---------- */
// Osobne, niewidoczne okno bez JavaScriptu i bez dostępu do sieci; treść generuje Skarbiec (tekst jest escapowany w rendererze)
async function cardWindow(html){
  const w = new BrowserWindow({ show: false, width: 800, height: 1100, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, devTools: false, partition: 'skarbiec-card' } });
  w.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
  w.setContentProtection(true);
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html).slice(0, 5e6)));
  return w;
}
ipcMain.handle('card:pdf', async (_e, html, name) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Zapisz kartę dostępu', defaultPath: path.join(app.getPath('documents'), String(name || 'Karta dostępu').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) + '.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  const w = await cardWindow(html);
  try { await fsp.writeFile(filePath, await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } })); }
  finally { w.destroy(); }
  return { ok: true, filePath };
});
ipcMain.handle('card:print', async (_e, html) => {
  const w = await cardWindow(html);
  return new Promise(resolve => w.webContents.print({ silent: false, printBackground: true }, (ok, reason) => { w.destroy(); resolve({ ok, reason }); }));
});

/* ---------- dziennik zdarzeń: eksport ---------- */
ipcMain.handle('log:export', async (_e, rows) => {
  if (!Array.isArray(rows)) return { ok: false };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Eksport dziennika zdarzeń', defaultPath: path.join(app.getPath('documents'), `Dziennik-Skarbiec-${today()}.xlsx`),
    filters: [{ name: 'Skoroszyt programu Excel', extensions: ['xlsx'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  await excel.exportLog(rows.slice(0, 20000).map(r => ({ t: S(r.t), a: S(r.a), d: S(r.d) })), filePath);
  return { ok: true, filePath };
});

/* ---------- Excel ---------- */
const S = v => (v == null ? '' : String(v)).slice(0, 2000);
const FIELD_KEYS = ['firstName', 'lastName', 'displayName', 'email', 'password', 'license', 'department', 'jobTitle', 'phone', 'mobile', 'office', 'notes', 'created', 'updated'];
function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 20000).map(r => {
    const o = {};
    FIELD_KEYS.forEach(k => { o[k] = S(r && r[k]); });
    const arr = (a, f) => (Array.isArray(a) ? a : []).slice(0, 50).map(f);
    o.altPasswords = arr(r && r.altPasswords, a => ({ label: S(a && a.label), password: S(a && a.password) }));
    o.extra = arr(r && r.extra, x => ({ label: S(x && x.label), value: S(x && x.value) }));
    o.apps = arr(r && r.apps, a => ({ name: S(a && a.name), url: S(a && a.url), login: S(a && a.login), password: S(a && a.password), note: S(a && a.note) }));
    return o;
  });
}
const today = () => new Date().toISOString().slice(0, 10);

ipcMain.handle('excel:export', async (_e, rows) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Eksport do Excela',
    defaultPath: path.join(app.getPath('documents'), `Konta-Office-${today()}.xlsx`),
    filters: [{ name: 'Skoroszyt programu Excel', extensions: ['xlsx'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  await excel.exportWorkbook(cleanRows(rows), filePath);
  return { ok: true, filePath };
});

ipcMain.handle('excel:template', async (_e, licenses) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Zapisz szablon importu',
    defaultPath: path.join(app.getPath('documents'), 'Szablon-importu-kont.xlsx'),
    filters: [{ name: 'Skoroszyt programu Excel', extensions: ['xlsx'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  await excel.exportTemplate((Array.isArray(licenses) ? licenses : []).map(S).slice(0, 200), filePath);
  return { ok: true, filePath };
});

ipcMain.handle('excel:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import z Excela',
    properties: ['openFile'],
    filters: [{ name: 'Excel lub CSV', extensions: ['xlsx', 'csv'] }]
  });
  if (canceled || !filePaths.length) return { canceled: true };
  try {
    const t = await excel.readTable(filePaths[0]);
    return { ok: true, file: path.basename(filePaths[0]), ...t };
  } catch (err) {
    return { ok: false, error: 'Nie udało się odczytać pliku. Upewnij się, że to plik .xlsx lub .csv i nie jest otwarty w Excelu.' };
  }
});

/* ---------- kopia zapasowa ---------- */
ipcMain.handle('backup:export', async (_e, text) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Zapisz kopię zapasową',
    defaultPath: path.join(app.getPath('documents'), `Skarbiec-kopia-${today()}.skarbiec`),
    filters: [{ name: 'Kopia skarbca', extensions: ['skarbiec'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  await fsp.writeFile(filePath, String(text), 'utf8');
  return { ok: true, filePath };
});
ipcMain.handle('backup:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Wybierz kopię zapasową', properties: ['openFile'],
    filters: [{ name: 'Kopia skarbca', extensions: ['skarbiec', 'json', 'txt'] }]
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const st = await fsp.stat(filePaths[0]);
  if (st.size > 50e6) return { ok: false, error: 'Plik jest za duży.' };
  return { ok: true, file: path.basename(filePaths[0]), text: await fsp.readFile(filePaths[0], 'utf8') };
});

/* ---------- SMS ---------- */
const smsCfg = c => (c && typeof c === 'object') ? { provider: S(c.provider), number: S(c.number), token: S(c.token), sender: S(c.sender) } : null;
ipcMain.handle('sms:check', (_e, cfg) => sms.check(smsCfg(cfg)));
ipcMain.handle('sms:send', (_e, cfg, to, text) => sms.send(smsCfg(cfg), S(to), S(text)));
ipcMain.handle('sms:compose', async (_e, to) => { const r = sms.compose(S(to)); if (r.ok) await shell.openExternal(r.url); return r; });

/* ---------- Microsoft 365 (odczyt; zmiana haseł tylko na polecenie) ---------- */
const msCfg = c => (c && typeof c === 'object') ? { tenant: S(c.tenant), clientId: S(c.clientId), refreshToken: String(c.refreshToken || '').slice(0, 20000), write: !!c.write } : {};
// Zmiana hasła w Microsoft 365 – wyłącznie dla jednego, wskazanego użytkownika, na wyraźne polecenie z okna „Zmień hasła”
ipcMain.handle('ms:setPassword', (_e, c, msId, pw, force) => ms365.setPassword(msCfg(c), S(msId), typeof pw === 'string' ? pw : '', !!force));
ipcMain.handle('ms:forgetWrite', () => ms365.forgetWrite());
ipcMain.handle('ms:loginStart', (_e, c) => ms365.loginStart(msCfg(c)));
ipcMain.handle('ms:loginWait', () => ms365.loginWait());
ipcMain.handle('ms:loginCancel', () => ms365.loginCancel());
ipcMain.handle('ms:sync', (_e, c) => ms365.sync(msCfg(c)));
// Otwiera tylko stronę logowania kodem urządzenia Microsoftu
ipcMain.handle('ms:openLogin', (_e, uri) => {
  try { const u = new URL(String(uri)); if (u.protocol === 'https:' && /^(www\.)?(microsoft\.com|login\.microsoft\.com|microsoftonline\.com|login\.microsoftonline\.com)$/.test(u.hostname)) shell.openExternal(u.href); } catch (_) {}
});

ipcMain.handle('shell:show', (_e, p) => { if (typeof p === 'string') shell.showItemInFolder(p); });
// Strona aplikacji z karty konta – tylko adresy http(s)
ipcMain.handle('shell:openUrl', (_e, u) => {
  try { const x = new URL(String(u)); if ((x.protocol === 'https:' || x.protocol === 'http:') && x.hostname) { shell.openExternal(x.href); return true; } } catch (_) {}
  return false;
});
