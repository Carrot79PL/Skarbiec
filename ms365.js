'use strict';
// Synchronizacja z Microsoft 365 (Microsoft Graph): logowanie administratora kodem urządzenia,
// odczyt użytkowników i przypisanych licencji (tylko odczyt).
// Wyjątek – opcjonalny i włączany osobno: zmiana haseł wybranych użytkowników na polecenie administratora (setPassword).

// Domyślna aplikacja: „Microsoft Graph Command Line Tools” (publiczny klient Microsoftu, ten sam co w PowerShell Graph).
// Można podać własną rejestrację aplikacji z Entra ID.
const DEFAULT_CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const SCOPE = 'openid profile offline_access User.Read User.Read.All Organization.Read.All';
// Najwęższe uprawnienie Graph pozwalające ustawić hasło użytkownika (tylko passwordProfile)
const PW_PERM = 'User-PasswordProfile.ReadWrite.All';
const SCOPE_WRITE = SCOPE + ' ' + PW_PERM;
const WRITE_PERMS = [PW_PERM, 'User.ReadWrite.All', 'Directory.ReadWrite.All', 'Directory.AccessAsUser.All'];
const scopeOf = c => c && c.write ? SCOPE_WRITE : SCOPE;
const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Nazwy licencji jak w centrum administracyjnym (PL); nieznane SKU – nazwa techniczna
const SKU_NAMES = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS: 'Microsoft 365 Apps for business',
  SMB_BUSINESS: 'Microsoft 365 Apps for business',
  OFFICESUBSCRIPTION: 'Microsoft 365 Apps for enterprise',
  SPE_E3: 'Microsoft 365 E3', SPE_E5: 'Microsoft 365 E5', SPE_F1: 'Microsoft 365 F3',
  STANDARDPACK: 'Office 365 E1', ENTERPRISEPACK: 'Office 365 E3', ENTERPRISEPREMIUM: 'Office 365 E5',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)', EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  EXCHANGEDESKLESS: 'Exchange Online Kiosk', EXCHANGEARCHIVE_ADDON: 'Archiwum usługi Exchange Online',
  POWER_BI_STANDARD: 'Microsoft Fabric (wersja bezpłatna)', POWER_BI_PRO: 'Power BI Pro',
  PBI_PREMIUM_PER_USER: 'Power BI Premium na użytkownika',
  FLOW_FREE: 'Microsoft Power Automate Free', POWERAPPS_VIRAL: 'Microsoft Power Apps Plan 2 (wersja próbna)',
  POWERAPPS_DEV: 'Microsoft Power Apps for Developer', TEAMS_EXPLORATORY: 'Microsoft Teams Exploratory',
  Microsoft_Teams_Exploratory_Dept: 'Microsoft Teams Exploratory', TEAMS_ESSENTIALS: 'Microsoft Teams Essentials',
  VISIOCLIENT: 'Visio Plan 2', PROJECTPROFESSIONAL: 'Project Plan 3', AAD_PREMIUM: 'Microsoft Entra ID P1',
  INTUNE_A: 'Microsoft Intune Plan 1', WINDOWS_STORE: 'Windows Store for Business', CCIBOTS_PRIVPREV_VIRAL: 'Copilot Studio (wersja próbna)'
};
function skuName(part) {
  if (SKU_NAMES[part]) return SKU_NAMES[part];
  if (/copilot/i.test(part) && !/studio|bots/i.test(part)) return 'Microsoft 365 Copilot dla firm';
  if (/app_?connect/i.test(part)) return 'App Connect';
  return String(part || 'Nieznana licencja').replace(/_/g, ' ');
}

const form = o => new URLSearchParams(o).toString();
const validId = s => /^[A-Za-z0-9.-]{1,100}$/.test(String(s || ''));
const tenantOf = c => validId(c.tenant) ? c.tenant : 'organizations';
const clientOf = c => /^[0-9a-f-]{36}$/i.test(String(c.clientId || '')) ? c.clientId : DEFAULT_CLIENT;

