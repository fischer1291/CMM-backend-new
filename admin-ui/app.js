// Admin console. Preact + htm without a build step (served from /console).
import { html, render, useState, useEffect, useCallback } from './vendor/standalone.module.js';

// --- API -------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/admin${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.error, data });
  return data;
}

const ERRORS = {
  invalid_credentials: 'E-Mail, Passwort oder Code stimmen nicht.',
  invalid_code: 'Der Code stimmt nicht. Prüfe die Uhrzeit deines Handys.',
  wrong_setup_key: 'Der Setup-Schlüssel stimmt nicht (ADMIN_API_KEY auf Render).',
  weak_password: 'Das Passwort braucht mindestens 12 Zeichen.',
  invalid_email: 'Bitte eine gültige E-Mail-Adresse eingeben.',
  already_set_up: 'Es gibt schon einen Admin. Bitte anmelden.',
  locked: 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.',
  nothing_to_post: 'Kein verbundener Kanal, auf dem das Video noch fehlt. Verbinden unter Freigabe → Kanäle.',
};
const message = (err) => ERRORS[err.code] || (err.status === 429 ? ERRORS.locked : 'Das hat nicht geklappt. Bitte erneut versuchen.');

// --- Formatting ----------------------------------------------------------------

const nf = new Intl.NumberFormat('de-DE');
const num = (n) => (n == null ? '–' : nf.format(n));
const pct = (n) => (n == null || !isFinite(n) ? '–' : `${Math.round(n * 100)} %`);
const shortDay = (key) => `${key.slice(8, 10)}.${key.slice(5, 7)}.`;
const hours = (minutes) => (minutes >= 120 ? `${nf.format(Math.round(minutes / 60))} Std.` : `${nf.format(minutes)} Min.`);
const sum = (series, pick) => series.reduce((s, d) => s + (pick(d) || 0), 0);

// --- Pieces --------------------------------------------------------------------

function Brand() {
  return html`<div class="brand"><span class="dot"></span>Wanna yap? <span class="muted" style="font-weight:500">Admin</span></div>`;
}

function Field({ label, type = 'text', value, onInput, autocomplete, className = '', inputmode, autofocus }) {
  return html`<label class="field ${className}">
    <span>${label}</span>
    <input type=${type} value=${value} onInput=${(e) => onInput(e.target.value)} autocomplete=${autocomplete} inputmode=${inputmode} autofocus=${autofocus} required />
  </label>`;
}

/** Bars (stacked) or lines over days. */
function Chart({ title, subtitle, series, keys, type = 'bar' }) {
  const W = 600, H = 170, P = { l: 30, r: 6, t: 8, b: 20 };
  const values = series.map((d) => keys.map((k) => k.value(d) || 0));
  const max = Math.max(1, ...values.map((v) => (type === 'bar' ? v.reduce((a, b) => a + b, 0) : Math.max(...v))));
  const step = (W - P.l - P.r) / Math.max(1, series.length);
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const every = Math.ceil(series.length / 8);
  const ticks = [0, max / 2, max].map((v) => Math.round(v));
  return html`<div class="card chart">
    <h3>${title}</h3>
    ${subtitle ? html`<div class="note" style="margin-bottom:6px">${subtitle}</div>` : null}
    <div class="legend">${keys.map((k) => html`<span><i style="background:${k.color}"></i>${k.label}</span>`)}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label=${title}>
      ${ticks.map((t) => html`<g><line x1=${P.l} x2=${W - P.r} y1=${y(t)} y2=${y(t)} stroke="rgba(255,255,255,0.07)" /><text class="axis" x=${P.l - 6} y=${y(t) + 3} text-anchor="end">${num(t)}</text></g>`)}
      ${type === 'bar'
        ? series.map((d, i) => {
            let base = 0;
            return keys.map((k, j) => {
              const v = values[i][j];
              const top = y(base + v), bottom = y(base);
              base += v;
              return v ? html`<rect x=${P.l + i * step + step * 0.15} width=${step * 0.7} y=${top} height=${Math.max(0, bottom - top)} rx="2" fill=${k.color} opacity=${d.partial ? 0.55 : 1}><title>${shortDay(d.day)} · ${k.label}: ${num(v)}</title></rect>` : null;
            });
          })
        : keys.map((k, j) => html`<polyline fill="none" stroke=${k.color} stroke-width="2.2" stroke-linejoin="round" points=${series.map((d, i) => `${P.l + i * step + step / 2},${y(values[i][j])}`).join(' ')} />`)}
      ${series.map((d, i) => (i % every === 0 ? html`<text class="axis" x=${P.l + i * step + step / 2} y=${H - 4} text-anchor="middle">${shortDay(d.day)}</text>` : null))}
    </svg>
  </div>`;
}

function Kpi({ label, value, sub, color }) {
  return html`<div class="card kpi"><div class="label">${label}</div><div class="value" style=${color ? `color:${color}` : ''}>${value}</div>${sub ? html`<div class="sub">${sub}</div>` : null}</div>`;
}

// --- Sign-in -------------------------------------------------------------------

// Passkeys (Face ID / Touch ID): the backend speaks base64url, the browser ArrayBuffers
const hasPasskeys = () => typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PASSKEY_KEPT = 'yap-passkey';
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const kept = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

async function passkeyCreate(options) {
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromB64u(options.challenge),
      user: { ...options.user, id: fromB64u(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
    },
  });
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      attestationObject: toB64u(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
  };
}

async function passkeyGet(options) {
  const cred = await navigator.credentials.get({ publicKey: { ...options, challenge: fromB64u(options.challenge), allowCredentials: [] } });
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      authenticatorData: toB64u(cred.response.authenticatorData),
      signature: toB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}
// Cancelled by the person: no error to show
const cancelled = (err) => err && (err.name === 'NotAllowedError' || err.name === 'AbortError');

function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Signed in with Face ID before on this device: that first, the form on request
  const [withPassword, setWithPassword] = useState(() => !(hasPasskeys() && kept(PASSKEY_KEPT) === '1'));
  const withPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await api('/auth/passkey/options', { method: 'POST' });
      const response = await passkeyGet(options);
      const { admin } = await api('/auth/passkey/login', { method: 'POST', body: { response } });
      keep(PASSKEY_KEPT, '1');
      onDone(admin);
    } catch (err) {
      if (!cancelled(err)) setError(err.code === 'locked' ? ERRORS.locked : 'Face ID hat nicht geklappt. Ist auf diesem Gerät ein Passkey für die Konsole eingerichtet?');
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { admin } = await api('/auth/login', { method: 'POST', body: { email, password, code } });
      onDone(admin);
    } catch (err) {
      setError(message(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="center"><form class="card auth" onSubmit=${submit}>
    <${Brand} />
    <h1>Anmelden</h1>
    ${error ? html`<p class="error">${error}</p>` : null}
    ${hasPasskeys() ? html`<button type="button" class=${`btn ${withPassword ? 'ghost' : ''}`} style="width:100%;margin-bottom:12px" disabled=${busy} onClick=${withPasskey}>Mit Face ID anmelden</button>` : null}
    ${withPassword ? html`
      <p>Mit Passwort und dem Code aus deiner Authenticator-App.</p>
      <${Field} label="E-Mail" type="email" value=${email} onInput=${setEmail} autocomplete="username" autofocus />
      <${Field} label="Passwort" type="password" value=${password} onInput=${setPassword} autocomplete="current-password" />
      <${Field} label="Code" value=${code} onInput=${(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} autocomplete="one-time-code" inputmode="numeric" className="code" />
      <button class="btn" style="width:100%" disabled=${busy || code.length !== 6}>Anmelden</button>`
    : html`<button type="button" class="btn small ghost" style="width:100%" onClick=${() => setWithPassword(true)}>Mit Passwort und Code anmelden</button>`}
  </form></div>`;
}

function Setup({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupKey, setSetupKey] = useState('');
  const [code, setCode] = useState('');
  const [started, setStarted] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (e, fn) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  if (!started) {
    return html`<div class="center"><form class="card auth" onSubmit=${(e) => run(e, async () => setStarted(await api('/auth/setup', { method: 'POST', body: { email, password, setupKey } })))}>
      <${Brand} />
      <h1>Einrichten</h1>
      <p>Lege dein Admin-Konto an. Den Setup-Schlüssel findest du auf Render unter Environment → ADMIN_API_KEY.</p>
      ${error ? html`<p class="error">${error}</p>` : null}
      <${Field} label="E-Mail" type="email" value=${email} onInput=${setEmail} autocomplete="username" autofocus />
      <${Field} label="Passwort (mind. 12 Zeichen)" type="password" value=${password} onInput=${setPassword} autocomplete="new-password" />
      <${Field} label="Setup-Schlüssel" type="password" value=${setupKey} onInput=${setSetupKey} autocomplete="off" />
      <button class="btn" style="width:100%" disabled=${busy}>Weiter</button>
    </form></div>`;
  }

  return html`<div class="center"><form class="card auth" onSubmit=${(e) => run(e, async () => onDone((await api('/auth/setup/confirm', { method: 'POST', body: { email, password, code } })).admin))}>
    <${Brand} />
    <h1>Zwei-Faktor</h1>
    <p>Scanne den QR-Code mit einer Authenticator-App (z. B. 1Password, Google Authenticator) und gib den Code ein.</p>
    <div class="qr" dangerouslySetInnerHTML=${{ __html: started.qr }}></div>
    <p class="note">Oder den Schlüssel von Hand eingeben:</p>
    <div class="secret">${started.secret}</div>
    <div style="height:16px"></div>
    ${error ? html`<p class="error">${error}</p>` : null}
    <${Field} label="Code" value=${code} onInput=${(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} autocomplete="one-time-code" inputmode="numeric" className="code" autofocus />
    <button class="btn" style="width:100%" disabled=${busy || code.length !== 6}>Fertig</button>
  </form></div>`;
}

// --- Dashboard -----------------------------------------------------------------

function Retention() {
  const [cohorts, setCohorts] = useState(null);
  useEffect(() => {
    api('/metrics/retention?weeks=8').then((d) => setCohorts(d.cohorts)).catch(() => setCohorts([]));
  }, []);
  if (!cohorts) return html`<div class="card note">Lade Kohorten …</div>`;
  const max = Math.max(0, ...cohorts.map((c) => c.weeks.length));
  return html`<div class="card scroll">
    <table>
      <thead><tr><th>Anmeldewoche</th><th>Neu</th><th title="Mindestens ein Gespräch in den ersten 7 Tagen">Aktiviert</th><th>Laden ein</th><th>Über Einladung</th><th title="Über diese Woche dazugekommene Menschen pro Person">K</th>${Array.from({ length: max }, (_, i) => html`<th style="text-align:center">Woche ${i + 1}</th>`)}</tr></thead>
      <tbody>${cohorts.map((c) => html`<tr>
        <td>ab ${shortDay(c.week)}</td><td>${num(c.size)}</td>
        <td class="cell" style=${c.activated == null ? '' : `background:rgba(255,46,147,${0.06 + c.activated * 0.4})`}>${c.activated == null ? '–' : pct(c.activated)}</td>
        <td class="cell">${c.inviters == null ? '–' : pct(c.inviters)}</td>
        <td class="cell">${c.viaInvite == null ? '–' : pct(c.viaInvite)}</td>
        <td class="cell">${c.k == null ? '–' : c.k.toFixed(2).replace('.', ',')}</td>
        ${Array.from({ length: max }, (_, i) => {
          const v = c.weeks[i];
          return html`<td class="cell" style=${v == null ? '' : `background:rgba(0,229,255,${0.06 + v * 0.4})`}>${v == null ? '' : pct(v)}</td>`;
        })}
      </tr>`)}</tbody>
    </table>
    <p class="note" style="margin:10px 0 0">Aktiviert: Anteil mit mindestens einem Gespräch in den ersten 7 Tagen (Ziel vor bezahlter Werbung: über 40 %; gezählt, sobald die 7 Tage um sind). Laden ein: hat mindestens eine Einladung verschickt. K: Menschen, die diese Woche bisher über Einladungen mitgebracht hat, pro Person (ab 1 wächst die App von allein). Wochen: Anteil, der in den Folgewochen die App genutzt oder telefoniert hat.</p>
  </div>`;
}

function AppErrors() {
  const [errors, setErrors] = useState(null);
  useEffect(() => {
    api('/errors').then((d) => setErrors(d.errors)).catch(() => setErrors([]));
  }, []);
  if (!errors) return html`<div class="card note">Lade Fehler …</div>`;
  if (!errors.length) return html`<div class="card note">Keine App-Fehler in den letzten 30 Tagen.</div>`;
  return html`<div class="card scroll">
    <table>
      <thead><tr><th>Fehler</th><th>Anzahl</th><th>Zuletzt</th><th>Versionen</th></tr></thead>
      <tbody>${errors.map((e) => html`<tr>
        <td><details><summary>${e.fatal ? html`<span class="pill warn">Absturz</span> ` : null}${e.message}</summary><pre style="white-space:pre-wrap;font-size:11px">${e.stack}</pre></details></td>
        <td>${num(e.count)}</td>
        <td>${new Date(e.lastAt).toLocaleString('de-DE')}</td>
        <td>${e.versions.join(', ')}</td>
      </tr>`)}</tbody>
    </table>
    <p class="note" style="margin:10px 0 0">JavaScript-Fehler aus der App, ohne Personenbezug gruppiert. Native Abstürze stehen in Xcode → Organizer.</p>
  </div>`;
}

/** Today so far, next to the whole same weekday last week, and what is waiting. */
function Today({ onGo }) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/today').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return null;
  const t = data.today;
  const w = data.lastWeekDay;
  const delta = (a, b) => {
    const d = a - b;
    return d > 0 ? html`<span class="delta up">▲ ${num(d)}</span>` : d < 0 ? html`<span class="delta down">▼ ${num(-d)}</span>` : html`<span class="delta">±0</span>`;
  };
  const tile = (label, key, sub) => html`<div class="tile"><div class="label">${label}</div><div class="value">${num(t[key])}</div><div class="sub">${delta(t[key], w[key])} <span class="muted">Vorwoche ${num(w[key])}</span>${sub ? html`<br />${sub}` : null}</div></div>`;
  const todo = data.todo
    ? [['approvals', 'Freigabe', 'approvals'], ['support', 'Support', 'support'], ['reports', 'Meldungen', 'reports']].filter(([k]) => data.todo[k] !== null && data.todo[k] !== undefined)
    : [];
  return html`<div class="card today">
    <div class="inline" style="justify-content:space-between;margin-bottom:8px">
      <div class="label" style="margin:0">Heute</div>
      <span class="note">bis jetzt, verglichen mit dem ganzen ${shortDay(data.lastWeek)}</span>
    </div>
    ${todo.length ? html`<div class="todo-row">${todo.map(([k, label, tab]) => html`<button class=${`pill ${data.todo[k] ? 'warn' : ''}`} onClick=${() => onGo(tab)}>${label}: ${num(data.todo[k])}</button>`)}</div>` : null}
    <div class="today-grid">
      ${tile('Neue Nutzer', 'newUsers')}
      ${tile('Aktiv', 'active')}
      ${tile('Gespräche', 'talks', html`<span class="muted">${num(t.talkMinutes)} Min.</span>`)}
      ${tile('Website', 'visits')}
      ${tile('Warteliste', 'waitlist')}
    </div>
    ${data.sms ? html`<p class="note" style="margin:8px 0 0">SMS heute ${num(data.sms.started)} von ${num(data.sms.cap)}${data.sms.paused ? ' · pausiert' : ''} (App → Betrieb)</p>` : null}
  </div>`;
}

function Dashboard({ onGo }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    setError(false);
    api(`/metrics?days=${days}`).then(setData).catch(() => setError(true));
  }, [days]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !data) return html`<div class="card">Die Zahlen konnten nicht geladen werden. <button class="btn small ghost" onClick=${load}>Erneut</button></div>`;
  if (!data) return html`<div class="card note">Lade Zahlen …</div>`;

  const s = data.series;
  const today = s.at(-1) || {};
  const users = today.users || {};
  const calls = { started: sum(s, (d) => d.calls?.started), answered: sum(s, (d) => d.calls?.answered) };
  const talkMinutes = sum(s, (d) => d.talks?.minutes) + sum(s, (d) => d.circles?.roomMinutes);
  const newUsers = sum(s, (d) => d.users?.new);
  const viaInvite = sum(s, (d) => d.growth?.joinedViaInvite);
  const now = data.now;

  return html`
    <${Today} onGo=${onGo} />
    <div class="now">
      <span class="pill">Jetzt erreichbar: ${num(now.availableNow)}</span>
      <span class="pill">Offene Runden: ${num(now.activeRooms)}</span>
      <span class="pill">Push-Tokens: ${num(now.pushTokens)} · VoIP: ${num(now.voipTokens)}</span>
      <span class="pill ${now.openReports ? 'warn' : ''}">Offene Meldungen: ${num(now.openReports)}</span>
      <span class="spacer"></span>
      <div class="tabs">${[7, 30, 90].map((d) => html`<button class=${d === days ? 'on' : ''} onClick=${() => setDays(d)}>${d} Tage</button>`)}</div>
    </div>

    <div class="kpis">
      <${Kpi} label="Nutzer" value=${num(users.total)} sub=${`+${num(newUsers)} in ${days} Tagen`} />
      <${Kpi} label="Aktiv heute" value=${num(users.dau)} sub=${`Woche ${num(users.wau)} · Monat ${num(users.mau)}`} color="var(--cyan)" />
      <${Kpi} label="Stickiness" value=${pct(users.mau ? users.dau / users.mau : null)} sub="aktiv heute / aktiv im Monat" />
      <${Kpi} label="Gesprächszeit" value=${hours(talkMinutes)} sub=${`${num(sum(s, (d) => d.talks?.count))} Gespräche`} color="var(--pink)" />
      <${Kpi} label="Annahmequote" value=${pct(calls.started ? calls.answered / calls.started : null)} sub=${`${num(calls.answered)} von ${num(calls.started)} Anrufen`} />
      <${Kpi} label="Kreise" value=${num(today.circles?.total)} sub=${`${num(sum(s, (d) => d.circles?.rooms))} Runden im Zeitraum`} color="var(--violet)" />
      <${Kpi} label="Über Einladungen" value=${pct(newUsers ? viaInvite / newUsers : null)} sub=${`${num(viaInvite)} von ${num(newUsers)} Neuen`} />
      <${Kpi} label="Momente" value=${num(sum(s, (d) => d.rituals?.moments))} sub=${`Täglicher Moment: ${num(sum(s, (d) => d.rituals?.dailyJoined))} dabei`} />
    </div>

    <div class="grid2">
      <${Chart} title="Aktive Nutzer" type="line" series=${s} keys=${[
        { label: 'pro Tag', color: 'var(--cyan)', value: (d) => d.users?.dau },
        { label: 'letzte 7 Tage', color: 'var(--violet)', value: (d) => d.users?.wau },
      ]} subtitle="Zählt ab Phase 10; vorher leer" />
      <${Chart} title="Neue Nutzer" series=${s} keys=${[
        { label: 'über Einladung', color: 'var(--pink)', value: (d) => d.growth?.joinedViaInvite },
        { label: 'direkt', color: 'var(--violet)', value: (d) => (d.users?.new || 0) - (d.growth?.joinedViaInvite || 0) },
      ]} />
      <${Chart} title="Anrufe" series=${s} keys=${[
        { label: 'angenommen', color: 'var(--success)', value: (d) => d.calls?.answered },
        { label: 'verpasst', color: 'var(--warning)', value: (d) => d.calls?.missed },
        { label: 'abgelehnt', color: 'var(--danger)', value: (d) => d.calls?.declined },
        { label: 'besetzt/abgebrochen', color: 'var(--muted)', value: (d) => (d.calls?.busy || 0) + (d.calls?.cancelled || 0) },
      ]} subtitle="Rohdaten 30 Tage, danach aus den Tages-Snapshots" />
      <${Chart} title="Gesprächsminuten" series=${s} keys=${[
        { label: 'zu zweit', color: 'var(--pink)', value: (d) => d.talks?.minutes },
        { label: 'in Runden', color: 'var(--violet)', value: (d) => d.circles?.roomMinutes },
      ]} />
      <${Chart} title="Rituale" series=${s} keys=${[
        { label: 'Täglicher Moment', color: 'var(--cyan)', value: (d) => d.rituals?.dailyJoined },
        { label: 'Runden', color: 'var(--violet)', value: (d) => d.circles?.rooms },
        { label: 'Anstupser', color: 'var(--pink)', value: (d) => d.rituals?.nudges },
      ]} />
      <${Chart} title="Push-Benachrichtigungen" series=${s} keys=${[
        { label: 'gesendet', color: 'var(--cyan)', value: (d) => d.push?.sent },
        { label: 'bewusst nicht gesendet', color: 'var(--muted)', value: (d) => d.push?.skipped },
        { label: 'fehlgeschlagen', color: 'var(--danger)', value: (d) => d.push?.failed },
      ]} subtitle="Rohdaten 3 Tage, danach aus den Tages-Snapshots" />
    </div>

    <div class="section">Bleiben die Leute?</div>
    <${Retention} />
    <div class="section">App-Fehler</div>
    <${AppErrors} />
    <p class="note" style="margin-top:20px">Stand ${new Date(today.computedAt || Date.now()).toLocaleTimeString('de-DE')} · Tage nach ${data.zone} · heute noch unvollständig (blassere Balken)</p>
  `;
}

function Audit() {
  const [entries, setEntries] = useState(null);
  useEffect(() => {
    api('/audit').then((d) => setEntries(d.entries)).catch(() => setEntries([]));
  }, []);
  if (!entries) return html`<div class="card note">Lade Protokoll …</div>`;
  return html`<div class="card scroll"><table>
    <thead><tr><th>Zeit</th><th>Admin</th><th>Aktion</th><th>Betrifft</th><th>IP</th></tr></thead>
    <tbody>${entries.map((e) => html`<tr><td>${new Date(e.at).toLocaleString('de-DE')}</td><td>${e.admin}</td><td>${e.action}</td><td>${e.target || ''}</td><td class="muted">${e.ip || ''}</td></tr>`)}</tbody>
  </table>${entries.length ? null : html`<p class="note">Noch keine Einträge.</p>`}</div>`;
}


// --- Users -------------------------------------------------------------------------

const PLATFORM = { ios: 'iOS', android: 'Android' };
const dateTime = (d) => (d ? new Date(d).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const date = (d) => (d ? new Date(d).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : '–');
const PLUS_SOURCES = { store: 'App Store', sandbox: 'Sandbox (Tester)', admin: 'vergeben', gift: 'Geschenk' };
const REASONS = { spam: 'Spam', harassment: 'Belästigung', inappropriate: 'Unangemessen', other: 'Sonstiges' };
const RESOLUTIONS = { dismiss: 'Verworfen', hide_moment: 'Moment ausgeblendet', delete_moment: 'Moment gelöscht', suspend: 'Gesperrt', ban: 'Gebannt' };

function Avatar({ name, url, size = 36 }) {
  const initials = (name || '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return url
    ? html`<img class="avatar" src=${url} width=${size} height=${size} alt="" />`
    : html`<span class="avatar" style="width:${size}px;height:${size}px">${initials}</span>`;
}

function StatusPill({ user }) {
  if (user.suspendedUntil) return html`<span class="pill warn">gesperrt bis ${date(user.suspendedUntil)}</span>`;
  if (user.isAvailable) return html`<span class="pill on">erreichbar</span>`;
  return null;
}

function Users({ onOpen }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState(null);
  const search = useCallback((query) => {
    api(`/users?q=${encodeURIComponent(query)}`).then((d) => setUsers(d.users)).catch(() => setUsers([]));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => search(q), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, search]);
  return html`
    <div class="searchbar"><input placeholder="Name oder Nummer suchen …" value=${q} onInput=${(e) => setQ(e.target.value)} autofocus /></div>
    <div class="card scroll" style="padding:6px 8px">
      ${!users ? html`<p class="note">Lade …</p>` : users.length === 0 ? html`<p class="note" style="padding:10px">Niemand gefunden.</p>` : html`<table class="rows">
        <thead><tr><th></th><th>Name</th><th>Nummer</th><th>Dabei seit</th><th>Zuletzt online</th><th>Gerät</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr class="click" onClick=${() => onOpen(u.id)}>
          <td style="width:44px"><${Avatar} name=${u.name} url=${u.avatarUrl} /></td>
          <td><strong>${u.name || html`<span class="muted">ohne Namen</span>`}</strong></td>
          <td class="muted">${u.phone}</td>
          <td>${date(u.createdAt)}</td>
          <td>${dateTime(u.lastOnline)}</td>
          <td>${PLATFORM[u.platform] || '–'}</td>
          <td><${StatusPill} user=${u} /></td>
        </tr>`)}</tbody></table>`}
    </div>
    <p class="note">${q ? 'Bis zu 25 Treffer.' : 'Die 25 neuesten Nutzer.'} Nummern sind maskiert; ganze Nummern nur über „Nummer anzeigen“ (wird protokolliert).</p>`;
}

function ActivityDots({ days }) {
  const set = new Set(days);
  const today = new Date();
  const keys = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(today.getTime() - (27 - i) * 864e5);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  });
  return html`<div class="dots">${keys.map((k) => html`<span class=${set.has(k) ? 'on' : ''} title=${k}></span>`)}</div>`;
}

