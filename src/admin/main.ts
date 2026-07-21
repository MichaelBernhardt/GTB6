import './styles.css';

interface Point { time: string; value?: number; singleplayer?: number; multiplayer?: number; dau?: number; wau?: number; mau?: number; }
interface MissionRow { missionId: string; starts: number; completions: number; failures: number; completionRate: number; medianCompletionSeconds: number; }
interface ErrorRow { fingerprint: string; message: string; errorType: string; severity: string; build: string; browser: string; platform: string; count: number; affectedSessions: number; firstSeen: string; lastSeen: string; }
interface CountryRow { country: string; sessions: number; uniquePlayers: number; share: number; }
interface DashboardData {
  generatedAt: string;
  live: { playingNow: number; singleplayer: number; multiplayer: number; multiplayerConnected: number; multiplayerCapacity?: number; hotBakkiePhase?: string; inactive: number; peak24h: number; sessions: number; uniquePlayers: number; medianPlaytimeSeconds: number; technicalCrashes: number; errorFreeSessionRate: number; };
  geography: CountryRow[];
  series: { concurrency: Point[]; activeUsers: Point[]; sessions: Point[]; playtime: Point[]; returningRate: Point[]; crashes: Point[]; fps: Point[]; };
  gameplay: { missions: MissionRow[]; deaths: number; vehicleCrashes: number; aircraftCrashes: number; multiplayer: { joins: number; leaves: number; peakConcurrency: number; kills: number; deaths: number; }; hotBakkie: { starts: number; deliveries: number; timeouts: number; deliveryRate: number; }; };
  technical: ErrorRow[];
  operations: { uptimeSeconds: number; build: string; database: { kind: string; available: boolean }; lastTelemetryAt?: string; analyticsSecretPersistent: boolean; };
}

const app = document.querySelector<HTMLElement>('#admin-app')!;
if (!app) throw new Error('Admin app container not found');
let range = '24h'; let refreshTimer: ReturnType<typeof setInterval> | undefined; let refreshing = false;
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
const number = (value: number): string => Math.round(value).toLocaleString();
const duration = (seconds: number): string => seconds < 60 ? `${Math.round(seconds)}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m`;
const dateTime = (value?: string): string => value ? new Date(value).toLocaleString() : 'Never';
let regionNames: Intl.DisplayNames | undefined;
try { regionNames = new Intl.DisplayNames([navigator.language], { type: 'region' }); } catch { regionNames = undefined; }
const countryName = (code: string): string => code === 'ZZ' ? 'Unknown' : regionNames?.of(code) ?? code;

function showLogin(message = ''): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = undefined; }
  app.innerHTML = `<main class="shell-state"><p class="eyebrow">CITY CONTROL</p><h1>Game analytics</h1><p>Anonymous operational and gameplay signals. Admin access only.</p>${message ? `<p class="error-message" role="alert">${escapeHtml(message)}</p>` : ''}<form class="login-form"><label>Shared admin password<input name="password" type="password" autocomplete="current-password" required autofocus></label><button class="button" type="submit">Sign in</button></form></main>`;
  app.querySelector('form')?.addEventListener('submit', (event) => { event.preventDefault(); void login(new FormData(event.currentTarget as HTMLFormElement).get('password')); });
}