async function post(url, body, timeout = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body), signal: ctl.signal });
    let j = {}; try { j = await r.json(); } catch (_) {}
    return { status: r.status, j };
  } finally { clearTimeout(t); }
}
function aadError(j) {
  const d = String(j.error_description || '');
  const code = (d.match(/AADSTS\d+/) || [''])[0];
  const known = {
    AADSTS65001: 'Brak zgody na uprawnienia. Zaloguj się jako administrator globalny i zaznacz „Wyraź zgodę w imieniu organizacji”.',
    AADSTS7000218: 'Własna aplikacja w Entra ID musi mieć włączone „Zezwalaj na przepływy klienta publicznego”.',
    AADSTS700016: 'Nie znaleziono aplikacji o tym identyfikatorze w tej organizacji.',
    AADSTS90002: 'Nie znaleziono organizacji (dzierżawy). Sprawdź domenę lub identyfikator.',
    AADSTS50020: 'To konto nie należy do tej organizacji.',
    AADSTS53003: 'Logowanie zablokowane przez zasady dostępu warunkowego.',
    AADSTS700082: 'Połączenie wygasło (długo nieużywane). Podłącz konto ponownie.',
    AADSTS50173: 'Hasło administratora zostało zmienione. Podłącz konto ponownie.',
    AADSTS50076: 'Wymagane ponowne logowanie z MFA. Podłącz konto ponownie.',
    AADSTS65004: 'Nie wyrażono zgody na uprawnienia. Spróbuj ponownie i zaakceptuj prośbę o zgodę.'
  };
  if (known[code]) return known[code] + ` (${code})`;
  if (j.error === 'invalid_grant') return 'Połączenie z Microsoft 365 wygasło. Podłącz konto ponownie.' + (code ? ` (${code})` : '');
  return 'Microsoft 365: ' + (d.split(/\r?\n/)[0] || j.error || 'nieznany błąd');
}