function Row({ label, children }) {
  return html`<div class="kv"><span>${label}</span><span>${children}</span></div>`;
}

function UserDetail({ id, role, onBack, onChanged, onMoments }) {
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [phone, setPhone] = useState(null);
  const [busy, setBusy] = useState(null);
  const [flash, setFlash] = useState(null);
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api(`/users/${id}`).then((d) => setUser(d.user)).catch((e) => setError(e.status === 404 ? 'Dieses Konto gibt es nicht (mehr).' : 'Konnte nicht geladen werden.'));
  }, [id]);
  useEffect(load, [load]);

  const act = async (key, path, body, done) => {
    setBusy(key);
    setFlash(null);
    try {
      const res = await api(`/users/${id}${path}`, { method: 'POST', body });
      setFlash(done(res));
      if (key === 'ban' || key === 'delete') return onChanged();
      load();
    } catch (err) {
      setFlash(`Fehler: ${err.code || err.message}`);
    } finally {
      setBusy(null);
    }
  };

  if (error) return html`<div><button class="btn small ghost" onClick=${onBack}>← Zurück</button><p class="card" style="margin-top:12px">${error}</p></div>`;
  if (!user) return html`<p class="note">Lade …</p>`;
  const calls = user.last30.calls || {};
  const callsTotal = Object.values(calls).reduce((a, b) => a + b, 0);
  const PUSH_RESULTS = { sent: 'gesendet', no_token: 'kein Token', invalid_token: 'Token ungültig' };

  return html`
    <button class="btn small ghost" onClick=${onBack}>← Alle Nutzer</button>
    <div class="profile">
      <${Avatar} name=${user.name} url=${user.avatarUrl} size=${64} />
      <div style="flex:1">
        <h2>${user.name || 'ohne Namen'} <${StatusPill} user=${user} /></h2>
        <div class="muted">${phone || user.phone}
          ${phone ? null : html` · <a href="#" onClick=${async (e) => { e.preventDefault(); setPhone((await api(`/users/${id}/reveal`, { method: 'POST' })).phone); }}>Nummer anzeigen</a>`}
        </div>
      </div>
    </div>
    ${flash ? html`<div class="flash">${flash}</div>` : null}

    <div class="grid3">
      <div class="card">
        <div class="label">Konto</div>
        <${Row} label="Dabei seit">${date(user.createdAt)}<//>
        <${Row} label="Zuletzt online">${dateTime(user.lastOnline)}<//>
        <${Row} label="Zeitzone">${user.timezone || '–'}<//>
        <${Row} label="Plan">${user.plan === 'plus' ? html`<span class="pill on">Plus</span> ${user.plus?.until ? `bis ${date(user.plus.until)}` : 'ohne Ende'} · ${PLUS_SOURCES[user.plus?.source] || ''}` : 'Gratis'}${user.plusInterest ? html` · <span class="muted">Interesse ${date(user.plusInterest.at)}</span>` : null}<//>
        <${Row} label="App">${user.app ? `${user.app.version} (Build ${user.app.build || '?'})${user.app.os ? ` · ${PLATFORM[user.app.platform] || ''} ${user.app.os}` : ''}` : '–'}<//>
        <${Row} label="Über Einladung">${user.joinedViaInvite ? 'ja' : 'nein'}<//>
        <${Row} label="Kontakte in der App">${num(user.contacts)}<//>
        <${Row} label="Hat eingeladen">${num(user.invitesJoined)}<//>
        ${user.suspendReason ? html`<${Row} label="Sperrgrund">${user.suspendReason}<//>` : null}
      </div>
      <div class="card">
        <div class="label">Benachrichtigungen</div>
        <${Row} label="Gerät">${PLATFORM[user.platform] || '–'}<//>
        <${Row} label="Push-Token">${user.push.expo ? `ja, seit ${date(user.push.expoRegisteredAt)}` : html`<span class="bad">fehlt</span>`}<//>
        <${Row} label="Anruf-Push (VoIP)">${user.push.voip ? user.push.voipEnvironment || 'ja' : html`<span class="bad">fehlt</span>`}<//>
        ${user.push.prefs ? html`<${Row} label="Aus">${['available', 'nudges', 'moments', 'dailyMoment'].filter((k) => user.push.prefs[k] === false).join(', ') || 'nichts'}<//>
        <${Row} label="Ruhezeiten">${user.push.prefs.quietHours?.enabled ? 'an' : 'aus'}<//>` : null}
      </div>
      <div class="card">
        <div class="label">Letzte 30 Tage</div>
        <${Row} label="Gespräche">${num(user.last30.talks)} · ${hours(user.last30.talkMinutes)}<//>
        <${Row} label="In Runden">${hours(user.last30.roomMinutes)}<//>
        <${Row} label="Anrufe">${num(callsTotal)} (${num(calls.ended || 0)} geführt, ${num(calls.missed || 0)} verpasst)<//>
        <div class="kv"><span>Aktiv (28 Tage)</span><span></span></div>
        <${ActivityDots} days=${user.last30.activeDays} />
      </div>
    </div>

    <div class="grid3">
      <div class="card">
        <div class="label">Kreise</div>
        ${user.circles.length ? user.circles.map((c) => html`<${Row} label=${`${c.emoji} ${c.name}`}>${c.members} Mitglieder<//>`) : html`<p class="note">Keine Kreise.</p>`}
      </div>
      <div class="card">
        <div class="label">Sicherheit</div>
        <${Row} label="Meldungen gegen">${num(user.safety.reportsAgainst.length)}<//>
        <${Row} label="Hat gemeldet">${num(user.safety.reportsBy)}<//>
        <${Row} label="Blockiert von">${num(user.safety.blockedBy)}<//>
        <${Row} label="Blockiert selbst">${num(user.safety.blocking)}<//>
        <${Row} label="Momente">${num(user.safety.moments)} ${user.safety.moments ? html`· <a href="#" onClick=${(e) => { e.preventDefault(); onMoments({ id, name: user.name }); }}>ansehen</a>` : null}<//>
        ${user.safety.reportsAgainst.slice(0, 5).map((r) => html`<div class="note">• ${REASONS[r.reason] || r.reason}${r.note ? `: „${r.note}“` : ''} · ${date(r.createdAt)} · ${r.status === 'open' ? 'offen' : RESOLUTIONS[r.resolution] || 'erledigt'}</div>`)}
      </div>
      <div class="card actions">
        <div class="label">Aktionen</div>
        <button class="btn small ghost" disabled=${busy} onClick=${() => act('push', '/test-push', null, (r) => `Test-Push: ${PUSH_RESULTS[r.result] || r.result}`)}>Test-Push senden</button>
        <button class="btn small ghost" disabled=${busy} onClick=${() => confirm('Push-Tokens löschen? Die App meldet sich beim nächsten Start neu an.') && act('reset', '/reset-push', null, () => 'Push-Tokens zurückgesetzt.')}>Push-Tokens zurücksetzen</button>
        <button class="btn small ghost" disabled=${busy} onClick=${() => confirm('Auf allen Geräten abmelden?') && act('logout', '/logout', null, () => 'Überall abgemeldet.')}>Überall abmelden</button>
        ${user.suspendedUntil
          ? html`<button class="btn small ghost" disabled=${busy} onClick=${() => act('unsuspend', '/unsuspend', null, () => 'Sperre aufgehoben.')}>Sperre aufheben</button>`
          : html`<div class="inline">
              <select value=${days} onChange=${(e) => setDays(e.target.value)}>${['1', '3', '7', '30', '90'].map((d) => html`<option value=${d}>${d} ${d === '1' ? 'Tag' : 'Tage'}</option>`)}</select>
              <input placeholder="Grund (intern)" value=${reason} onInput=${(e) => setReason(e.target.value)} />
              <button class="btn small danger" disabled=${busy} onClick=${() => confirm(`${user.name || 'Konto'} für ${days} Tage sperren? Die Person wird abgemeldet.`) && act('suspend', '/suspend', { days: Number(days), reason }, (r) => `Gesperrt bis ${date(r.suspendedUntil)}.`)}>Sperren</button>
            </div>`}
        ${role === 'owner' ? html`<a class="btn small ghost" href=${`/admin/users/${id}/export`} download>Daten exportieren (DSGVO)</a>` : null}
        ${role === 'owner' ? (user.plan === 'plus' && user.plus?.source !== 'store'
          ? html`<button class="btn small ghost" disabled=${busy} onClick=${() => confirm('Plus entziehen?') && act('plus', '/plus', { revoke: true }, () => 'Plus entzogen.')}>Plus entziehen</button>`
          : user.plan !== 'plus' ? html`<button class="btn small ghost" disabled=${busy} onClick=${() => { const d = prompt('Plus für wie viele Tage? (leer = ohne Ende)', '30'); if (d !== null) act('plus', '/plus', { days: d.trim() ? Number(d) : null }, () => 'Plus vergeben.'); }}>Plus vergeben</button>` : null) : null}
        ${role === 'owner' ? html`
          <button class="btn small danger" disabled=${busy} onClick=${() => { const c = prompt('Konto endgültig löschen (z. B. auf Wunsch per E-Mail). Zum Bestätigen LÖSCHEN eingeben:'); if (c) act('delete', '/delete', { confirm: c }, () => 'Konto gelöscht.'); }}>Konto löschen</button>
          <button class="btn small danger" disabled=${busy} onClick=${() => { const c = prompt('Konto löschen UND Nummer dauerhaft sperren. Zum Bestätigen SPERREN eingeben:'); if (c) act('ban', '/ban', { confirm: c, reason }, () => 'Gebannt.'); }}>Bannen</button>` : null}
      </div>
    </div>

    <div class="section">Push-Protokoll <span class="note">(letzte 3 Tage)</span></div>
    <div class="card scroll">${user.pushLog.length ? html`<table>
      <thead><tr><th>Zeit</th><th>Art</th><th>Ergebnis</th><th>App</th><th>Zustellung</th><th>Betrifft</th></tr></thead>
      <tbody>${user.pushLog.map((p) => html`<tr><td>${dateTime(p.at)}</td><td>${p.type}</td><td class=${p.result === 'sent' ? '' : 'muted'}>${p.result}</td><td>${p.app || ''}</td><td class=${p.delivery && p.delivery !== 'delivered' ? 'bad' : ''}>${p.delivery || ''}</td><td class="muted">${p.about || ''}</td></tr>`)}</tbody>
    </table>` : html`<p class="note">Keine Benachrichtigungen in den letzten 3 Tagen.</p>`}</div>`;
}

// --- Reports -----------------------------------------------------------------------

function Reports({ role, onOpenUser, onCount }) {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(() => {
    api(`/reports?status=${status}`).then((d) => {
      setReports(d.reports);
      if (status === 'open') onCount(d.reports.length);
    }).catch(() => setReports([]));
  }, [status]);
  useEffect(() => {
    setReports(null);
    load();
  }, [load]);

  const resolve = async (r, action, extra = {}) => {
    setBusy(r.id);
    try {
      await api(`/reports/${r.id}/resolve`, { method: 'POST', body: { action, ...extra } });
      load();
    } catch (err) {
      alert(`Fehler: ${err.code || err.message}`);
    } finally {
      setBusy(null);
    }
  };

  return html`
    <div class="now"><div class="tabs">
      <button class=${status === 'open' ? 'on' : ''} onClick=${() => setStatus('open')}>Offen</button>
      <button class=${status === 'resolved' ? 'on' : ''} onClick=${() => setStatus('resolved')}>Erledigt</button>
    </div></div>
    ${!reports ? html`<p class="note">Lade …</p>` : reports.length === 0 ? html`<div class="card"><p class="note" style="margin:0">${status === 'open' ? 'Keine offenen Meldungen. 🎉' : 'Noch nichts erledigt.'}</p></div>` : html`<div class="reports">
      ${reports.map((r) => html`<div class="card report">
        ${r.moment && !r.moment.deleted ? html`<img class="shot" src=${r.moment.screenshot} alt="Gemeldeter Moment" />` : null}
        <div style="flex:1;min-width:0">
          <div><span class="pill warn">${REASONS[r.reason] || r.reason}</span> <span class="note">${dateTime(r.createdAt)}</span></div>
          <p style="margin:10px 0 6px">
            <a href="#" onClick=${(e) => { e.preventDefault(); r.reporter.id && onOpenUser(r.reporter.id); }}>${r.reporter.name || r.reporter.phone}</a>${' meldet '}<a href="#" onClick=${(e) => { e.preventDefault(); r.reported.id && onOpenUser(r.reported.id); }}><strong>${r.reported.name || r.reported.phone}</strong></a>${' '}<span class="note">(${r.reported.reportsAgainst} ${r.reported.reportsAgainst === 1 ? 'Meldung' : 'Meldungen'} insgesamt)</span>
          </p>
          ${r.note ? html`<p class="quote">„${r.note}“</p>` : null}
          ${r.moment ? html`<p class="note">${r.moment.deleted ? 'Moment bereits gelöscht' : `Moment${r.moment.note ? `: „${r.moment.note}“` : ''}${r.moment.hidden ? ' · ausgeblendet' : ''}`}</p>` : null}
          ${r.status === 'open' ? html`<div class="inline" style="margin-top:12px">
            <button class="btn small ghost" disabled=${busy} onClick=${() => resolve(r, 'dismiss')}>Verwerfen</button>
            ${r.moment && !r.moment.deleted ? html`
              <button class="btn small ghost" disabled=${busy} onClick=${() => resolve(r, 'hide_moment')}>Moment ausblenden</button>
              <button class="btn small ghost" disabled=${busy} onClick=${() => confirm('Moment endgültig löschen?') && resolve(r, 'delete_moment')}>Moment löschen</button>` : null}
            <button class="btn small danger" disabled=${busy} onClick=${() => { const d = prompt('Für wie viele Tage sperren?', '7'); if (d) resolve(r, 'suspend', { days: Number(d) }); }}>Sperren …</button>
            ${role === 'owner' ? html`<button class="btn small danger" disabled=${busy} onClick=${() => confirm(`${r.reported.name || 'Konto'} löschen und die Nummer dauerhaft sperren?`) && resolve(r, 'ban')}>Bannen</button>` : null}
          </div>` : html`<p class="note">${RESOLUTIONS[r.resolution] || 'Erledigt'} von ${r.resolvedBy || '–'} · ${dateTime(r.resolvedAt)}</p>`}
        </div>
      </div>`)}
    </div>`}`;
}


// --- Support tickets ---------------------------------------------------------------

const CATEGORIES = { bug: 'Fehler', idea: 'Idee', account: 'Konto', other: 'Sonstiges' };
const TICKET_STATUS = { open: 'Offen', answered: 'Beantwortet', closed: 'Geschlossen' };

function Tickets({ openId, onOpen, onOpenUser, onCount }) {
  const [status, setStatus] = useState('open');
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    api(`/tickets?status=${status}`).then((d) => {
      setData(d);
      onCount(d.counts.open || 0);
    }).catch(() => setData({ tickets: [], counts: {} }));
  }, [status]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  if (openId) return html`<${Ticket} id=${openId} onBack=${() => { onOpen(null); load(); }} onOpenUser=${onOpenUser} />`;
  return html`
    <div class="now"><div class="tabs">${Object.entries(TICKET_STATUS).map(([k, label]) => html`<button class=${status === k ? 'on' : ''} onClick=${() => setStatus(k)}>${label}${data?.counts?.[k] ? html` <span class="muted">${data.counts[k]}</span>` : null}</button>`)}</div></div>
    ${!data ? html`<p class="note">Lade …</p>` : data.tickets.length === 0 ? html`<div class="card"><p class="note" style="margin:0">${status === 'open' ? 'Keine offenen Anfragen. 🎉' : 'Nichts hier.'}</p></div>` : html`<div class="card scroll" style="padding:6px 8px"><table class="rows">
      <thead><tr><th></th><th>Von</th><th>Art</th><th>Letzte Nachricht</th><th>App</th><th>Aktualisiert</th></tr></thead>
      <tbody>${data.tickets.map((t) => html`<tr class="click" onClick=${() => onOpen(t.id)}>
        <td style="width:44px"><${Avatar} name=${t.user.name} url=${t.user.avatarUrl} /></td>
        <td><strong>${t.user.name || t.user.phone}</strong></td>
        <td><span class="pill">${CATEGORIES[t.category]}</span></td>
        <td class="preview">${t.lastFrom === 'support' ? html`<span class="muted">Du: </span>` : null}${t.preview}</td>
        <td class="muted">${t.app?.version ? `${t.app.version} (${t.app.build || '?'})` : '–'}</td>
        <td>${dateTime(t.updatedAt)}</td>
      </tr>`)}</tbody></table></div>`}`;
}

function Ticket({ id, onBack, onOpenUser }) {
  const [ticket, setTicket] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api(`/tickets/${id}`).then((d) => setTicket(d.ticket)).catch(() => setTicket(false)), [id]);
  useEffect(() => { load(); }, [load]);

  const reply = async (close) => {
    setBusy(true);
    try {
      const d = await api(`/tickets/${id}/reply`, { method: 'POST', body: { text, close } });
      setTicket(d.ticket);
      setText('');
    } catch (err) {
      alert(`Fehler: ${err.code || err.message}`);
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (status) => {
    await api(`/tickets/${id}/status`, { method: 'POST', body: { status } }).catch(() => {});
    load();
  };

  if (ticket === false) return html`<button class="btn small ghost" onClick=${onBack}>← Zurück</button><p class="card">Nicht gefunden.</p>`;
  if (!ticket) return html`<p class="note">Lade …</p>`;
  const app = ticket.app || {};
  return html`
    <button class="btn small ghost" onClick=${onBack}>← Alle Anfragen</button>
    <div class="profile">
      <${Avatar} name=${ticket.user.name} url=${ticket.user.avatarUrl} size=${56} />
      <div style="flex:1">
        <h2>${ticket.user.name || ticket.user.phone} <span class="pill">${CATEGORIES[ticket.category]}</span> <span class="pill ${ticket.status === 'open' ? 'warn' : ''}">${TICKET_STATUS[ticket.status]}</span></h2>
        <div class="muted">
          App ${app.version || '?'} (Build ${app.build || '?'}) · ${PLATFORM[app.platform] || app.platform || '?'} ${app.os || ''}
          ${ticket.currentApp?.version && ticket.currentApp.build !== app.build ? ` · jetzt ${ticket.currentApp.version} (${ticket.currentApp.build})` : ''}
          ${ticket.user.id ? html` · <a href="#" onClick=${(e) => { e.preventDefault(); onOpenUser(ticket.user.id); }}>Nutzerseite</a>` : null}
        </div>
      </div>
      ${ticket.status === 'closed' ? html`<button class="btn small ghost" onClick=${() => setStatus('open')}>Wieder öffnen</button>` : html`<button class="btn small ghost" onClick=${() => setStatus('closed')}>Schließen</button>`}
    </div>
    <div class="thread">
      ${ticket.messages.map((m) => html`<div class="msg ${m.from}">
        <div>${m.text}</div>
        <div class="note">${m.from === 'support' ? m.by || 'Support' : ticket.user.name || 'Nutzer'} · ${dateTime(m.at)}</div>
      </div>`)}
    </div>
    <div class="card reply">
      <textarea rows="4" placeholder="Antwort schreiben … (die Person bekommt eine Push-Benachrichtigung)" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      <div class="inline" style="justify-content:flex-end">
        <button class="btn small ghost" disabled=${busy || !text.trim()} onClick=${() => reply(true)}>Antworten & schließen</button>
        <button class="btn small" disabled=${busy || !text.trim()} onClick=${() => reply(false)}>Antworten</button>
      </div>
    </div>`;
}

// --- App settings --------------------------------------------------------------------

function AppSettings({ role }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [flash, setFlash] = useState(null);
  const [newFlag, setNewFlag] = useState('');
  const load = useCallback(() => {
    api('/config').then((d) => {
      setData(d);
      const c = d.config;
      setForm({
        minVersion: c.minVersion || '',
        minBuild: c.minBuild ? String(c.minBuild) : '',
        updateUrl: c.updateUrl || '',
        banner: { enabled: !!c.banner?.enabled, text: c.banner?.text || '', level: c.banner?.level || 'info', until: c.banner?.until ? c.banner.until.slice(0, 16) : '' },
        flags: { ...(c.flags || {}) },
        ops: { smsPerDay: String(c.ops?.smsPerDay ?? 100), smsPaused: !!c.ops?.smsPaused, smsRegions: (c.ops?.smsRegions || ['DE', 'AT', 'CH']).join(', ') },
      });
    }).catch(() => setData(false));
  }, []);
  useEffect(load, [load]);

  if (data === false) return html`<div class="card">Konnte nicht geladen werden.</div>`;
  if (!form) return html`<p class="note">Lade …</p>`;
  const owner = role === 'owner';
  const set = (patch) => setForm({ ...form, ...patch });
  const save = async () => {
    setFlash(null);
    try {
      await api('/config', {
        method: 'PUT',
        body: {
          minVersion: form.minVersion.trim() || null,
          minBuild: form.minBuild.trim() ? Number(form.minBuild) : null,
          updateUrl: form.updateUrl.trim() || null,
          banner: { ...form.banner, until: form.banner.until ? new Date(form.banner.until).toISOString() : null },
          flags: form.flags,
          ops: { smsPerDay: Number(form.ops.smsPerDay), smsPaused: form.ops.smsPaused, smsRegions: form.ops.smsRegions.toUpperCase().split(/[\s,]+/).filter(Boolean) },
        },
      });
      setFlash('Gespeichert. Offene Apps bekommen es sofort, alle anderen beim nächsten Start.');
      load();
    } catch (err) {
      const msg = { invalid_version: 'Version im Format 1.2.3', invalid_build: 'Build ist eine Zahl', invalid_url: 'Link muss mit https:// beginnen', banner_text_required: 'Banner braucht einen Text', invalid_flags: 'Flag-Namen: kleinbuchstaben_mit_unterstrich', invalid_ops: 'Betrieb: SMS pro Tag ist eine Zahl ab 1, Länder als ISO-Codes (DE, AT, CH)' };
      setFlash(`Fehler: ${msg[err.code] || err.code || err.message}`);
    }
  };
  const blocked = form.minBuild ? data.versions.filter((v) => v.build && Number(v.build) < Number(form.minBuild)).reduce((a, v) => a + v.users, 0) : 0;

  return html`
    ${flash ? html`<div class="flash">${flash}</div>` : null}
    <div class="grid3">
      <div class="card">
        <div class="label">Mindestversion</div>
        <p class="note" style="margin-top:0">Ältere Builds sehen einen „Bitte aktualisieren“-Bildschirm und kommen nicht weiter.</p>
        <label class="field"><span>Mindest-Build (z. B. 21)</span><input value=${form.minBuild} onInput=${(e) => set({ minBuild: e.target.value.replace(/\D/g, '') })} disabled=${!owner} inputmode="numeric" /></label>
        <label class="field"><span>Oder Mindestversion (z. B. 1.1.0)</span><input value=${form.minVersion} onInput=${(e) => set({ minVersion: e.target.value })} disabled=${!owner} /></label>
        <label class="field"><span>Link zum Aktualisieren (App Store / TestFlight)</span><input value=${form.updateUrl} onInput=${(e) => set({ updateUrl: e.target.value })} disabled=${!owner} placeholder="https://" /></label>
        ${blocked ? html`<p class="bad" style="margin:0">Betrifft ${blocked} aktive ${blocked === 1 ? 'Person' : 'Personen'} mit älterem Build.</p>` : null}
      </div>
      <div class="card">
        <div class="label">Hinweis-Banner</div>
        <p class="note" style="margin-top:0">Erscheint oben in der App, z. B. bei Wartung oder Störungen.</p>
        <label class="check"><input type="checkbox" checked=${form.banner.enabled} onChange=${(e) => set({ banner: { ...form.banner, enabled: e.target.checked } })} disabled=${!owner} /> Banner anzeigen</label>
        <label class="field"><span>Text (max. 200 Zeichen)</span><input value=${form.banner.text} maxlength="200" onInput=${(e) => set({ banner: { ...form.banner, text: e.target.value } })} disabled=${!owner} /></label>
        <div class="inline">
          <select value=${form.banner.level} onChange=${(e) => set({ banner: { ...form.banner, level: e.target.value } })} disabled=${!owner}><option value="info">Info</option><option value="warning">Warnung</option></select>
          <input type="datetime-local" value=${form.banner.until} onInput=${(e) => set({ banner: { ...form.banner, until: e.target.value } })} disabled=${!owner} title="Automatisch ausblenden ab" />
        </div>
      </div>
      <div class="card">
        <div class="label">Feature-Flags</div>
        <p class="note" style="margin-top:0">Funktionen ohne neuen Build ein- und ausschalten.</p>
        ${Object.keys(form.flags).length === 0 ? html`<p class="note">Noch keine Flags.</p>` : Object.entries(form.flags).map(([k, v]) => html`<div class="kv">
          <span>${k}</span>
          <span class="inline"><label class="check"><input type="checkbox" checked=${v} onChange=${(e) => set({ flags: { ...form.flags, [k]: e.target.checked } })} disabled=${!owner} /> an</label>
          ${owner ? html`<a href="#" onClick=${(e) => { e.preventDefault(); const f = { ...form.flags }; delete f[k]; set({ flags: f }); }}>entfernen</a>` : null}</span>
        </div>`)}
        ${owner ? html`<div class="inline" style="margin-top:10px"><input placeholder="neues_flag" value=${newFlag} onInput=${(e) => setNewFlag(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} />
          <button class="btn small ghost" disabled=${!newFlag} onClick=${() => { set({ flags: { ...form.flags, [newFlag]: false } }); setNewFlag(''); }}>Hinzufügen</button></div>` : null}
      </div>
      <div class="card">
        <div class="label">Betrieb</div>
        <p class="note" style="margin-top:0">Bremsen für die Anmeldung per SMS (Twilio kostet pro Code). Gilt sofort, nicht für den Review-Login.</p>
        <label class="field"><span>SMS pro Tag (Deckel, danach 429)</span><input value=${form.ops.smsPerDay} onInput=${(e) => set({ ops: { ...form.ops, smsPerDay: e.target.value.replace(/\D/g, '') } })} disabled=${!owner} inputmode="numeric" /></label>
        <label class="field"><span>Länder (ISO-Codes, Komma-getrennt)</span><input value=${form.ops.smsRegions} onInput=${(e) => set({ ops: { ...form.ops, smsRegions: e.target.value } })} disabled=${!owner} placeholder="DE, AT, CH" /></label>
        <label class="check"><input type="checkbox" checked=${form.ops.smsPaused} onChange=${(e) => set({ ops: { ...form.ops, smsPaused: e.target.checked } })} disabled=${!owner} /> Notschalter: keine SMS senden (Anmeldung pausiert)</label>
      </div>
    </div>
    ${owner ? html`<div class="inline" style="justify-content:flex-end"><button class="btn" onClick=${save}>Speichern</button></div>` : html`<p class="note">Nur Owner können Einstellungen ändern.</p>`}

    <${PlusPanel} role=${role} />

    <div class="section">App-Versionen <span class="note">(aktiv in den letzten 30 Tagen)</span></div>
    <div class="card scroll">${data.versions.length ? html`<table>
      <thead><tr><th>Version</th><th>Build</th><th>Plattform</th><th>Personen</th></tr></thead>
      <tbody>${data.versions.map((v) => html`<tr><td>${v.version}</td><td>${v.build || '–'}</td><td>${PLATFORM[v.platform] || '–'}</td><td>${num(v.users)}</td></tr>`)}</tbody>
    </table>` : html`<p class="note" style="margin:0">Noch keine Daten. Die App meldet ihre Version ab dem nächsten Build.</p>`}
    ${data.unknown ? html`<p class="note">${num(data.unknown)} aktive ${data.unknown === 1 ? 'Person' : 'Personen'} mit älterem Build, der die Version noch nicht meldet.</p>` : null}
    </div>`;
}


// --- Moments -------------------------------------------------------------------------

const MOMENT_FILTERS = { all: 'Alle', reported: 'Gemeldet', hidden: 'Ausgeblendet', pending: 'Warten auf Zustimmung' };

function Moments({ onOpenUser, userId, userName, onClearUser }) {
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [zoom, setZoom] = useState(null);
  const load = useCallback(() => {
    const q = new URLSearchParams({ filter });
    if (userId) q.set('user', userId);
    api(`/moments?${q}`).then(setData).catch(() => setData({ moments: [], counts: {} }));
  }, [filter, userId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const act = async (m, action) => {
    if (action === 'delete' && !confirm('Moment endgültig löschen? Das Bild wird auch bei Cloudinary gelöscht.')) return;
    setBusy(m.id);
    try {
      await api(`/moments/${m.id}/${action}`, { method: 'POST' });
      load();
    } catch (err) {
      alert(`Fehler: ${err.code || err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const c = data?.counts || {};
  return html`
    <div class="now">
      <div class="tabs">${Object.entries(MOMENT_FILTERS).map(([k, label]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${label}${k === 'reported' && c.reported ? html` <span class="count">${c.reported}</span>` : null}</button>`)}</div>
      ${userId ? html`<span class="pill on">nur ${userName || 'diese Person'} <a href="#" onClick=${(e) => { e.preventDefault(); onClearUser(); }}>✕</a></span>` : null}
      <span class="spacer"></span>
      <span class="pill">Letzte 24 h: ${num(c.last24h)}</span>
      <span class="pill">Ausgeblendet: ${num(c.hidden)}</span>
    </div>
    ${!data ? html`<p class="note">Lade …</p>` : data.moments.length === 0 ? html`<div class="card"><p class="note" style="margin:0">Keine Moments.</p></div>` : html`<div class="moments">
      ${data.moments.map((m) => html`<div class="card moment ${m.hidden ? 'dim' : ''}">
        <img src=${m.screenshot} alt="Moment" onClick=${() => setZoom(m)} />
        <div class="body">
          <div class="inline" style="gap:6px">
            ${m.reports.open ? html`<span class="pill warn">${m.reports.open} ${m.reports.open === 1 ? 'Meldung' : 'Meldungen'}</span>` : null}
            ${m.hidden ? html`<span class="pill">ausgeblendet</span>` : null}
            ${m.status === 'pending' ? html`<span class="pill">wartet</span>` : null}
            <span class="note">${dateTime(m.at)}</span>
          </div>
          <p style="margin:8px 0 4px">
            <a href="#" onClick=${(e) => { e.preventDefault(); m.author.id && onOpenUser(m.author.id); }}>${m.author.name || m.author.phone}</a>${' mit '}<a href="#" onClick=${(e) => { e.preventDefault(); m.target.id && onOpenUser(m.target.id); }}>${m.target.name || m.target.phone}</a>
          </p>
          ${m.note ? html`<p class="quote">„${m.note}“</p>` : null}
          <p class="note">${m.mood || ''} ${m.callDuration ? `· Gespräch ${m.callDuration}` : ''} · ${m.reactions} Reaktionen${m.reports.total > m.reports.open ? ` · ${m.reports.total - m.reports.open} erledigte Meldungen` : ''}</p>
          <div class="inline">
            ${m.hidden
              ? html`<button class="btn small ghost" disabled=${busy} onClick=${() => act(m, 'unhide')}>Wieder zeigen</button>`
              : html`<button class="btn small ghost" disabled=${busy} onClick=${() => act(m, 'hide')}>Ausblenden</button>`}
            <button class="btn small danger" disabled=${busy} onClick=${() => act(m, 'delete')}>Löschen</button>
          </div>
        </div>
      </div>`)}
    </div>`}
    ${zoom ? html`<div class="lightbox" onClick=${() => setZoom(null)}><img src=${zoom.screenshot} alt="Moment groß" /></div>` : null}`;
}


// --- Wanna yap+ -----------------------------------------------------------------------

const LIMIT_LABELS = {
  circles: 'Eigene Kreise',
  circleMembers: 'Personen pro Kreis',
  roomParticipants: 'Personen pro Runde',
  roomMinutes: 'Minuten pro Runde (leer = unbegrenzt)',
  memoriesDays: 'Erinnerungen, Tage (leer = alle)',
  hdVideo: 'Video in HD',
  rituals: 'Rituale pro Kreis (max. 3)',
  nudgeMessage: 'Eigene Anstups-Texte',
  yearReview: 'Voller Jahresrückblick',
  appIcons: 'App-Icons',
};
const INTEREST_LABELS = { hd_video: 'Video in HD', bigger_circles: 'Größere Kreise', longer_rounds: 'Längere Runden', memories: 'Erinnerungen für immer', year_review: 'Jahresrückblick', icons: 'App-Icons & Themen', rituals: 'Mehr Rituale', family: 'Familien-Abo', support: 'Unterstützen' };

function PlusPanel({ role }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => {
    api('/plus').then((d) => {
      setData(d);
      setForm(JSON.parse(JSON.stringify(d.limits)));
    }).catch(() => setData(false));
  }, []);
  useEffect(load, [load]);
  if (data === false) return html`<div class="card">Plus-Daten konnten nicht geladen werden.</div>`;
  if (!data || !form) return html`<p class="note">Lade Plus …</p>`;
  const owner = role === 'owner';
  const set = (plan, key, value) => setForm({ ...form, [plan]: { ...form[plan], [key]: value } });
  const save = async () => {
    setFlash(null);
    try {
      await api('/config', { method: 'PUT', body: { limits: form } });
      setFlash('Grenzen gespeichert. Sie gelten sofort; bestehende Kreise bleiben, wie sie sind.');
      load();
    } catch (err) {
      setFlash(`Fehler: ${err.code === 'invalid_limits' ? 'ungültige Werte (Zahlen ab 1; Personen pro Kreis max. 50, pro Runde max. 16)' : err.code || err.message}`);
    }
  };
  const field = (plan, key) => {
    const value = form[plan][key];
    if (typeof data.defaults[plan][key] === 'boolean') {
      return html`<input type="checkbox" checked=${!!value} disabled=${!owner} onChange=${(e) => set(plan, key, e.target.checked)} />`;
    }
    const nullable = key === 'roomMinutes' || key === 'memoriesDays';
    return html`<input class="num" inputmode="numeric" value=${value ?? ''} disabled=${!owner} placeholder=${nullable ? '∞' : ''}
      onInput=${(e) => { const v = e.target.value.replace(/\D/g, ''); set(plan, key, v ? Number(v) : nullable ? null : 0); }} />`;
  };
  const interest = Object.entries(data.interest.features).sort((a, b) => b[1] - a[1]);
  return html`
    <div class="section">Wanna yap+</div>
    ${flash ? html`<div class="flash">${flash}</div>` : null}
    <div class="kpis">
      <${Kpi} label="Plus aktiv" value=${num(data.active)} sub=${Object.entries(data.bySource).map(([k, v]) => `${PLUS_SOURCES[k] || k}: ${v}`).join(' · ') || 'noch niemand'} color="var(--violet)" />
      <${Kpi} label="Interesse gezeigt" value=${num(data.interest.total)} sub=${`${num(data.interest.last7Days)} in den letzten 7 Tagen`} color="var(--pink)" />
      <${Kpi} label="Käufe" value=${data.webhookConfigured ? 'verbunden' : 'noch nicht'} sub=${data.webhookConfigured ? 'RevenueCat-Webhook aktiv' : 'REVENUECAT_WEBHOOK_SECRET fehlt'} />
    </div>
    ${data.sandbox > 0 ? html`<p class="note">${num(data.sandbox)} davon ${data.sandbox === 1 ? 'ist ein Sandbox-Kauf' : 'sind Sandbox-Käufe'} von Testern: Plus aktiv, aber nirgends als zahlend gezählt.</p>` : null}
    <div class="grid3">
      <div class="card">
        <div class="label">Grenzen</div>
        <table><thead><tr><th></th><th>Gratis</th><th>Plus</th></tr></thead><tbody>
          ${Object.keys(LIMIT_LABELS).map((k) => html`<tr><td>${LIMIT_LABELS[k]}</td><td>${field('free', k)}</td><td>${field('plus', k)}</td></tr>`)}
        </tbody></table>
        ${owner ? html`<div class="inline" style="justify-content:flex-end;margin-top:10px"><button class="btn small" onClick=${save}>Grenzen speichern</button></div>` : null}
        <p class="note">Eigene Kreise zählen nur beim Gründen; Beitreten ist nie begrenzt. Größe und Runden eines Kreises richten sich nach dem Plan der Person, die ihn gegründet hat.</p>
      </div>
      <div class="card">
        <div class="label">Was die Leute interessiert</div>
        ${interest.map(([k, v]) => html`<div class="kv"><span>${INTEREST_LABELS[k] || k}</span><span>${num(v)}</span></div>`)}
      </div>
    </div>`;
}

// --- App -------------------------------------------------------------------------

// The way from visit to sign-up, and where it breaks off
const FUNNEL_STEPS = [
  ['visits', 'Besuche', 'haben die Seite geöffnet'],
  ['engaged', 'Gelesen', '15 s geblieben oder weiter nach unten gescrollt'],
  ['formStarted', 'Formular angefangen', 'ins E-Mail-Feld getippt'],
  ['submitted', 'Abgeschickt', 'Anmeldung gesendet'],
  ['confirmed', 'Bestätigt', 'Link in der Mail geklickt'],
];

/** Where most people drop off, in plain words. */
function funnelHint(f, mailConfigured) {
  if (!f.visits) return 'Noch keine Besuche. Erst Traffic, dann lässt sich der Weg auswerten.';
  const rate = (a, b) => (b ? a / b : 0);
  if (f.submitted && !f.confirmed) return mailConfigured
    ? 'Anmeldungen kommen an, aber niemand bestätigt: Landet die Bestätigungsmail im Spam? Einmal selbst eintragen und prüfen (auch Absender, SPF/DKIM).'
    : 'Anmeldungen kommen an, aber der Mail-Versand ist nicht eingerichtet: ohne Bestätigungsmail keine Bestätigung.';
  if (f.visits >= 20 && rate(f.engaged, f.visits) < 0.3) return 'Die meisten springen sofort ab: Passt die Seite zu dem, was die Anzeige verspricht? Der erste Bildschirm muss es in 3 Sekunden klarmachen.';
  if (f.engaged >= 10 && rate(f.formStarted, f.engaged) < 0.15) return 'Gelesen wird, aber kaum jemand fängt an, sich einzutragen: Warum jetzt eintragen? Den Vorteil (Launch-Link, Abzeichen, Plus-Monat) und das Formular weiter nach oben.';
  if (f.formStarted >= 5 && rate(f.submitted, f.formStarted) < 0.5) return 'Viele fangen an und brechen ab: Formular und Einwilligungstext vereinfachen, Fehlermeldungen prüfen.';
  if (f.submitted >= 5 && rate(f.confirmed, f.submitted) < 0.5) return 'Viele bestätigen die Mail nicht: Betreff und Absender prüfen, Spam-Ordner, und nach dem Absenden deutlicher sagen, dass eine Mail kommt.';
  return null;
}

function Funnel({ funnel, mailConfigured }) {
  const top = funnel.visits || 0;
  const hint = funnelHint(funnel, mailConfigured);
  return html`<div class="card funnel" style="margin-bottom:12px">
    <h3 style="margin:0 0 2px">Vom Besuch zur Anmeldung</h3>
    <div class="note" style="margin-bottom:10px">letzte 30 Tage · „Gelesen“ und „Formular“ zählen erst seit dem 29.09.2026</div>
    ${FUNNEL_STEPS.map(([key, label, sub], i) => {
      const n = funnel[key] || 0;
      const prev = i ? funnel[FUNNEL_STEPS[i - 1][0]] || 0 : null;
      return html`<div class="fstep">
        <div class="fhead"><span><b>${label}</b> <span class="muted">${sub}</span></span><span><b>${num(n)}</b>${prev !== null ? html` <span class="muted">${pct(prev ? n / prev : null)}</span>` : null}</span></div>
        <div class="bar"><i style=${`width:${top ? Math.max(2, (n / top) * 100) : 0}%`}></i></div>
      </div>`;
    })}
    ${hint ? html`<p class="note warn" style="margin:10px 0 0">💡 ${hint}</p>` : null}
  </div>`;
}

/** Where the mails go out, whether it works, and the provider's answer when not. */
function MailStatus({ mail, owner, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await fn());
      onChanged();
    } catch (e) {
      setResult({ error: e.data?.reason || message(e) });
    } finally {
      setBusy(false);
    }
  };
  const failing = !mail.configured || (mail.lastError && (!mail.lastOkAt || new Date(mail.lastError.at) > new Date(mail.lastOkAt)));
  return html`<div class="card" style=${`margin-bottom:12px;${failing ? 'border-color:var(--warning)' : ''}`}>
    <div class="inline" style="justify-content:space-between"><h3 style="margin:0">E-Mail-Versand</h3>
      <span class=${`pill ${failing ? 'warn' : 'on'}`}>${!mail.configured ? 'nicht eingerichtet' : failing ? 'Fehler' : mail.lastOkAt ? 'läuft' : 'noch nichts gesendet'}</span></div>
    ${!mail.configured ? html`<p class="note">Auf Render fehlt <b>SMTP_URL</b> (und <b>MAIL_FROM</b>): ohne sie kommen weder Bestätigungs- noch Launch-Mails an.</p>` : html`
      <${Row} label="Server">${mail.server ? `${mail.server.host}:${mail.server.port}${mail.server.secure ? ' (SSL)' : ''}, Nutzer ${mail.server.user || '–'}` : 'SMTP_URL nicht lesbar'}<//>
      <${Row} label="Absender">${mail.from}<//>
      <${Row} label="Zuletzt gesendet">${mail.lastOkAt ? dateTime(mail.lastOkAt) : '– (seit dem letzten Neustart)'}<//>
      ${mail.lastError ? html`<${Row} label="Letzter Fehler">${dateTime(mail.lastError.at)}<//><p class="note bad" style="margin:4px 0 0;overflow-wrap:anywhere">${mail.lastError.message}</p>` : null}
      ${mail.lastRejected ? html`<p class="note" style="margin:6px 0 0;overflow-wrap:anywhere">Zuletzt abgelehnte Adresse (${dateTime(mail.lastRejected.at)}): ${mail.lastRejected.message}. Das liegt an der Adresse, nicht am Versand: Sie wird nicht eingetragen.</p>` : null}`}
    ${mail.waitingForMail ? html`<p class="note warn" style="margin:8px 0 0">${num(mail.waitingForMail)} ${mail.waitingForMail === 1 ? 'Anmeldung wartet' : 'Anmeldungen warten'} auf die Bestätigungsmail. Sie geht automatisch raus (alle 10 Minuten ein Versuch), sobald der Versand klappt.</p>` : null}
    ${result ? html`<p class=${result.error ? 'error' : 'flash'} style="margin:8px 0 0">${result.error || result.text}</p>` : null}
    ${owner && mail.configured ? html`<div class="inline" style="margin-top:10px">
      <button class="btn small ghost" disabled=${busy} onClick=${() => run(async () => { const r = await api('/mail/check', { method: 'POST' }); return r.ok ? { text: 'Anmeldung beim Mail-Server klappt.' } : { error: `Der Mail-Server lehnt ab: ${r.error}` }; })}>Verbindung prüfen</button>
      <button class="btn small ghost" disabled=${busy} onClick=${() => { const e = prompt('Testmail an:'); if (e) run(async () => { await api('/waitlist/test-mail', { method: 'POST', body: { email: e } }); return { text: `Testmail an ${e} verschickt.` }; }); }}>Testmail senden</button>
    </div>` : null}
    ${failing && mail.configured ? html`<details style="margin-top:10px"><summary class="note" style="cursor:pointer">Häufige Ursachen</summary><ul class="note" style="margin:6px 0 0;padding-left:18px">
      <li><b>Absender nicht bestätigt:</b> Die Adresse aus MAIL_FROM (bzw. die Domain wannayap.app) muss beim Mail-Anbieter als Absender verifiziert sein, samt SPF- und DKIM-Einträgen.</li>
      <li><b>Zugangsdaten:</b> Beim Anbieter gibt es einen eigenen SMTP-Schlüssel, nicht das Login-Passwort. Sonderzeichen im Passwort müssen in SMTP_URL URL-kodiert sein (z. B. @ als %40).</li>
      <li><b>Port:</b> smtps:// mit 465 oder smtp:// mit 587, nicht gemischt.</li>
      <li><b>Konto gesperrt oder Kontingent erreicht:</b> Im Dashboard des Anbieters nachsehen.</li>
    </ul></details>` : null}
  </div>`;
}