async function login(password: FormDataEntryValue | null): Promise<void> {
  const button = app.querySelector<HTMLButtonElement>('button'); if (button) { button.disabled = true; button.textContent = 'Checking…'; }
  try {
    const response = await fetch('/api/admin/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: String(password ?? '') }) });
    if (!response.ok) { const body = await response.json() as { error?: string }; showLogin(response.status === 401 ? 'That password did not match.' : body.error ?? 'Sign-in failed.'); return; }
    await refresh();
  } catch { showLogin('The analytics server could not be reached.'); }
}

function lineChart(label: string, points: Point[], keys: Array<{ key: keyof Point; name: string; className?: string }> = [{ key: 'value', name: label }]): string {
  const values = points.flatMap((point) => keys.map(({ key }) => Number(point[key]) || 0)); const max = Math.max(1, ...values);
  if (!points.length || values.every((value) => value === 0)) return `<div class="empty-chart" role="img" aria-label="${escapeHtml(label)}: no data in this range">No data yet</div>`;
  const width = 640; const height = 180; const left = 35; const top = 10; const plotWidth = width - left - 8; const plotHeight = height - 35;
  const path = (key: keyof Point) => points.map((point, index) => {
    const x = left + (points.length === 1 ? plotWidth / 2 : index / (points.length - 1) * plotWidth); const y = top + plotHeight - (Number(point[key]) || 0) / max * plotHeight;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const first = new Date(points[0]!.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); const last = new Date(points.at(-1)!.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)} chart, maximum ${number(max)}"><line class="grid" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}"/><line class="grid" x1="${left}" y1="${top + plotHeight}" x2="${width - 8}" y2="${top + plotHeight}"/><text x="2" y="18">${number(max)}</text><text x="${left}" y="${height - 5}">${escapeHtml(first)}</text><text x="${width - 70}" y="${height - 5}">${escapeHtml(last)}</text>${keys.map(({ key, name, className }, index) => { const style = className ?? (index === 1 ? 'secondary' : index === 2 ? 'tertiary' : ''); return `<path class="line ${style}" d="${path(key)}"><title>${escapeHtml(name)}</title></path>`; }).join('')}</svg>`;
}

function metric(label: string, value: string, primary = false): string { return `<article class="metric${primary ? ' primary' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`; }
function statList(values: Array<[string, string]>): string { return `<dl class="stat-list">${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`; }

function render(data: DashboardData): void {
  const missions = data.gameplay.missions.length ? data.gameplay.missions.map((mission) => `<tr><td class="mission-name">${escapeHtml(mission.missionId)}</td><td>${number(mission.starts)}</td><td>${number(mission.completions)}</td><td>${number(mission.failures)}</td><td>${mission.completionRate}%</td><td>${duration(mission.medianCompletionSeconds)}</td></tr>`).join('') : '<tr><td colspan="6">No mission events in this range.</td></tr>';
  const errors = data.technical.length ? data.technical.map((error) => `<tr><td><code>${escapeHtml(error.fingerprint.slice(0, 10))}</code></td><td><strong>${escapeHtml(error.errorType)}</strong><br>${escapeHtml(error.message)}</td><td><span class="severity ${error.severity === 'fatal' ? 'fatal' : ''}">${escapeHtml(error.severity)}</span></td><td>${number(error.affectedSessions)} / ${number(error.count)}</td><td>${escapeHtml(error.build)}<br>${escapeHtml(error.browser)} · ${escapeHtml(error.platform)}</td><td>${dateTime(error.firstSeen)}<br>${dateTime(error.lastSeen)}</td></tr>`).join('') : '<tr><td colspan="6">No technical errors in this range.</td></tr>';
  const countries = data.geography?.length ? data.geography.map((country) => `<tr><td><strong>${escapeHtml(countryName(country.country))}</strong> <code>${escapeHtml(country.country)}</code></td><td>${number(country.sessions)}</td><td>${number(country.uniquePlayers)}</td><td>${country.share}%</td></tr>`).join('') : '<tr><td colspan="4">No country data in this range.</td></tr>';
  app.innerHTML = `<main class="dashboard"><header class="topbar"><div><p class="eyebrow">CITY CONTROL</p><h1>Game analytics</h1></div><div class="topbar-actions"><label><span class="eyebrow">Range</span><select class="range-select" aria-label="Dashboard range"><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></select></label><button class="button secondary" id="refresh" type="button">Refresh</button><button class="button secondary" id="logout" type="button">Log out</button></div></header><p class="refresh-note" aria-live="polite">Updated ${dateTime(data.generatedAt)} · refreshes every 15 seconds · ${number(data.live.inactive)} recent inactive/menu sessions</p>
    <h2 class="section-title">Live pulse</h2><section class="cards" aria-label="Live metrics">${metric('Playing now', number(data.live.playingNow), true)}${metric('Single-player', number(data.live.singleplayer))}${metric('Multiplayer', number(data.live.multiplayer))}${metric('24-hour peak', number(data.live.peak24h))}${metric('Sessions', number(data.live.sessions))}${metric('Unique players', number(data.live.uniquePlayers))}${metric('Median playtime', duration(data.live.medianPlaytimeSeconds))}${metric('Technical crashes', number(data.live.technicalCrashes))}${metric('Error-free sessions', `${data.live.errorFreeSessionRate}%`)}</section>
    <h2 class="section-title">Audience geography</h2><article class="panel"><div class="table-wrap"><table><thead><tr><th>Country</th><th>Sessions</th><th>Unique players</th><th>Share</th></tr></thead><tbody>${countries}</tbody></table></div><p class="data-credit">Country estimates only. IP addresses are discarded after lookup. This product includes GeoLite2 Data created by MaxMind, available from <a href="https://www.maxmind.com" rel="noreferrer">maxmind.com</a>.</p></article>
    <h2 class="section-title">Trends</h2><section class="charts"><article class="panel"><h3>Concurrency · single / multi</h3>${lineChart('Concurrency', data.series.concurrency, [{ key: 'value', name: 'All' }, { key: 'singleplayer', name: 'Single-player', className: 'secondary' }, { key: 'multiplayer', name: 'Multiplayer', className: 'tertiary' }])}</article><article class="panel"><h3>DAU / WAU / MAU</h3>${lineChart('Active users', data.series.activeUsers, [{ key: 'dau', name: 'DAU' }, { key: 'wau', name: 'WAU', className: 'secondary' }, { key: 'mau', name: 'MAU', className: 'tertiary' }])}</article><article class="panel"><h3>Sessions</h3>${lineChart('Sessions', data.series.sessions)}</article><article class="panel"><h3>Playtime · minutes</h3>${lineChart('Playtime in minutes', data.series.playtime)}</article><article class="panel"><h3>Returning-player rate · %</h3>${lineChart('Returning-player rate', data.series.returningRate)}</article><article class="panel"><h3>Technical crashes</h3>${lineChart('Technical crashes', data.series.crashes)}</article><article class="panel"><h3>Rolling FPS</h3>${lineChart('Rolling frames per second', data.series.fps)}</article></section>
    <h2 class="section-title">Gameplay</h2><section class="gameplay-grid"><article class="panel"><h3>Player and vehicle outcomes</h3>${statList([['Player deaths', number(data.gameplay.deaths)], ['Vehicle crashes', number(data.gameplay.vehicleCrashes)], ['Aircraft crashes', number(data.gameplay.aircraftCrashes)]])}</article><article class="panel"><h3>Multiplayer</h3>${statList([['Connected sockets', `${number(data.live.multiplayerConnected)}${data.live.multiplayerCapacity ? ` / ${number(data.live.multiplayerCapacity)}` : ''}`], ['Joins / leaves', `${number(data.gameplay.multiplayer.joins)} / ${number(data.gameplay.multiplayer.leaves)}`], ['Peak concurrency', number(data.gameplay.multiplayer.peakConcurrency)], ['Kills / deaths', `${number(data.gameplay.multiplayer.kills)} / ${number(data.gameplay.multiplayer.deaths)}`]])}</article><article class="panel"><h3>Hot Bakkie${data.live.hotBakkiePhase ? ` · ${escapeHtml(data.live.hotBakkiePhase)}` : ''}</h3>${statList([['Starts', number(data.gameplay.hotBakkie.starts)], ['Deliveries', number(data.gameplay.hotBakkie.deliveries)], ['Timeouts', number(data.gameplay.hotBakkie.timeouts)], ['Delivery rate', `${data.gameplay.hotBakkie.deliveryRate}%`]])}</article></section>
    <article class="panel"><h3>Mission funnel</h3><div class="table-wrap"><table><thead><tr><th>Mission ID</th><th>Starts</th><th>Complete</th><th>Failed</th><th>Conversion</th><th>Median time</th></tr></thead><tbody>${missions}</tbody></table></div></article>
    <h2 class="section-title">Technical errors</h2><article class="panel"><div class="table-wrap"><table><thead><tr><th>Fingerprint</th><th>Error</th><th>Severity</th><th>Sessions / count</th><th>Build · client</th><th>First / last seen</th></tr></thead><tbody>${errors}</tbody></table></div></article>
    <h2 class="section-title">Operations</h2><section class="operations"><article class="panel"><h3><i class="status-dot ${data.operations.database.available ? '' : 'bad'}"></i>Database</h3><p>${escapeHtml(data.operations.database.kind)} · ${data.operations.database.available ? 'available' : 'unavailable'}</p></article><article class="panel"><h3>Server</h3><p>Uptime ${duration(data.operations.uptimeSeconds)} · build <code>${escapeHtml(data.operations.build)}</code></p></article><article class="panel"><h3>Telemetry receipt</h3><p>${dateTime(data.operations.lastTelemetryAt)}${data.operations.analyticsSecretPersistent ? '' : ' · ephemeral visitor hashing secret'}</p></article></section></main>`;
  const select = app.querySelector<HTMLSelectElement>('.range-select'); if (select) { select.value = range; select.addEventListener('change', () => { range = select.value; void refresh(); }); }
  app.querySelector('#refresh')?.addEventListener('click', () => void refresh()); app.querySelector('#logout')?.addEventListener('click', () => void logout());
}

async function refresh(): Promise<void> {
  if (refreshing) return; refreshing = true;
  try {
    const response = await fetch(`/api/admin/dashboard?range=${encodeURIComponent(range)}`, { credentials: 'same-origin' });
    if (response.status === 401) { showLogin('Your admin session expired. Sign in again.'); return; }
    if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? 'Dashboard request failed'); }
    render(await response.json() as DashboardData);
    if (!refreshTimer) refreshTimer = setInterval(() => void refresh(), 15_000);
  } catch (error) {
    if (!app.querySelector('.dashboard')) app.innerHTML = `<main class="shell-state"><p class="eyebrow">CITY CONTROL</p><h1>Analytics unavailable</h1><p class="error-message">${escapeHtml(error instanceof Error ? error.message : 'The server could not be reached.')}</p><button class="button" id="retry">Try again</button></main>`;
    else { const note = app.querySelector('.refresh-note'); if (note) { note.classList.add('error-message'); note.textContent = `Refresh failed: ${error instanceof Error ? error.message : 'server unavailable'}`; } }
    app.querySelector('#retry')?.addEventListener('click', () => void refresh());
  } finally { refreshing = false; }
}

async function logout(): Promise<void> {
  try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } finally { showLogin(); }
}

void refresh();
