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


// --- Users -------------------------------------------------------------------------

const PLATFORM = { ios: 'iOS', android: 'Android' };
const dateTime = (d) => (d ? new Date(d).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
const date = (d) => (d ? new Date(d).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : '–');
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

function Tickets({ onOpenUser, onCount }) {
  const [status, setStatus] = useState('open');
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
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

  if (openId) return html`<${Ticket} id=${openId} onBack=${() => { setOpenId(null); load(); }} onOpenUser=${onOpenUser} />`;
  return html`
    <div class="now"><div class="tabs">${Object.entries(TICKET_STATUS).map(([k, label]) => html`<button class=${status === k ? 'on' : ''} onClick=${() => setStatus(k)}>${label}${data?.counts?.[k] ? html` <span class="muted">${data.counts[k]}</span>` : null}</button>`)}</div></div>
    ${!data ? html`<p class="note">Lade …</p>` : data.tickets.length === 0 ? html`<div class="card"><p class="note" style="margin:0">${status === 'open' ? 'Keine offenen Anfragen. 🎉' : 'Nichts hier.'}</p></div>` : html`<div class="card" style="padding:6px 8px"><table class="rows">
      <thead><tr><th></th><th>Von</th><th>Art</th><th>Letzte Nachricht</th><th>App</th><th>Aktualisiert</th></tr></thead>
      <tbody>${data.tickets.map((t) => html`<tr class="click" onClick=${() => setOpenId(t.id)}>
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
        },
      });
      setFlash('Gespeichert. Offene Apps bekommen es sofort, alle anderen beim nächsten Start.');
      load();
    } catch (err) {
      const msg = { invalid_version: 'Version im Format 1.2.3', invalid_build: 'Build ist eine Zahl', invalid_url: 'Link muss mit https:// beginnen', banner_text_required: 'Banner braucht einen Text', invalid_flags: 'Flag-Namen: kleinbuchstaben_mit_unterstrich' };
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
    </div>
    ${owner ? html`<div class="inline" style="justify-content:flex-end"><button class="btn" onClick=${save}>Speichern</button></div>` : html`<p class="note">Nur Owner können Einstellungen ändern.</p>`}

    <div class="section">App-Versionen <span class="note">(aktiv in den letzten 30 Tagen)</span></div>
    <div class="card">${data.versions.length ? html`<table>
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

// --- App -------------------------------------------------------------------------

function App() {
  const [state, setState] = useState({ loading: true });
  const [tab, setTab] = useState('dashboard');
  const [userId, setUserId] = useState(null);
  const [openReports, setOpenReports] = useState(0);
  const [openTickets, setOpenTickets] = useState(0);
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
  const go = (next) => {
    setTab(next);
    setUserId(null);
  };
  const openUser = (id) => {
    setTab('users');
    setUserId(id);
  };

  let body;
  if (tab === 'users') {
    body = userId
      ? html`<${UserDetail} id=${userId} role=${role} onBack=${() => setUserId(null)} onChanged=${() => setUserId(null)} onMoments=${(u) => { setMomentsOf(u); setTab('moments'); setUserId(null); }} />`
      : html`<${Users} onOpen=${setUserId} />`;
  } else if (tab === 'reports') {
    body = html`<${Reports} role=${role} onOpenUser=${openUser} onCount=${setOpenReports} />`;
  } else if (tab === 'moments') {
    body = html`<${Moments} onOpenUser=${openUser} userId=${momentsOf?.id} userName=${momentsOf?.name} onClearUser=${() => setMomentsOf(null)} />`;
  } else if (tab === 'support') {
    body = html`<${Tickets} onOpenUser=${openUser} onCount=${setOpenTickets} />`;
  } else if (tab === 'app') {
    body = html`<${AppSettings} role=${role} />`;
  } else if (tab === 'audit') {
    body = html`<${Audit} />`;
  } else {
    body = html`<${Dashboard} />`;
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
        <button class=${tab === 'app' ? 'on' : ''} onClick=${() => go('app')}>App</button>
        ${role === 'owner' ? html`<button class=${tab === 'audit' ? 'on' : ''} onClick=${() => go('audit')}>Protokoll</button>` : null}
      </div>
      <span class="spacer"></span>
      <span class="who">${state.admin.email}</span>
      <button class="btn small ghost" onClick=${logout}>Abmelden</button>
    </div>
    ${body}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