function Waitlist({ role }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => api('/waitlist').then(setData).catch(() => setData({ error: true })), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  const run = async (fn, ok) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      const why = { mail_not_configured: 'E-Mail-Versand ist nicht eingerichtet (SMTP_URL auf Render).', confirm_required: 'Bestätigung falsch eingegeben.', invalid_email: 'Ungültige Adresse.' }[e.message];
      setMsg({ ok: false, text: why || 'Hat nicht geklappt.' });
    } finally {
      setBusy(false);
    }
  };
  if (!data) return html`<div class="card note">Lade Warteliste …</div>`;
  if (data.error) return html`<div class="card">Die Warteliste konnte nicht geladen werden.</div>`;
  const launch = data.launch;
  const visits = data.visits;
  const conversion = data.confirmed + data.pending ? data.confirmed / (data.confirmed + data.pending) : null;
  return html`
    ${data.mail ? html`<${MailStatus} mail=${data.mail} owner=${role === 'owner'} onChanged=${load} />` : null}
    <div class="section" style="margin-top:0">Landing Page</div>
    <div class="kpis">
      <${Kpi} label="Besuche heute" value=${num(visits.today)} sub="Aufrufe der Seite, ohne Neuladen" color="var(--cyan)" />
      <${Kpi} label="Besuche 7 Tage" value=${num(visits.last7Days)} sub="inklusive heute" />
      <${Kpi} label="Besuche 30 Tage" value=${num(visits.last30Days)} sub="inklusive heute" color="var(--violet)" />
      <${Kpi} label="Besuch → Anmeldung" value=${pct(visits.last30Days ? visits.signups30Days / visits.last30Days : null)} sub=${`${num(visits.signups30Days)} bestätigte Anmeldungen (30 Tage)`} color="var(--pink)" />
    </div>
    ${visits.funnel ? html`<${Funnel} funnel=${visits.funnel} mailConfigured=${data.mailConfigured} />` : null}
    <div class="grid2">
      <${Chart} title="Besuche pro Tag" subtitle="letzte 30 Tage" series=${visits.byDay} keys=${[{ label: 'Besuche', color: 'var(--violet)', value: (d) => d.count }]} />
      <div class="card scroll">
        <h3 style="margin:0 0 2px">Kampagnen</h3>
        <div class="note" style="margin-bottom:6px">letzte 30 Tage · Anmeldungen: bestätigt</div>
        ${visits.campaigns.length ? html`<table>
          <thead><tr><th>Quelle · Kampagne</th><th style="text-align:right">Besuche</th><th style="text-align:right" title="15 s geblieben oder gescrollt">Gelesen</th><th style="text-align:right" title="ins E-Mail-Feld getippt">Formular</th><th style="text-align:right">Gesendet</th><th style="text-align:right">Bestätigt</th><th style="text-align:right">Quote</th></tr></thead>
          <tbody>${visits.campaigns.map((c) => html`<tr>
            <td><strong>${c.source}</strong>${c.campaign ? html`<div class="muted" style="font-size:12px;white-space:normal;overflow-wrap:anywhere">${c.campaign}</div>` : null}</td>
            <td style="text-align:right">${num(c.visits)}</td><td style="text-align:right">${num(c.engaged)}</td><td style="text-align:right">${num(c.formStarted)}</td><td style="text-align:right">${num(c.submitted)}</td><td style="text-align:right">${num(c.signups)}</td>
            <td style="text-align:right">${pct(c.visits ? c.signups / c.visits : null)}</td>
          </tr>`)}</tbody>
        </table>` : html`<p class="note" style="margin:0">Noch keine Besuche.</p>`}
        <p class="note" style="margin:10px 0 0">Quelle aus <code>utm_source</code>, sonst die Plattform, von der der Besuch kam (z. B. Link in der Instagram-Bio), „empfehlung“ oder „direkt“. Gezählt wird nur eine Zahl pro Tag und Quelle, ohne Cookies und ohne IP.</p>
        <div class="nocount">
          <p class="note" style="margin:0 0 8px"><b>Eigene Besuche nicht mitzählen:</b> diesen Link einmal in jedem Browser öffnen, mit dem du die Seite ansiehst (Safari, Chrome, auch im Instagram- oder TikTok-Browser über „Link kopieren“ und dort einfügen). Neu laden zählt ohnehin nicht.</p>
          <div class="inline"><a class="btn small ghost" href="https://wannayap.app/?nichtzaehlen=1" target="_blank" rel="noopener">Diesen Browser nicht mitzählen</a><${CopyButton} text="https://wannayap.app/?nichtzaehlen=1" label="Link kopieren" /></div>
        </div>
      </div>
    </div>

    <div class="section">Warteliste</div>
    <div class="kpis">
      <${Kpi} label="Bestätigt" value=${num(data.confirmed)} sub=${`${num(data.pending)} warten auf Bestätigung`} color="var(--cyan)" />
      <${Kpi} label="Bestätigungsquote" value=${pct(conversion)} sub="bestätigt / eingetragen (7 Tage)" />
      <${Kpi} label="Über Empfehlung" value=${pct(data.confirmed ? data.viaReferral / data.confirmed : null)} sub=${`${num(data.viaReferral)} Menschen`} color="var(--pink)" />
      <${Kpi} label="Ziel erreicht" value=${num(data.reachedGoal)} sub=${`haben ${data.goal}+ Freunde mitgebracht`} />
      <${Kpi} label="Code eingelöst" value=${num(data.claimed)} sub="in der App" color="var(--violet)" />
    </div>
    <div class="grid2">
      <${Chart} title="Neue Bestätigungen" subtitle="letzte 30 Tage" series=${data.byDay} keys=${[{ label: 'bestätigt', color: 'var(--cyan)', value: (d) => d.count }]} />
      <div class="card">
        <h3>Woher</h3>
        <table><tbody>${data.bySource.map((s) => html`<tr><td>${s.source}</td><td style="text-align:right">${num(s.count)}</td></tr>`)}</tbody></table>
        <p class="note" style="margin:10px 0 0">Aus <code>utm_source</code> im Link zur Landing Page, sonst „empfehlung“ oder „direkt“.</p>
        <h3 style="margin-top:18px">Die besten Empfehler</h3>
        <table><tbody>${data.topReferrers.length ? data.topReferrers.map((t) => html`<tr><td><code>${t.code}</code></td><td style="text-align:right">${num(t.count)}</td></tr>`) : html`<tr><td class="note">Noch niemand.</td></tr>`}</tbody></table>
      </div>
    </div>

    <div class="section">Launch-Mail</div>
    <div class="card">
      ${launch?.startedAt
        ? html`<p><b>${launch.finishedAt ? 'Verschickt' : 'Wird verschickt …'}</b> · gestartet ${new Date(launch.startedAt).toLocaleString('de-DE')} von ${launch.by} · ${num(launch.sent || 0)} gesendet${launch.failed ? `, ${num(launch.failed)} fehlgeschlagen` : ''} · ${num(data.mailed)} von ${num(data.confirmed)} Adressen erreicht</p>`
        : html`<p>Am Release-Tag geht an alle bestätigten Adressen eine Mail mit App-Store-Link und ihrem persönlichen Code. Erst eine Testmail an dich schicken und prüfen, dann starten. Der Versand läuft im Hintergrund, jede Adresse bekommt die Mail genau einmal.</p>`}
      ${role === 'owner' ? html`<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        <button class="btn small ghost" disabled=${busy} onClick=${() => { const e = prompt('Testmail an:'); if (e) run(() => api('/waitlist/test-mail', { method: 'POST', body: { email: e } }), `Testmail an ${e} verschickt.`); }}>Testmail schicken</button>
        ${!launch?.startedAt ? html`<button class="btn small danger" disabled=${busy || !data.confirmed} onClick=${() => { const c = prompt(`Launch-Mail an ${data.confirmed} Adressen schicken? Das lässt sich nicht zurückholen. Zum Bestätigen STARTEN eingeben:`); if (c) run(() => api('/waitlist/launch', { method: 'POST', body: { confirm: c } }), 'Versand gestartet.'); }}>Launch-Mail an alle …</button>` : null}
        <a class="btn small ghost" href="/admin/waitlist/export">Export (CSV)</a>
      </div>` : null}
      ${msg ? html`<p class=${msg.ok ? 'note' : 'error'} style="margin-top:10px">${msg.text}</p>` : null}
    </div>
  `;
}