/* ---------- logowanie kodem urządzenia ---------- */
let flow = null;
async function loginStart(cfg) {
  loginCancel();
  try {
    const { status, j } = await post(`${LOGIN}/${tenantOf(cfg)}/oauth2/v2.0/devicecode`, { client_id: clientOf(cfg), scope: scopeOf(cfg) });
    if (status !== 200 || !j.device_code) return { ok: false, error: aadError(j) };
    flow = { cfg, device: j.device_code, interval: Math.max(2, j.interval || 5), until: Date.now() + (j.expires_in || 900) * 1000, cancel: false };
    return { ok: true, userCode: j.user_code, uri: j.verification_uri, expiresIn: j.expires_in };
  } catch (e) { return { ok: false, error: 'Brak połączenia z Microsoft: ' + e.message }; }
}
function loginCancel() { if (flow) flow.cancel = true; flow = null; }
async function loginWait() {
  const f = flow; if (!f) return { ok: false, error: 'Logowanie nie zostało rozpoczęte.' };
  while (!f.cancel && Date.now() < f.until) {
    await new Promise(r => setTimeout(r, f.interval * 1000));
    if (f.cancel) break;
    let res;
    try { res = await post(`${LOGIN}/${tenantOf(f.cfg)}/oauth2/v2.0/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientOf(f.cfg), device_code: f.device }); }
    catch (_) { continue; }
    const { j } = res;
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') { f.interval += 5; continue; }
    if (flow === f) flow = null;
    if (j.error === 'authorization_declined') return { ok: false, error: 'Logowanie zostało odrzucone.' };
    if (j.error === 'expired_token') return { ok: false, error: 'Kod wygasł. Spróbuj ponownie.' };
    if (!j.access_token) return { ok: false, error: aadError(j) };
    try {
      const me = await graph(j.access_token, '/me?$select=displayName,userPrincipalName');
      const org = (await graph(j.access_token, '/organization?$select=id,displayName')).value[0] || {};
      return { ok: true, refreshToken: j.refresh_token || '', tenantId: org.id || tenantOf(f.cfg), org: org.displayName || '',
        account: me.userPrincipalName || me.displayName || '', write: canWrite(j.access_token) };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (flow === f) flow = null;
  return { ok: false, error: f.cancel ? 'Anulowano.' : 'Kod wygasł. Spróbuj ponownie.', canceled: f.cancel };
}

/* ---------- Graph ---------- */
async function graph(token, pathOrUrl, tries = 3) {
  const url = pathOrUrl.startsWith('https://graph.microsoft.com/') ? pathOrUrl : GRAPH + pathOrUrl;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
    if ((r.status === 429 || r.status === 503) && tries > 1) {
      const wait = Math.min(30, +r.headers.get('retry-after') || 5) * 1000;
      clearTimeout(t); await new Promise(res => setTimeout(res, wait)); return graph(token, pathOrUrl, tries - 1);
    }
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 403) throw new Error('Brak uprawnień w Microsoft Graph (potrzebne User.Read.All i Organization.Read.All ze zgodą administratora).');
    if (!r.ok) throw new Error('Microsoft Graph: ' + ((j.error && j.error.message) || 'błąd ' + r.status));
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Microsoft Graph nie odpowiada.');
    throw e;
  } finally { clearTimeout(t); }
}

async function sync(cfg) {
  if (!cfg || !cfg.refreshToken) return { ok: false, error: 'Konto administratora nie jest podłączone.', relogin: true };
  let tok;
  try {
    const { j } = await post(`${LOGIN}/${tenantOf(cfg)}/oauth2/v2.0/token`, { grant_type: 'refresh_token', client_id: clientOf(cfg), refresh_token: cfg.refreshToken, scope: SCOPE });
    if (!j.access_token) return { ok: false, error: aadError(j), relogin: j.error === 'invalid_grant' };
    tok = j;
  } catch (e) { return { ok: false, error: 'Brak połączenia z Microsoft: ' + e.message }; }
  try {
    const skuList = (await graph(tok.access_token, '/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus')).value || [];
    const skus = new Map(skuList.map(s => [s.skuId, skuName(s.skuPartNumber)]));
    // Wykorzystanie licencji (przypisane / kupione) – tylko odczyt
    const licUsage = skuList.filter(s => s.capabilityStatus !== 'Deleted').map(s => ({ name: skuName(s.skuPartNumber), used: +s.consumedUnits || 0,
      total: +((s.prepaidUnits || {}).enabled) || 0, warning: +((s.prepaidUnits || {}).warning) || 0, suspended: +((s.prepaidUnits || {}).suspended) || 0 }));
    const users = [];
    let next = '/users?$top=999&$select=id,givenName,surname,displayName,mail,userPrincipalName,department,jobTitle,businessPhones,mobilePhone,officeLocation,accountEnabled,userType,assignedLicenses,lastPasswordChangeDateTime';
    for (let page = 0; next && page < 200; page++) {
      const j = await graph(tok.access_token, next);
      (j.value || []).forEach(u => {
        if (u.userType === 'Guest' || /#EXT#/i.test(u.userPrincipalName || '')) return;
        users.push({
          msId: u.id, upn: u.userPrincipalName || '', email: u.mail || u.userPrincipalName || '',
          firstName: u.givenName || '', lastName: u.surname || '', displayName: u.displayName || '',
          department: u.department || '', jobTitle: u.jobTitle || '', phone: (u.businessPhones || [])[0] || '',
          mobile: u.mobilePhone || '', office: u.officeLocation || '', enabled: u.accountEnabled !== false,
          pwChanged: u.lastPasswordChangeDateTime || '',
          licenses: (u.assignedLicenses || []).map(l => skus.get(l.skuId) || 'Nieznana licencja')
        });
      });
      next = j['@odata.nextLink'] || '';
    }
    return { ok: true, users, licUsage, refreshToken: tok.refresh_token || cfg.refreshToken };
  } catch (e) { return { ok: false, error: e.message, refreshToken: tok.refresh_token || cfg.refreshToken }; }
}

/* ---------- zmiana haseł (tylko gdy administrator ją włączył) ---------- */
// Uprawnienia z tokenu dostępu (pole scp); token nie jest weryfikowany – służy tylko do podpowiedzi w programie
function scopesOf(token){
  try { return String(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).scp || '').split(' '); }
  catch (_) { return []; }
}
const canWrite = token => scopesOf(token).some(p => WRITE_PERMS.includes(p));

let writeTok = null; // { key, at, exp } – token dostępu z prawem zmiany haseł, trzymany tylko w pamięci
async function writeToken(cfg){
  const key = tenantOf(cfg) + '|' + clientOf(cfg);
  if (writeTok && writeTok.key === key && writeTok.exp > Date.now() + 120000) return { ok: true, token: writeTok.at };
  if (!cfg || !cfg.refreshToken) return { ok: false, error: 'Konto administratora nie jest podłączone.', relogin: true };
  let j;
  try { ({ j } = await post(`${LOGIN}/${tenantOf(cfg)}/oauth2/v2.0/token`, { grant_type: 'refresh_token', client_id: clientOf(cfg), refresh_token: cfg.refreshToken, scope: SCOPE_WRITE })); }
  catch (e) { return { ok: false, error: 'Brak połączenia z Microsoft: ' + e.message }; }
  if (!j.access_token){
    const d = String(j.error_description || '');
    if (/AADSTS65001|AADSTS65004|AADSTS70011/.test(d)) return { ok: false, needWrite: true, error: 'Brak zgody na zmianę haseł. Włącz ją w „Kopia i ustawienia” → Microsoft 365.' };
    return { ok: false, error: aadError(j), relogin: j.error === 'invalid_grant' };
  }
  if (!canWrite(j.access_token)) return { ok: false, needWrite: true, error: 'Połączenie nie ma uprawnienia do zmiany haseł. Włącz je w „Kopia i ustawienia” → Microsoft 365.' };
  writeTok = { key, at: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return { ok: true, token: j.access_token, refreshToken: j.refresh_token || '' };
}
function forgetWrite(){ writeTok = null; }

// Ustawia nowe hasło jednego użytkownika: PATCH /users/{id} z samym passwordProfile
async function setPassword(cfg, msId, password, forceChange, tries = 3){
  if (!/^[0-9a-f-]{36}$/i.test(String(msId || ''))) return { ok: false, error: 'Konto nie jest powiązane z Microsoft 365.' };
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) return { ok: false, error: 'Hasło musi mieć od 8 do 256 znaków.' };
  const t = await writeToken(cfg);
  if (!t.ok) return { ...t, fatal: true };
  const out = x => (t.refreshToken ? { ...x, refreshToken: t.refreshToken } : x);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(`${GRAPH}/users/${encodeURIComponent(msId)}`, {
      method: 'PATCH', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordProfile: { password, forceChangePasswordNextSignIn: !!forceChange } })
    });
    if ((r.status === 429 || r.status === 503) && tries > 1){
      clearTimeout(timer);
      await new Promise(res => setTimeout(res, Math.min(30, +r.headers.get('retry-after') || 5) * 1000));
      return out(await setPassword(cfg, msId, password, forceChange, tries - 1));
    }
    if (r.status === 204 || r.ok) return out({ ok: true });
    let j = {}; try { j = await r.json(); } catch (_) {}
    const msg = String((j.error && j.error.message) || '');
    if (r.status === 401){ forgetWrite(); return out({ ok: false, fatal: true, error: 'Sesja Microsoft 365 wygasła. Spróbuj ponownie.' }); }
    if (r.status === 403) return out({ ok: false, error: 'Brak uprawnień do zmiany hasła tego użytkownika (np. inny administrator – wymaga roli administratora globalnego lub administratora uwierzytelniania uprzywilejowanego).' });
    if (r.status === 404) return out({ ok: false, error: 'Nie ma takiego użytkownika w Microsoft 365.' });
    if (r.status === 400 && /password/i.test(msg)) return out({ ok: false, error: 'Microsoft 365 odrzucił hasło (zasady haseł organizacji): ' + msg.slice(0, 160) });
    return out({ ok: false, error: 'Microsoft Graph: ' + (msg.slice(0, 200) || 'błąd ' + r.status) });
  } catch (e) {
    return out({ ok: false, error: e.name === 'AbortError' ? 'Microsoft Graph nie odpowiada.' : 'Brak połączenia z Microsoft: ' + e.message });
  } finally { clearTimeout(timer); }
}

module.exports = { loginStart, loginWait, loginCancel, sync, setPassword, forgetWrite, skuName, DEFAULT_CLIENT, PW_PERM };
