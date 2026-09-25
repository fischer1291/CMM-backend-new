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
  return html`<div class="brand"><span class="dot"></span>Call Me Maybe <span class="muted" style="font-weight:500">Admin</span></div>`;
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

function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
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
    <p>Mit Passwort und dem Code aus deiner Authenticator-App.</p>
    ${error ? html`<p class="error">${error}</p>` : null}
    <${Field} label="E-Mail" type="email" value=${email} onInput=${setEmail} autocomplete="username" autofocus />
    <${Field} label="Passwort" type="password" value=${password} onInput=${setPassword} autocomplete="current-password" />
    <${Field} label="Code" value=${code} onInput=${(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} autocomplete="one-time-code" inputmode="numeric" className="code" />
    <button class="btn" style="width:100%" disabled=${busy || code.length !== 6}>Anmelden</button>
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
      <thead><tr><th>Anmeldewoche</th><th>Neu</th>${Array.from({ length: max }, (_, i) => html`<th style="text-align:center">Woche ${i + 1}</th>`)}</tr></thead>
      <tbody>${cohorts.map((c) => html`<tr>
        <td>ab ${shortDay(c.week)}</td><td>${num(c.size)}</td>
        ${Array.from({ length: max }, (_, i) => {
          const v = c.weeks[i];
          return html`<td class="cell" style=${v == null ? '' : `background:rgba(0,229,255,${0.06 + v * 0.4})`}>${v == null ? '' : pct(v)}</td>`;
        })}
      </tr>`)}</tbody>
    </table>
    <p class="note" style="margin:10px 0 0">Anteil einer Anmeldewoche, der in den Folgewochen die App genutzt oder telefoniert hat.</p>
  </div>`;
}

function Dashboard() {
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

// --- App -------------------------------------------------------------------------

function App() {
  const [state, setState] = useState({ loading: true });
  const [tab, setTab] = useState('dashboard');

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

  return html`<div class="wrap">
    <div class="topbar">
      <${Brand} />
      <div class="tabs">
        <button class=${tab === 'dashboard' ? 'on' : ''} onClick=${() => setTab('dashboard')}>Übersicht</button>
        ${state.admin.role === 'owner' ? html`<button class=${tab === 'audit' ? 'on' : ''} onClick=${() => setTab('audit')}>Protokoll</button>` : null}
      </div>
      <span class="spacer"></span>
      <span class="who">${state.admin.email}</span>
      <button class="btn small ghost" onClick=${logout}>Abmelden</button>
    </div>
    ${tab === 'audit' ? html`<${Audit} />` : html`<${Dashboard} />`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