const TEMPLATE_LABELS = { chat: 'Chat', moment: 'Yap Moment', list: 'Liste', story: 'Story', hero: 'Hero-Folge' };
const APPROVAL_FILTERS = { pending: 'Offen', approved: 'Freigegeben', posted: 'Gepostet', rejected: 'Verworfen' };
const PUBLISH_STATUS = { scheduled: 'geplant', posting: 'wird gepostet …', processing: 'wird verarbeitet …', posted: 'gepostet', inbox: 'in der TikTok-App fertig machen', failed: 'fehlgeschlagen', skipped: 'ausgelassen' };
const euro = (n) => (n == null ? '–' : `${n.toFixed(2).replace('.', ',')} €`);
const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok' };

function CopyButton({ text, label = 'Kopieren' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {}
  };
  return html`<button class="btn small ghost" type="button" onClick=${copy}>${done ? 'Kopiert ✓' : label}</button>`;
}

/** Caption as it goes on the platform: text, then the hashtags. */
// Not posted yet on a connected platform, and nothing under way there (also
// videos approved before automatic posting existed, which have no status)
const waiting = (draft, p, connected) => connected[p] && !draft.posted?.[p] && (!draft.publish?.[p] || ['scheduled', 'failed'].includes(draft.publish[p].status));
const canPostNow = (draft, connected) => Object.keys(PLATFORM_LABELS).some((p) => waiting(draft, p, connected));
// Something to do or to watch: otherwise an approved video shows as one line
const needsLook = (draft, connected) => canPostNow(draft, connected) || Object.values(draft.publish || {}).some((pub) => pub && ['posting', 'processing', 'failed', 'inbox'].includes(pub.status) && !(pub.status === 'inbox' && draft.posted?.tiktok));
const postText = (draft, platform) => [draft.captions[platform], draft.hashtags.map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n');
// The agent's own music (CMM marketing/music.js)
const MUSIC_LABELS = { lofi: 'Lo-Fi', house: 'House', pop: 'Pop', trap: 'Trap / Hip-Hop', afro: 'Afro', acoustic: 'Akustik' };
const musicPill = (draft) => (draft.music?.style ? html`<span class="pill" title="Musik im Video">♪ ${MUSIC_LABELS[draft.music.style] || draft.music.style}</span>` : null);
// A spoken line in a hero video: then the original sound stays, just quieter
const hasVoice = (draft) => (draft.content?.shots || []).some((s) => s.line);

/** The trending sound the agent suggests, to add in the TikTok app. */
function SoundTip({ draft, compact }) {
  const s = draft.sound;
  if (!s) return null;
  return html`<div class="note" style="margin:0 0 8px">
    <b>Sound-Tipp für TikTok:</b> „${s.title}“${s.artist ? ` · ${s.artist}` : ''}
    ${s.commercial ? html` <span class="pill on" title="Laut Recherche in der kommerziellen Musikbibliothek: für Unternehmenskonten erlaubt">kommerziell frei</span>` : html` <span class="pill warn" title="Nicht als kommerziell freigegeben belegt: in TikTok prüfen, ob er für Unternehmenskonten verfügbar ist">prüfen</span>`}
    ${!compact && s.why ? html`<div>${s.why}</div>` : null}
  </div>`;
}

const shortDate = (d) => new Date(d).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });

/** Where a platform stands for an approved video, with what is left to do. */
function PublishRow({ draft, p, owner, busy, connected, run }) {
  const label = PLATFORM_LABELS[p];
  const pub = draft.publish?.[p];
  const done = !!draft.posted?.[p];
  const mark = (text) => html`<label class="check"><input type="checkbox" checked=${done} disabled=${busy || !owner} onChange=${(e) => run('posted', { platform: p, posted: e.target.checked })} /> ${text}</label>`;
  let state;
  if (pub?.status === 'posted' || (done && !pub)) state = html`<span class="pill on">gepostet</span>${pub?.url ? html` <a href=${pub.url} target="_blank" rel="noopener">ansehen</a>` : null}`;
  else if (pub?.status === 'inbox') state = done ? html`<span class="pill on">veröffentlicht</span>` : html`<span class="pill todo">${PUBLISH_STATUS.inbox}</span>`;
  else if (pub?.status === 'skipped') state = html`<span class="muted">ausgelassen</span>`;
  else if (pub) state = html`<span class=${`pill ${pub.status === 'failed' ? 'warn' : ''}`}>${PUBLISH_STATUS[pub.status] || pub.status}</span>${pub.status === 'scheduled' && draft.scheduledAt ? html` <span class="muted">${dateTime(draft.scheduledAt)}</span>` : null}`;
  else if (connected[p]) state = html`<span class="muted">noch nicht gepostet</span>`;
  else state = owner ? mark('von Hand gepostet') : html`<span class="muted">nicht verbunden</span>`;
  return html`<div class="pubrow">
    <div class="kv"><span>${label}</span><span>${state}</span></div>
    ${pub?.error && pub.status === 'failed' ? html`<div class="note bad">${pub.error}</div>` : null}
    ${owner && pub?.status === 'failed' && !done ? html`<div class="inline" style="margin:4px 0 6px">${mark('doch gepostet')}<button class="btn small ghost" disabled=${busy} onClick=${() => run('skip', { platform: p })}>Auf ${label} auslassen</button></div>` : null}
    ${pub?.status === 'inbox' && !done ? html`<div class="todo">
      <ol>
        <li>In TikTok die Benachrichtigung öffnen.</li>
        <li>Text einfügen <${CopyButton} text=${postText(draft, 'tiktok')} label="Text kopieren" /></li>
        ${draft.sound ? html`<li>Unter „Sounds“ <b>${draft.sound.title}</b> suchen und hinzufügen, dann unter „Lautstärke“ den Originalton ${hasVoice(draft) ? 'leiser stellen (der Satz im Video soll zu hören bleiben)' : 'ausschalten'}.</li>` : null}
        ${draft.ai ? html`<li>Unter „Weitere Optionen“ <b>KI-generierter Inhalt</b> einschalten.</li>` : null}
        <li>Veröffentlichen, dann hier abhaken.</li>
      </ol>
      <div class="inline">${owner ? mark('auf TikTok veröffentlicht') : null}${owner ? html`<button class="btn small ghost" disabled=${busy} onClick=${() => run('skip', { platform: p })}>Nicht auf TikTok</button>` : null}</div>
    </div>` : null}
  </div>`;
}

// Quick reasons for a rejection; they go back to the agent with the rest
const REJECT_REASONS = ['Hook zu schwach', 'Text zu lang', 'Wirkt zu werblich', 'Person passt nicht', 'Bild- oder Videofehler', 'Thema passt nicht'];
const TEXT_ERRORS = {
  too_many_hashtags: 'Höchstens 5 Hashtags (Grenze von Instagram).',
  invalid_hashtag: 'Hashtags nur aus Buchstaben, Ziffern und _.',
  empty_caption: 'Beide Texte brauchen Inhalt.',
  already_posting: 'Schon unterwegs oder gepostet: die Texte bleiben so.',
  not_editable: 'Dieses Video lässt sich nicht mehr bearbeiten.',
};
// Texts can change until the video is on its way
const editable = (draft) => ['pending', 'approved'].includes(draft.status) && !Object.keys(PLATFORM_LABELS).some((p) => draft.posted?.[p] || ['posting', 'processing', 'posted', 'inbox'].includes(draft.publish?.[p]?.status));

/** Captions and hashtags, changed before posting. */
function TextEditor({ draft, onSaved, onCancel }) {
  const [ig, setIg] = useState(draft.captions.instagram);
  const [tt, setTt] = useState(draft.captions.tiktok);
  const [tags, setTags] = useState(draft.hashtags.map((h) => `#${h}`).join(' '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { draft: saved } = await api(`/marketing/drafts/${draft.id}/texts`, { method: 'PUT', body: { captions: { instagram: ig, tiktok: tt }, hashtags: tags } });
      onSaved(saved);
    } catch (e) {
      setError(TEXT_ERRORS[e.code] || message(e));
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="texteditor">
    <label class="field"><span>Instagram</span><textarea rows="4" maxlength="2200" value=${ig} onInput=${(e) => setIg(e.target.value)}></textarea></label>
    <label class="field"><span>TikTok</span><textarea rows="3" maxlength="2200" value=${tt} onInput=${(e) => setTt(e.target.value)}></textarea></label>
    <label class="field"><span>Hashtags (höchstens 5)</span><input value=${tags} onInput=${(e) => setTags(e.target.value)} autocapitalize="off" autocorrect="off" /></label>
    ${error ? html`<p class="error">${error}</p>` : null}
    <div class="inline"><button class="btn small" disabled=${busy} onClick=${save}>Speichern</button><button class="btn small ghost" disabled=${busy} onClick=${onCancel}>Abbrechen</button></div>
  </div>`;
}

/** Why not: tap reasons, optionally add a sentence. */
function RejectPicker({ busy, onReject, onCancel }) {
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  const toggle = (r) => setPicked(picked.includes(r) ? picked.filter((x) => x !== r) : [...picked, r]);
  const feedback = [picked.join(', '), note.trim()].filter(Boolean).join('. ');
  return html`<div class="rejectpicker">
    <div class="label">Was passt nicht?</div>
    <div class="chips">${REJECT_REASONS.map((r) => html`<button type="button" class=${`chip ${picked.includes(r) ? 'on' : ''}`} onClick=${() => toggle(r)}>${r}</button>`)}</div>
    <input class="reason" placeholder="Noch etwas? (optional, hilft dem Agenten)" value=${note} onInput=${(e) => setNote(e.target.value)} maxlength="400" />
    <div class="inline"><button class="btn danger" disabled=${busy} onClick=${() => onReject(feedback)}>Verwerfen</button><button class="btn ghost" disabled=${busy} onClick=${onCancel}>Abbrechen</button></div>
  </div>`;
}

/**
 * One draft. compact (Freigegeben): a small preview instead of the big video and
 * no idea text, what is left to do comes first. onClose: opened from a list.
 */
function AdDraftCard({ draft, owner, connected, onChanged, compact, onClose }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const run = async (path, body) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/marketing/drafts/${draft.id}/${path}`, { method: 'POST', body });
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const approved = ['approved', 'posted'].includes(draft.status);
  const poster = draft.videoUrl ? draft.videoUrl.replace('/video/upload/', '/video/upload/so_2/').replace(/\.mp4$/, '.jpg') : null;
  // The agent's own checks (bad takes, muted sound) stand out from the idea
  const [idea, checks] = (draft.idea || '').split(/\n\nPrüfung(?: durch Claude)?: /);
  const video = !draft.videoUrl ? null
    : compact && !playing ? html`<button class="thumb" onClick=${() => setPlaying(true)} title="Video abspielen"><img src=${poster} alt="" loading="lazy" /><span>▶</span></button>`
    : html`<video src=${draft.videoUrl} poster=${poster} controls playsinline preload=${playing ? 'auto' : 'none'} autoplay=${playing}></video>`;
  return html`<div class=${`card ad ${compact && !playing ? 'compact' : ''}`}>
    ${video}
    <div class="body">
      <div class="inline" style="justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <h3 style="margin:0">${draft.title}</h3>
        ${onClose ? html`<button class="btn small ghost" onClick=${onClose}>Schließen</button>` : null}
      </div>
      <div class="inline" style="margin-bottom:8px">
        <span class="pill">${TEMPLATE_LABELS[draft.template] || draft.template}</span>
        ${draft.ai ? html`<span class="pill warn" title="Wird beim Posten als KI-generiert gekennzeichnet">KI</span>` : null}
        ${musicPill(draft)}
        ${draft.characters?.length ? html`<span class="pill">${draft.characters.join(', ')}</span>` : null}
        ${draft.seconds ? html`<span class="pill">${draft.seconds} s</span>` : null}
        ${draft.costEur != null ? html`<span class="pill">${euro(draft.costEur)}</span>` : null}
        <span class="muted" style="font-size:12px">${dateTime(draft.createdAt)}</span>
      </div>
      ${idea && !compact ? html`<p style="margin:0 0 8px;color:var(--text-2)">${idea}</p>` : null}
      ${checks && !compact ? html`<p class="note warn" style="margin:0 0 8px">⚠︎ ${checks}</p>` : null}
      ${compact ? null : html`<${SoundTip} draft=${draft} />`}
      ${draft.feedback ? html`<div class="quote">${draft.status === 'rejected' ? 'Verworfen' : 'Notiz'}: ${draft.feedback}</div>` : null}
      <details class="texts">
        <summary><span class="label" style="margin:0">Texte und Hashtags</span><span class="muted">${draft.hashtags.map((h) => `#${h}`).join(' ')}</span></summary>
        ${Object.keys(PLATFORM_LABELS).map((p) => html`<div class="caption">
          <div class="inline" style="justify-content:space-between"><span class="label" style="margin:0">${PLATFORM_LABELS[p]}</span><${CopyButton} text=${postText(draft, p)} label="Text kopieren" /></div>
          <p>${postText(draft, p)}</p>
          <div class="inline"><span class="note" style="flex:1;min-width:0;overflow-wrap:anywhere">${draft.links[p]}</span><${CopyButton} text=${draft.links[p]} label="Link" /></div>
        </div>`)}
        <p class="note" style="margin:0">Links in Captions sind nicht klickbar; die Links pro Video sind für Story-Sticker und Anzeigen.</p>
        ${owner && editable(draft) ? (editing
          ? html`<${TextEditor} draft=${draft} onSaved=${() => { setEditing(false); onChanged(); }} onCancel=${() => setEditing(false)} />`
          : html`<button class="btn small ghost" style="margin-top:8px" onClick=${() => setEditing(true)}>Texte bearbeiten</button>`) : null}
        ${draft.edited ? html`<p class="note" style="margin:8px 0 0">Von Hand angepasst (${draft.edited.by}).</p>` : null}
      </details>
      ${error ? html`<p class="error">${error}</p>` : null}
      ${draft.status === 'pending' && owner ? (rejecting
        ? html`<${RejectPicker} busy=${busy} onReject=${(feedback) => run('decision', { action: 'reject', feedback })} onCancel=${() => setRejecting(false)} />`
        : html`<div class="inline" style="margin-top:12px"><button class="btn" disabled=${busy} onClick=${() => run('decision', { action: 'approve' })}>Freigeben</button><button class="btn ghost" disabled=${busy} onClick=${() => setRejecting(true)}>Verwerfen …</button></div>`) : null}
      ${approved ? html`<div class="publish">
        ${Object.keys(PLATFORM_LABELS).map((p) => html`<${PublishRow} draft=${draft} p=${p} owner=${owner} busy=${busy} connected=${connected} run=${run} />`)}
        <div class="inline" style="margin-top:10px">
          ${owner && canPostNow(draft, connected) ? html`<button class="btn small" disabled=${busy} onClick=${() => run('publish-now')}>Jetzt posten</button>` : null}
          ${draft.downloadUrl ? html`<a class="btn small ghost" href=${draft.downloadUrl}>MP4 laden</a>` : null}
        </div>
      </div>` : null}
    </div>
  </div>`;
}

/** Where a posted video went: a link per platform, or a tick when posted by hand. */
function PlatformPills({ draft }) {
  return Object.entries(PLATFORM_LABELS).map(([p, label]) => {
    const pub = draft.publish?.[p];
    if (pub?.url) return html`<a class="pill on" href=${pub.url} target="_blank" rel="noopener" onClick=${(e) => e.stopPropagation()}>${label} ↗</a>`;
    if (draft.posted?.[p]) return html`<span class="pill on">${label} ✓</span>`;
    if (pub?.status === 'skipped') return html`<span class="pill muted-pill">${label} ausgelassen</span>`;
    return null;
  });
}

/** Gepostet and Verworfen: one line per video; a tap opens the whole card. */
function DraftList({ drafts, tab, owner, connected, onChanged }) {
  const [open, setOpen] = useState(null);
  return html`<div class="card list-card">${drafts.map((d) => {
    if (open === d.id) {
      return html`<div class="list-open"><${AdDraftCard} draft=${d} owner=${owner} connected=${connected} onChanged=${onChanged} onClose=${() => setOpen(null)} /></div>`;
    }
    const poster = d.videoUrl ? d.videoUrl.replace('/video/upload/', '/video/upload/so_2,w_120/').replace(/\.mp4$/, '.jpg') : null;
    return html`<button class="draftrow" onClick=${() => setOpen(d.id)}>
      ${poster ? html`<img src=${poster} alt="" loading="lazy" />` : html`<span class="noimg"></span>`}
      <span class="draftrow-main">
        <b>${d.title}</b>
        <span class="muted">${tab === 'posted' ? `gepostet ${shortDate(d.postedAt || d.decidedAt)}` : `verworfen ${shortDate(d.decidedAt || d.createdAt)}`} · ${TEMPLATE_LABELS[d.template] || d.template}${d.music?.style ? ` · ♪ ${MUSIC_LABELS[d.music.style] || d.music.style}` : ''}</span>
        ${tab === 'rejected' && d.feedback ? html`<span class="reason">„${d.feedback}“</span>` : null}
      </span>
      ${tab === 'posted' ? html`<span class="draftrow-side">
        <span class="inline"><${PlatformPills} draft=${d} /></span>
        ${d.visits?.visits ? html`<span class="muted">${d.visits.visits} ${d.visits.visits === 1 ? 'Besuch' : 'Besuche'}${d.visits.submitted ? ` · ${d.visits.submitted} Anmeldung${d.visits.submitted === 1 ? '' : 'en'}` : ''}</span>` : null}
      </span>` : null}
    </button>`;
  })}</div>`;
}

/** One line above the drafts; the details and the setting are under Einstellungen. */
function BudgetLine({ onOpen }) {
  const [b, setB] = useState(null);
  useEffect(() => { api('/marketing/budget').then((d) => setB(d.budget)).catch(() => {}); }, []);
  if (!b) return null;
  const tight = b.spentTodayEur >= b.dailyEur * 0.8 || b.spentWeekEur >= b.weeklyEur * 0.8;
  return html`<button class=${`budgetline ${tight ? 'tight' : ''}`} onClick=${onOpen}>
    <span>Budget heute <b>${euro(b.spentTodayEur)}</b> / ${euro(b.dailyEur)} · Woche <b>${euro(b.spentWeekEur)}</b> / ${euro(b.weeklyEur)}</span>
    <span class="more">Einstellungen ›</span>
  </button>`;
}

function BudgetCard({ owner }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api('/marketing/budget').then(setData).catch(() => setData({ error: true })), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return null;
  if (data.error) return html`<div class="card">Das Budget konnte nicht geladen werden.</div>`;
  const b = data.budget;
  const bar = (spent, cap) => html`<div class="bar"><i style=${`width:${Math.min(100, cap ? (spent / cap) * 100 : 100)}%`}></i></div>`;
  const save = async () => {
    setError(null);
    try {
      await api('/marketing/budget', { method: 'PUT', body: { dailyEur: Number(String(edit.daily).replace(',', '.')), weeklyEur: Number(String(edit.weekly).replace(',', '.')) } });
      setEdit(null);
      load();
    } catch (e) {
      setError(e.code === 'daily_above_weekly' ? 'Das Tagesbudget darf nicht über dem Wochenbudget liegen.' : 'Bitte gültige Beträge eingeben.');
    }
  };
  return html`<div class="card budget" style="margin-bottom:12px">
    <div class="inline" style="justify-content:space-between"><div class="label" style="margin:0">Marketing-Budget</div>
      ${owner && !edit ? html`<button class="btn small ghost" onClick=${() => setEdit({ daily: b.dailyEur, weekly: b.weeklyEur })}>Ändern</button>` : null}</div>
    <div class="grid2" style="margin-top:8px">
      <div><div class="kv"><span>Heute</span><span><b>${euro(b.spentTodayEur)}</b> von ${euro(b.dailyEur)}</span></div>${bar(b.spentTodayEur, b.dailyEur)}</div>
      <div><div class="kv"><span>Diese Woche (ab Mo.)</span><span><b>${euro(b.spentWeekEur)}</b> von ${euro(b.weeklyEur)}</span></div>${bar(b.spentWeekEur, b.weeklyEur)}</div>
    </div>
    ${edit ? html`<div class="inline" style="margin-top:10px">
      <label class="inline">Tag <input class="num" inputmode="decimal" value=${edit.daily} onInput=${(e) => setEdit({ ...edit, daily: e.target.value })} /> €</label>
      <label class="inline">Woche <input class="num" inputmode="decimal" value=${edit.weekly} onInput=${(e) => setEdit({ ...edit, weekly: e.target.value })} /> €</label>
      <button class="btn small" onClick=${save}>Speichern</button><button class="btn small ghost" onClick=${() => setEdit(null)}>Abbrechen</button>
    </div>` : null}
    ${error ? html`<p class="error" style="margin:8px 0 0">${error}</p>` : null}
    <p class="note" style="margin:8px 0 0">Vor jedem Aufruf (Claude, Veo, Bilder) reserviert der Agent den Betrag; was nicht mehr ins Budget passt, lässt er aus. Diese Woche: Claude ${euro(data.weekByProvider.anthropic || 0)}, Google ${euro(data.weekByProvider.google || 0)}.</p>
  </div>`;
}

function Characters({ owner }) {
  const [list, setList] = useState(null);
  const [redo, setRedo] = useState({});
  const load = useCallback(() => api('/marketing/characters').then((d) => setList(d.characters)).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  if (!list) return html`<p class="note">Lade …</p>`;
  if (!list.length) return html`<div class="card"><p class="note" style="margin:0">Noch keine Figuren. Der Agent legt sie beim nächsten Lauf mit Bildvorschlägen an.</p></div>`;
  const choose = async (key, url) => { await api(`/marketing/characters/${key}/choose`, { method: 'POST', body: { url } }).catch(() => {}); load(); };
  const askNew = async (key) => { await api(`/marketing/characters/${key}/redo`, { method: 'POST', body: { feedback: redo[key] || '' } }).catch(() => {}); setRedo({ ...redo, [key]: undefined }); load(); };
  return html`<div class="ads">${list.map((c) => html`<div class="card">
    <h3 style="margin:0 0 4px">${c.name}</h3>
    <p class="note" style="margin:0 0 10px">${c.summary}</p>
    <div>${c.chosen ? html`<div class="label">Gewählt</div><img class="ref chosen" src=${c.chosen} alt=${c.name} />` : html`<p class="pill warn">Noch kein Referenzbild gewählt: ohne Bild keine Hero-Videos mit ${c.name}.</p>`}</div>
    <div>${c.wantsNew ? html`<p class="note">Neue Vorschläge kommen beim nächsten Lauf${c.feedback ? ` („${c.feedback}“)` : ''}.</p>` : c.candidates.length ? html`
      <div class="label" style="margin-top:10px">Vorschläge${owner ? ': antippen zum Auswählen' : ''}</div>
      <div class="refs">${c.candidates.map((url) => html`<img key=${url} class=${`ref ${url === c.chosen ? 'chosen' : ''}`} src=${url} alt="" onClick=${() => owner && url !== c.chosen && choose(c.key, url)} />`)}</div>` : null}</div>
    ${owner && !c.wantsNew ? html`<div class="inline" style="margin-top:10px"><input placeholder="Was soll anders sein? (optional)" value=${redo[c.key] || ''} onInput=${(e) => setRedo({ ...redo, [c.key]: e.target.value })} /><button class="btn small ghost" onClick=${() => askNew(c.key)}>Neue Vorschläge</button></div>` : null}
  </div>`)}</div>`;
}

const PRIVACY = { PUBLIC_TO_EVERYONE: 'Öffentlich', FOLLOWER_OF_CREATOR: 'Follower', MUTUAL_FOLLOW_FRIENDS: 'Freunde', SELF_ONLY: 'Nur ich' };
const TIKTOK_RESULT = { ok: 'TikTok ist verbunden.', invalid_state: 'Die TikTok-Anmeldung ist abgelaufen. Bitte noch einmal verbinden.', tiktok_denied: 'Die Anmeldung bei TikTok wurde abgebrochen.', tiktok_failed: 'TikTok hat die Anmeldung abgelehnt (Details unten).' };

function Channels({ owner }) {
  const [data, setData] = useState(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState(() => {
    const r = new URLSearchParams(location.search).get('tiktok');
    return r ? { ok: r === 'ok', text: TIKTOK_RESULT[r] || r } : null;
  });
  const load = useCallback(() => api('/marketing/channels').then(setData).catch(() => setData({ error: true })), []);
  useEffect(() => {
    load();
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  }, [load]);
  if (!data) return html`<p class="note">Lade …</p>`;
  if (data.error) return html`<div class="card">Die Kanäle konnten nicht geladen werden.</div>`;
  const act = async (fn, ok) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e.data?.message || { invalid_token: 'Das sieht nicht wie ein Token aus.', token_rejected: 'Instagram hat den Token abgelehnt.', tiktok_not_configured: 'TIKTOK_CLIENT_KEY und TIKTOK_CLIENT_SECRET fehlen auf Render.' }[e.code] || message(e) });
    }
  };
  const ig = data.instagram;
  const tt = data.tiktok;
  const until = (d) => (d ? new Date(d).toLocaleDateString('de-DE') : '–');
  return html`
    ${msg ? html`<p class=${msg.ok ? 'flash' : 'error'}>${msg.text}</p>` : null}
    <div class="ads">
      <div class="card">
        <h3 style="margin:0 0 6px">Instagram</h3>
        ${ig.connected ? html`
          <${Row} label="Konto">@${ig.username}<//>
          <${Row} label="Token gültig bis">${until(ig.expiresAt)} (wird automatisch erneuert)<//>
          ${ig.lastError ? html`<p class="note bad">${ig.lastError}</p>` : null}
          ${owner ? html`<button class="btn small ghost" style="margin-top:8px" onClick=${() => confirm('Instagram trennen?') && act(() => api('/marketing/channels/instagram', { method: 'DELETE' }), 'Instagram getrennt.')}>Trennen</button>` : null}`
        : html`<p class="note">Nicht verbunden. Token aus der Meta-App (Instagram API → „Token generieren“) einfügen:</p>
          ${owner ? html`<div class="inline"><input type="password" placeholder="Langzeit-Token" value=${token} onInput=${(e) => setToken(e.target.value)} /><button class="btn small" onClick=${() => act(() => api('/marketing/channels/instagram', { method: 'POST', body: { token } }).then(() => setToken('')), 'Instagram ist verbunden.')}>Verbinden</button></div>` : null}`}
      </div>
      <div class="card">
        <h3 style="margin:0 0 6px">TikTok</h3>
        ${!tt.configured ? html`<p class="note">Auf Render fehlen <code>TIKTOK_CLIENT_KEY</code> und <code>TIKTOK_CLIENT_SECRET</code>. In der TikTok-Entwickler-App als Redirect-URI eintragen: <code>${tt.redirectUri}</code></p>`
        : tt.connected ? html`
          <${Row} label="Konto">${tt.username || 'verbunden'}<//>
          <${Row} label="Anmeldung gültig bis">${until(tt.refreshExpiresAt)}<//>
          ${owner ? html`
            <label class="field" style="margin-top:8px"><span>Wie posten?</span>
              <select value=${tt.mode} onChange=${(e) => act(() => api('/marketing/channels/tiktok', { method: 'PUT', body: { mode: e.target.value } }), 'Gespeichert.')}>
                <option value="inbox">Als Entwurf in die TikTok-App</option>
                <option value="direct">Direkt veröffentlichen</option>
              </select></label>
            <p class="note" style="margin:-6px 0 10px">${tt.mode === 'direct' ? 'Mit Text und KI-Kennzeichnung. Solange TikTok die App prüft (auch im Sandbox-Modus), sind direkte Posts nur für dich sichtbar.' : 'Das Video landet als Entwurf in TikTok. Dort Text einfügen, bei KI-Videos „KI-generierter Inhalt“ einschalten, veröffentlichen und hier abhaken; die Karte sagt dir die Schritte.'}</p>
            ${tt.mode === 'direct' ? html`<label class="field"><span>Sichtbarkeit</span>
              <select value=${tt.privacyLevel} onChange=${(e) => act(() => api('/marketing/channels/tiktok', { method: 'PUT', body: { privacyLevel: e.target.value } }), 'Gespeichert.')}>
                ${Object.entries(PRIVACY).map(([k, label]) => html`<option value=${k}>${label}</option>`)}
              </select></label>` : null}` : html`<${Row} label="Modus">${tt.mode === 'direct' ? 'direkt' : 'Entwurf'}<//>`}
          ${tt.lastError ? html`<p class="note bad">${tt.lastError}</p>` : null}
          ${owner ? html`<button class="btn small ghost" onClick=${() => confirm('TikTok trennen?') && act(() => api('/marketing/channels/tiktok', { method: 'DELETE' }), 'TikTok getrennt.')}>Trennen</button>` : null}`
        : html`<p class="note">Nicht verbunden.</p>${tt.lastError ? html`<p class="note bad">${tt.lastError}</p>` : null}
          ${owner ? html`<button class="btn small" onClick=${() => act(async () => { location.href = (await api('/marketing/channels/tiktok/connect')).url; }, 'Weiter zu TikTok …')}>Mit TikTok verbinden</button>` : null}`}
      </div>
    </div>
    <p class="note" style="margin-top:14px">Freigegebene Videos gehen automatisch im nächsten freien Zeitfenster raus (${data.slots.join(' und ')} Uhr, ein Video pro Fenster) auf jedem verbundenen Kanal. KI-Videos kennzeichnet das Backend dabei selbst, außer bei TikTok-Entwürfen. „Jetzt posten“ auf der Karte schickt sofort.</p>`;
}

/**
 * The pending videos one by one, made for the phone: the video big, the
 * decision in thumb reach, then straight to the next one.
 */
function FocusReview({ drafts, owner, onChanged, onList }) {
  const [done, setDone] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const [local, setLocal] = useState({}); // texts saved here, before the list reloads
  const left = drafts.filter((d) => !done.includes(d.id));
  // Skipped ones come last
  const queue = [...left.filter((d) => !skipped.includes(d.id)), ...left.filter((d) => skipped.includes(d.id))];
  const current = queue[0] && { ...queue[0], ...(local[queue[0].id] || {}) };
  // Decided ones drop out of the list when it reloads: count them separately
  const total = done.length + left.length;
  const position = done.length + 1;

  const decide = async (action, feedback) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/marketing/drafts/${current.id}/decision`, { method: 'POST', body: { action, feedback } });
      setDone([...done, current.id]);
      setRejecting(false);
      setEditing(false);
      window.scrollTo(0, 0);
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    setSkipped([...skipped.filter((id) => id !== current.id), current.id]);
    setRejecting(false);
    setEditing(false);
    window.scrollTo(0, 0);
  };

  if (!current) {
    return html`<div class="card focus-done">
      <div style="font-size:44px">🎉</div>
      <h3 style="margin:8px 0 4px">${done.length ? 'Alles durch' : 'Nichts zu tun'}</h3>
      <p class="note" style="margin:0 0 14px">${done.length ? 'Freigegebene Videos gehen im nächsten Zeitfenster automatisch raus.' : 'Gerade wartet nichts. Der Marketing-Agent legt jeden Morgen neue Videos hier ab.'}</p>
      <button class="btn ghost" onClick=${onList}>Zur Liste</button>
    </div>`;
  }
  const poster = current.videoUrl ? current.videoUrl.replace('/video/upload/', '/video/upload/so_2/').replace(/\.mp4$/, '.jpg') : null;
  const [idea, checks] = (current.idea || '').split(/\n\nPrüfung(?: durch Claude)?: /);
  return html`<div class="focus">
    <div class="focus-head">
      <span class="muted">${position} von ${total}</span>
      <button class="btn small ghost" onClick=${onList}>Als Liste</button>
    </div>
    ${current.videoUrl ? html`<video key=${current.id} class="focus-video" src=${current.videoUrl} poster=${poster} controls playsinline preload="metadata"></video>` : null}
    <h3 style="margin:12px 0 6px">${current.title}</h3>
    <div class="inline" style="margin-bottom:8px">
      <span class="pill">${TEMPLATE_LABELS[current.template] || current.template}</span>
      ${current.ai ? html`<span class="pill warn">KI</span>` : null}
      ${musicPill(current)}
      ${current.seconds ? html`<span class="pill">${current.seconds} s</span>` : null}
      ${current.costEur != null ? html`<span class="pill">${euro(current.costEur)}</span>` : null}
    </div>
    ${checks ? html`<p class="note warn" style="margin:0 0 8px">⚠︎ ${checks}</p>` : null}
    ${idea ? html`<p class="note" style="margin:0 0 10px">${idea}</p>` : null}
    <${SoundTip} draft=${current} compact />
    ${editing
      ? html`<${TextEditor} draft=${current} onSaved=${(saved) => { setLocal({ ...local, [saved.id]: { captions: saved.captions, hashtags: saved.hashtags } }); setEditing(false); onChanged(); }} onCancel=${() => setEditing(false)} />`
      : html`<div class="caption focus-caption" onClick=${() => owner && setEditing(true)}>
          <div class="inline" style="justify-content:space-between"><span class="label" style="margin:0">Instagram</span>${owner ? html`<span class="note">Tippen zum Bearbeiten</span>` : null}</div>
          <p>${postText(current, 'instagram')}</p>
        </div>`}
    ${error ? html`<p class="error">${error}</p>` : null}
    ${owner ? html`<div class="focus-actions">
      ${rejecting
        ? html`<${RejectPicker} busy=${busy} onReject=${(feedback) => decide('reject', feedback)} onCancel=${() => setRejecting(false)} />`
        : html`<div class="focus-buttons">
            <button class="btn ghost big" disabled=${busy} onClick=${() => setRejecting(true)}>Nein</button>
            <button class="btn ghost" disabled=${busy || queue.length < 2} onClick=${skip} title="Später">Später</button>
            <button class="btn big" disabled=${busy} onClick=${() => decide('approve')}>Posten</button>
          </div>`}
    </div>` : null}
  </div>`;
}

function Approvals({ role, onCount }) {
  const owner = role === 'owner';
  const [filter, setFilter] = useState('pending');
  const [data, setData] = useState(null);
  const [connected, setConnected] = useState({});
  // One by one on the phone, as a list on bigger screens; the choice is kept
  const [focus, setFocus] = useState(() => {
    try {
      const saved = localStorage.getItem('yap-focus');
      if (saved) return saved === '1';
    } catch {}
    return window.matchMedia('(max-width: 600px)').matches;
  });
  const setFocusKept = (on) => {
    setFocus(on);
    try { localStorage.setItem('yap-focus', on ? '1' : '0'); } catch {}
    window.scrollTo(0, 0);
  };
  const load = useCallback(() => {
    if (filter === 'settings') return;
    api(`/marketing/drafts?status=${filter}`).then((d) => {
      setData(d);
      onCount(d.counts.pending || 0);
    }).catch(() => setData({ drafts: [], counts: {}, error: true }));
  }, [filter]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useEffect(() => {
    api('/marketing/channels').then((d) => setConnected({ instagram: !!d.instagram?.connected, tiktok: !!d.tiktok?.connected })).catch(() => {});
  }, [filter]);
  const counts = data?.counts || {};
  const drafts = data?.drafts || [];
  // Freigegeben: what needs a person first, then what waits for its slot
  const sorted = filter === 'approved' ? [...drafts.filter((d) => needsLook(d, connected)), ...drafts.filter((d) => !needsLook(d, connected))] : drafts;
  const EMPTY = {
    pending: 'Nichts zu tun. Der Marketing-Agent legt jeden Morgen neue Videos hier ab.',
    approved: 'Alles draußen. Freigegebene Videos warten hier auf ihr Zeitfenster oder darauf, dass du etwas erledigst.',
    posted: 'Noch nichts gepostet.',
    rejected: 'Nichts verworfen.',
  };
  if (filter === 'settings') {
    return html`
      <button class="btn small ghost" style="margin-bottom:12px" onClick=${() => setFilter('pending')}>‹ Zurück zu den Videos</button>
      <h2 class="section">Budget</h2>
      <${BudgetCard} owner=${owner} />
      <h2 class="section">Kanäle</h2>
      <${Channels} owner=${owner} />
      <h2 class="section">Figuren</h2>
      <${Characters} owner=${owner} />`;
  }
  return html`
    <div class="now"><div class="tabs subtabs">${Object.entries(APPROVAL_FILTERS).map(([k, label]) => html`<button class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${label}${counts[k] ? html` <span class=${k === 'pending' ? 'count' : 'muted'}>${counts[k]}</span>` : null}</button>`)}</div></div>
    <${BudgetLine} onOpen=${() => setFilter('settings')} />
    ${!data ? html`<p class="note">Lade …</p>`
      : data.error ? html`<div class="card">Die Entwürfe konnten nicht geladen werden.</div>`
      : filter === 'pending' && focus ? html`<${FocusReview} drafts=${drafts} owner=${owner} onChanged=${load} onList=${() => setFocusKept(false)} />`
      : drafts.length === 0 ? html`<div class="card"><p class="note" style="margin:0">${EMPTY[filter]}</p></div>`
      : filter === 'posted' || filter === 'rejected' ? html`<${DraftList} drafts=${drafts} tab=${filter} owner=${owner} connected=${connected} onChanged=${load} />`
      : html`${filter === 'pending' && drafts.length > 1 ? html`<div class="inline" style="justify-content:flex-end;margin-bottom:10px"><button class="btn small ghost" onClick=${() => setFocusKept(true)}>Nacheinander prüfen</button></div>` : null}
        ${filter === 'approved' ? html`<p class="note" style="margin:0 0 10px">Sobald ein Video überall draußen ist, wandert es nach „Gepostet“.</p>` : null}
        <div class="ads">${sorted.map((d) => html`<${AdDraftCard} key=${d.id} draft=${d} owner=${owner} connected=${connected} onChanged=${load} compact=${filter === 'approved'} />`)}</div>`}
  `;
}

// --- Anmeldung mit Face ID (lib/adminPasskeys.js) ----------------------------------------

const PASSKEY_ERRORS = {
  invalid_code: 'Der Code stimmt nicht. Nimm den aktuellen aus der Authenticator-App.',
  passkey_exists: 'Dieser Passkey ist schon eingerichtet.',
  passkey_too_many: 'Höchstens 10 Passkeys.',
  passkey_expired: 'Zu lange gewartet. Bitte noch einmal.',
  passkey_invalid: 'Das Gerät hat keinen gültigen Passkey geliefert (Face ID oder Code nötig).',
};

function Passkeys() {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(() => api('/passkeys').then((d) => setList(d.passkeys)).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load]);
  if (!list) return null;
  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { options } = await api('/passkeys/options', { method: 'POST', body: { code } });
      const response = await passkeyCreate(options);
      const d = await api('/passkeys', { method: 'POST', body: { response } });
      setList(d.passkeys);
      keep(PASSKEY_KEPT, '1');
      setAdding(false);
      setCode('');
      setMsg({ ok: true, text: 'Face ID ist eingerichtet. Beim nächsten Anmelden reicht ein Blick.' });
    } catch (e) {
      if (!cancelled(e)) setMsg({ ok: false, text: PASSKEY_ERRORS[e.code] || message(e) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id) => {
    if (!confirm('Diesen Passkey entfernen? Mit ihm kann sich dann niemand mehr anmelden.')) return;
    const d = await api(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    if (d) setList(d.passkeys);
  };
  return html`<div class="card" style="margin-bottom:12px">
    <h3 style="margin:0 0 6px">Anmeldung mit Face ID</h3>
    ${msg ? html`<p class=${msg.ok ? 'flash' : 'error'}>${msg.text}</p>` : null}
    <p class="note" style="margin:0 0 10px">Ein Passkey ersetzt Passwort und Code: Face ID oder Touch ID genügt. Er wird mit deinem iCloud-Schlüsselbund auf deine Apple-Geräte übertragen.</p>
    ${list.map((p) => html`<${Row} label=${p.name || 'Passkey'}>seit ${date(p.createdAt)}${p.lastUsedAt ? `, zuletzt ${dateTime(p.lastUsedAt)}` : ''} <button class="btn small ghost" onClick=${() => remove(p.id)}>Entfernen</button><//>`)}
    ${!hasPasskeys() ? html`<p class="note" style="margin:0">Dieser Browser kann keine Passkeys.</p>`
      : adding ? html`<div style="margin-top:8px">
          <${Field} label="Code aus der Authenticator-App" value=${code} onInput=${(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} autocomplete="one-time-code" inputmode="numeric" className="code" />
          <div class="inline"><button class="btn small" disabled=${busy || code.length !== 6} onClick=${add}>Weiter mit Face ID</button><button class="btn small ghost" disabled=${busy} onClick=${() => setAdding(false)}>Abbrechen</button></div>
        </div>`
      : html`<button class="btn small" style="margin-top:8px" onClick=${() => setAdding(true)}>${list.length ? 'Weiteres Gerät einrichten' : 'Face ID einrichten'}</button>`}
  </div>`;
}

// --- Mitteilungen: Web Push on this device (lib/adminPush.js, sw.js) -------------------

const NOTIFY_LABELS = {
  approvals: ['Neue Videos zur Freigabe', 'Wenn der Marketing-Agent Videos vorbereitet hat'],
  posting: ['Posten', 'Online auf Instagram oder TikTok, TikTok-Entwurf wartet, Fehler'],
  support: ['Support', 'Neue Anfragen und Antworten aus der App'],
  reports: ['Meldungen', 'Wenn jemand in der App etwas meldet'],
  daily: ['Tageszahlen', 'Neue Nutzer, aktive Nutzer, Gespräche, Website, Warteliste'],
  alerts: ['Störungen', 'Wenn etwas kaputt ist, z. B. Bestätigungsmails nicht rausgehen'],
};
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const keyBytes = (base64url) => {
  const raw = atob((base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

function Notify() {
  const [data, setData] = useState(null);
  const [mine, setMine] = useState(null); // this device's subscription
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    const d = await api('/push').catch(() => ({ error: true }));
    setData(d);
    if (pushSupported()) {
      const reg = await navigator.serviceWorker.getRegistration('./');
      setMine((await reg?.pushManager.getSubscription()) || null);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!data) return html`<p class="note">Lade …</p>`;
  if (data.error) return html`<div class="card">Die Einstellungen konnten nicht geladen werden.</div>`;

  const run = async (fn, ok) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e.message && !e.status ? e.message : message(e) });
    } finally {
      setBusy(false);
    }
  };
  const enable = () => run(async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Mitteilungen sind für die Konsole nicht erlaubt. Einstellungen → Mitteilungen → Yap Admin.');
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.publicKey) }));
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  }, 'Mitteilungen sind auf diesem Gerät an.');
  const disable = () => run(async () => {
    if (mine) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: mine.endpoint } });
      await mine.unsubscribe();
    }
  }, 'Auf diesem Gerät aus.');
  const save = (patch) => run(() => api('/push/settings', { method: 'PUT', body: patch }).then(setData));
  const here = mine && data.devices.some((d) => d.endpoint === mine.endpoint);

  return html`
    ${msg ? html`<p class=${msg.ok ? 'flash' : 'error'}>${msg.text}</p>` : null}
    <div class="card" style="margin-bottom:12px">
      <h3 style="margin:0 0 6px">Dieses Gerät</h3>
      ${!pushSupported() ? html`<p class="note" style="margin:0">${isIOS() && !standalone()
          ? 'Auf dem iPhone gehen Mitteilungen nur aus der Konsole auf dem Home-Bildschirm: in Safari Teilen → „Zum Home-Bildschirm“, die Konsole dort öffnen und hier einschalten.'
          : 'Dieser Browser kann keine Mitteilungen empfangen.'}</p>`
        : here ? html`<p style="margin:0 0 10px">Mitteilungen sind hier <b>an</b>.</p>
            <div class="inline"><button class="btn small" disabled=${busy} onClick=${() => run(() => api('/push/test', { method: 'POST' }), 'Test verschickt. Sie sollte gleich erscheinen.')}>Test-Mitteilung</button>
            <button class="btn small ghost" disabled=${busy} onClick=${disable}>Hier ausschalten</button></div>`
        : html`<p class="note" style="margin:0 0 10px">${Notification.permission === 'denied' ? 'Mitteilungen sind für die Konsole blockiert. Auf dem iPhone: Einstellungen → Mitteilungen → Yap Admin.' : 'Neue Videos zur Freigabe, Support, Meldungen und die Tageszahlen als Mitteilung aufs Handy.'}</p>
            <button class="btn" disabled=${busy || Notification.permission === 'denied'} onClick=${enable}>Mitteilungen einschalten</button>`}
    </div>
    <div class="card" style="margin-bottom:12px">
      <h3 style="margin:0 0 6px">Worüber</h3>
      ${data.kinds.map((k) => html`<label class="check toggle"><input type="checkbox" checked=${data.notify[k]} disabled=${busy} onChange=${(e) => save({ [k]: e.target.checked })} />
        <span><b>${NOTIFY_LABELS[k][0]}</b><br /><span class="note">${NOTIFY_LABELS[k][1]}</span></span></label>`)}
      ${data.kinds.includes('daily') && data.notify.daily ? html`<label class="field" style="margin-top:6px"><span>Tageszahlen um</span>
        <select value=${data.notify.dailyHour} disabled=${busy} onChange=${(e) => save({ dailyHour: Number(e.target.value) })}>
          ${Array.from({ length: 24 }, (_, h) => html`<option value=${h}>${String(h).padStart(2, '0')}:00 Uhr</option>`)}
        </select></label>` : null}
    </div>
    <div class="card">
      <h3 style="margin:0 0 6px">Deine Geräte</h3>
      ${data.devices.length ? data.devices.map((d) => html`<${Row} label=${d.device + (mine && d.endpoint === mine.endpoint ? ' (dieses)' : '')}>seit ${date(d.createdAt)}${d.lastSentAt ? `, zuletzt ${dateTime(d.lastSentAt)}` : ''}<//>`)
        : html`<p class="note" style="margin:0">Noch kein Gerät.</p>`}
    </div>`;
}

// The open page lives in the URL hash (#users/<id>, #support/<ticket>, …), so a
// reload, the home-screen app coming back and the back button keep it.
const readRoute = () => {
  const [tab, id] = decodeURIComponent(location.hash.slice(1)).split('/');
  return { tab: tab || 'dashboard', id: id || null };
};

function App() {
  const [state, setState] = useState({ loading: true });
  const [route, setRoute] = useState(readRoute);
  const [openReports, setOpenReports] = useState(0);
  const [openTickets, setOpenTickets] = useState(0);
  const [openApprovals, setOpenApprovals] = useState(0);
  const [momentsOf, setMomentsOf] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { admin } = await api('/me');
        setState({ admin });
      } catch {
        const { setupNeeded } = await api('/auth/state').catch(() => ({ setupNeeded: false }));
        setState({ setupNeeded });
      }
    })();
  }, []);

  useEffect(() => {
    if (!state.admin || state.admin.role === 'viewer') return;
    api('/reports').then((d) => setOpenReports(d.reports.length)).catch(() => {});
    api('/tickets').then((d) => setOpenTickets(d.counts.open || 0)).catch(() => {});
  }, [state.admin]);

  useEffect(() => {
    if (!state.admin) return;
    api('/marketing/drafts').then((d) => setOpenApprovals(d.counts.pending || 0)).catch(() => {});
  }, [state.admin]);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Push tapped while the console was open (sw.js): go to its page
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
    const onMessage = (e) => {
      if (e.data?.type === 'open' && typeof e.data.hash === 'string') location.hash = e.data.hash;
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // The number on the home-screen icon: what is waiting
  useEffect(() => {
    if (!state.admin || !navigator.setAppBadge) return;
    const n = openApprovals + openTickets + openReports;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }, [state.admin, openApprovals, openTickets, openReports]);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setState({ setupNeeded: false });
  };

  if (state.loading) return html`<div class="center note">Lade …</div>`;
  if (!state.admin) {
    return state.setupNeeded
      ? html`<${Setup} onDone=${(admin) => setState({ admin })} />`
      : html`<${Login} onDone=${(admin) => setState({ admin })} />`;
  }

  const role = state.admin.role;
  const tabs = ['dashboard', ...(role !== 'viewer' ? ['users', 'reports', 'moments', 'support'] : []), 'waitlist', 'approvals', 'app', ...(role === 'owner' ? ['audit'] : []), 'notify'];
  const tab = tabs.includes(route.tab) ? route.tab : 'dashboard';
  const nav = (next, id = null) => {
    const hash = id ? `#${next}/${encodeURIComponent(id)}` : `#${next}`;
    if (location.hash !== hash) {
      location.hash = hash;
      window.scrollTo(0, 0);
    }
    setRoute({ tab: next, id });
  };
  const go = (next) => nav(next);
  const openUser = (id) => nav('users', id);
  const userId = tab === 'users' ? route.id : null;
  const setUserId = (id) => nav('users', id);

  let body;
  if (tab === 'users') {
    body = userId
      ? html`<${UserDetail} id=${userId} role=${role} onBack=${() => setUserId(null)} onChanged=${() => setUserId(null)} onMoments=${(u) => { setMomentsOf(u); go('moments'); }} />`
      : html`<${Users} onOpen=${setUserId} />`;
  } else if (tab === 'reports') {
    body = html`<${Reports} role=${role} onOpenUser=${openUser} onCount=${setOpenReports} />`;
  } else if (tab === 'moments') {
    body = html`<${Moments} onOpenUser=${openUser} userId=${momentsOf?.id} userName=${momentsOf?.name} onClearUser=${() => setMomentsOf(null)} />`;
  } else if (tab === 'support') {
    body = html`<${Tickets} openId=${tab === 'support' ? route.id : null} onOpen=${(id) => nav('support', id)} onOpenUser=${openUser} onCount=${setOpenTickets} />`;
  } else if (tab === 'app') {
    body = html`<${AppSettings} role=${role} />`;
  } else if (tab === 'audit') {
    body = html`<${Audit} />`;
  } else if (tab === 'waitlist') {
    body = html`<${Waitlist} role=${role} />`;
  } else if (tab === 'approvals') {
    body = html`<${Approvals} role=${role} onCount=${setOpenApprovals} />`;
  } else if (tab === 'notify') {
    body = html`<${Passkeys} /><${Notify} />`;
  } else {
    body = html`<${Dashboard} onGo=${go} />`;
  }

  return html`<div class="wrap">
    <div class="topbar">
      <${Brand} />
      <div class="tabs">
        <button class=${tab === 'dashboard' ? 'on' : ''} onClick=${() => go('dashboard')}>Übersicht</button>
        ${role !== 'viewer' ? html`<button class=${tab === 'users' ? 'on' : ''} onClick=${() => go('users')}>Nutzer</button>
        <button class=${tab === 'reports' ? 'on' : ''} onClick=${() => go('reports')}>Meldungen${openReports ? html` <span class="count">${openReports}</span>` : null}</button>
        <button class=${tab === 'moments' ? 'on' : ''} onClick=${() => { setMomentsOf(null); go('moments'); }}>Moments</button>
        <button class=${tab === 'support' ? 'on' : ''} onClick=${() => go('support')}>Support${openTickets ? html` <span class="count">${openTickets}</span>` : null}</button>` : null}
        <button class=${tab === 'waitlist' ? 'on' : ''} onClick=${() => go('waitlist')}>Warteliste</button>
        <button class=${tab === 'approvals' ? 'on' : ''} onClick=${() => go('approvals')}>Freigabe${openApprovals ? html` <span class="count">${openApprovals}</span>` : null}</button>
        <button class=${tab === 'app' ? 'on' : ''} onClick=${() => go('app')}>App</button>
        ${role === 'owner' ? html`<button class=${tab === 'audit' ? 'on' : ''} onClick=${() => go('audit')}>Protokoll</button>` : null}
      </div>
      <span class="spacer"></span>
      <span class="who">${state.admin.email}</span>
      <button class=${`btn small ghost bell ${tab === 'notify' ? 'on' : ''}`} title="Einstellungen: Mitteilungen und Face ID" aria-label="Einstellungen" onClick=${() => go('notify')}>⚙︎</button>
      <button class="btn small ghost" onClick=${logout}>Abmelden</button>
    </div>
    ${body}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
