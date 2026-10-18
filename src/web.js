// The lead feed website. Plain server-rendered HTML, no frameworks, password-protected.
import http from 'node:http';
import { normCompany } from './classify.js';
import { CATEGORY_LABEL } from './signals.js';
import { telegramChatId } from './alerts.js';

const esc = (s = '') => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function ago(iso, now = new Date()) {
  if (!iso) return '';
  const s = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const SOURCE_LABEL = { greenhouse: 'Careers page', lever: 'Careers page', ashby: 'Careers page', web3career: 'web3.career' };
const CATS = ['engineering', 'security', 'bd', 'marketing', 'ops', 'other'];

// Same role listed on a careers page and on web3.career → show it once, preferring the careers page.
export function dedupe(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = `${r.company_key}|${r.title_key}`;
    const cur = best.get(k);
    if (!cur) { best.set(k, { ...r, also: [] }); continue; }
    const preferNew = cur.source === 'web3career' && r.source !== 'web3career';
    const keep = preferNew ? { ...r, also: [...cur.also, cur.source] } : { ...cur, also: [...cur.also, r.source] };
    keep.first_seen = cur.first_seen < r.first_seen ? cur.first_seen : r.first_seen;
    keep.heat = Math.max(cur.heat, r.heat);
    best.set(k, keep);
  }
  return [...best.values()];
}

export function queryFeed(db, params, settings = {}) {
  const cats = (params.getAll('cat') || []).filter((c) => CATS.includes(c));
  const senior = params.get('senior') === '1';
  const view = params.get('view') || 'new';          // new | interested | dismissed | all
  const q = (params.get('q') || '').trim().toLowerCase();
  const sort = params.get('sort') === 'newest' ? 'newest' : 'heat';
  const showClients = params.get('clients') === '1';
  const hidden = new Set((settings.hideCompanies || []).map(normCompany));

  let rows = db.prepare('SELECT * FROM jobs WHERE closed_at IS NULL').all();
  rows = rows.filter((r) =>
    (!cats.length || cats.includes(r.category)) &&
    (!senior || r.senior) &&
    (view === 'all' || r.status === view) &&
    (!q || `${r.company} ${r.title} ${r.location}`.toLowerCase().includes(q)) &&
    (showClients || !hidden.has(r.company_key)));
  rows = dedupe(rows);
  rows.sort(sort === 'newest'
    ? (a, b) => b.first_seen.localeCompare(a.first_seen)
    : (a, b) => b.heat - a.heat || b.first_seen.localeCompare(a.first_seen));
  return { rows: rows.slice(0, 300), total: rows.length, filters: { cats, senior, view, q, sort, showClients } };
}

function stats(db, now) {
  const day = new Date(now.getTime() - 86400000).toISOString();
  const week = new Date(now.getTime() - 7 * 86400000).toISOString();
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    today: one('SELECT COUNT(*) n FROM jobs WHERE first_seen >= ? AND baseline = 0', day),
    week: one('SELECT COUNT(*) n FROM jobs WHERE first_seen >= ? AND baseline = 0', week),
    companies: one('SELECT COUNT(DISTINCT company_key) n FROM jobs WHERE closed_at IS NULL'),
    open: one('SELECT COUNT(*) n FROM jobs WHERE closed_at IS NULL'),
  };
}

function link(params, changes) {
  const p = new URLSearchParams(params);
  for (const [k, v] of Object.entries(changes)) {
    p.delete(k);
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v !== null && v !== undefined && v !== '') p.set(k, v);
  }
  const s = p.toString();
  return s ? `/?${s}` : '/';
}

function chip(label, href, on) {
  return `<a class="chip${on ? ' on' : ''}" href="${esc(href)}" aria-pressed="${on}">${esc(label)}</a>`;
}

export function renderFeed(db, params, settings = {}, now = new Date(), notice = '') {
  const { rows, total, filters } = queryFeed(db, params, settings);
  const s = stats(db, now);
  const runs = db.prepare('SELECT * FROM source_runs ORDER BY label').all();
  const lastOk = runs.map((r) => r.last_ok).filter(Boolean).sort().pop();
  const failing = runs.filter((r) => r.last_error);
  const rules = (settings.alerts?.rules || []).filter((r) => r.enabled !== false);

  const catChips = CATS.map((c) => {
    const on = filters.cats.includes(c);
    const next = on ? filters.cats.filter((x) => x !== c) : [...filters.cats, c];
    return chip(CATEGORY_LABEL[c][0].toUpperCase() + CATEGORY_LABEL[c].slice(1), link(params, { cat: next }), on);
  }).join('');

  const viewTabs = [['new', 'New'], ['interested', 'Interested'], ['dismissed', 'Dismissed'], ['all', 'All']]
    .map(([v, l]) => chip(l, link(params, { view: v === 'new' ? null : v }), filters.view === v)).join('');

  const back = esc(link(params, {}));
  const rowsHtml = rows.map((r) => {
    const sig = JSON.parse(r.signals || '[]');
    const heatCls = r.heat >= 50 ? 'hot' : r.heat >= 25 ? 'warm' : '';
    return `<tr>
      <td><div class="co">${esc(r.company)}</div><div class="role">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</div>
        <div class="meta">${esc(r.location || (r.remote ? 'Remote' : ''))}</div></td>
      <td>${sig.length ? sig.map((x) => `<span class="sig">${esc(x)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
      <td><div>${esc(SOURCE_LABEL[r.source] || r.source)}${r.also?.length ? ' <span class="muted">+ web3.career</span>' : ''}</div>
        <div class="mono muted">${r.baseline ? 'already open' : esc(ago(r.first_seen, now))}</div></td>
      <td><span class="heat ${heatCls}" title="Heat 0–100: how strong a BD lead this looks, from the signals beside it">${r.heat}</span></td>
      <td class="actions">
        <form method="post" action="/jobs/${encodeURIComponent(r.id)}/status"><input type="hidden" name="back" value="${back}">
          ${r.status === 'interested'
            ? '<button name="status" value="new" class="btn ghost">Unmark</button>'
            : '<button name="status" value="interested" class="btn primary">Interested</button>'}
          ${r.status === 'dismissed'
            ? '<button name="status" value="new" class="btn ghost">Restore</button>'
            : '<button name="status" value="dismissed" class="btn ghost">Dismiss</button>'}
        </form></td>
    </tr>`;
  }).join('');

  const emptyMsg = runs.length === 0
    ? 'No scans yet. The first one runs a minute after the app starts.'
    : 'Nothing matches these filters.';

  return page('Lead feed', `
  <header class="top">
    <div>
      <h1>Lead feed</h1>
      <p class="live"><span class="dot ${failing.length ? 'amber' : ''}" aria-hidden="true"></span>
        ${lastOk ? `Checked ${esc(ago(lastOk, now))} across ${runs.length} source${runs.length === 1 ? '' : 's'}` : 'Waiting for first scan'}
        ${failing.length ? ` · <a href="/sources">${failing.length} source${failing.length === 1 ? '' : 's'} need attention</a>` : ''}</p>
    </div>
    <form class="search" method="get" action="/">
      ${filters.cats.map((c) => `<input type="hidden" name="cat" value="${c}">`).join('')}
      ${filters.senior ? '<input type="hidden" name="senior" value="1">' : ''}
      ${filters.view !== 'new' ? `<input type="hidden" name="view" value="${esc(filters.view)}">` : ''}
      <label for="q" class="sr">Search</label>
      <input id="q" name="q" value="${esc(filters.q)}" placeholder="Search company, role or location">
      <button class="btn primary" type="submit">Search</button>
    </form>
  </header>
  ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
  <section class="kpis" aria-label="Key numbers">
    <div class="kpi"><span>New today</span><b>${s.today}</b></div>
    <div class="kpi"><span>New this week</span><b>${s.week}</b></div>
    <div class="kpi"><span>Open roles tracked</span><b>${s.open}</b></div>
    <div class="kpi"><span>Companies hiring</span><b>${s.companies}</b></div>
  </section>
  <div class="card filters">
    <span class="lbl">Show</span>${viewTabs}<span class="sep"></span>${catChips}<span class="sep"></span>
    ${chip('Senior+ only', link(params, { senior: filters.senior ? null : '1' }), filters.senior)}
    ${(settings.hideCompanies || []).length ? chip('Include current clients', link(params, { clients: filters.showClients ? null : '1' }), filters.showClients) : ''}
    <span class="sep"></span>
    ${chip('Hottest first', link(params, { sort: null }), filters.sort === 'heat')}
    ${chip('Newest first', link(params, { sort: 'newest' }), filters.sort === 'newest')}
  </div>
  <div class="grid">
    <section class="card table-card" aria-label="Job posts">
      <div class="scroll"><table>
        <thead><tr><th>Company &amp; role</th><th>Why it's a lead</th><th>Source</th><th>Heat</th><th><span class="sr">Actions</span></th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="5" class="empty">${emptyMsg}</td></tr>`}</tbody>
      </table></div>
      ${total > rows.length ? `<p class="muted pad">Showing ${rows.length} of ${total}. Narrow the filters to see the rest.</p>` : ''}
    </section>
    <aside class="side">
      <section class="card">
        <h2>Alerts</h2>
        <p class="muted small">${telegramStatus(db)}</p>
        ${rules.map((r) => `<div class="rule"><b>${esc(r.name || r.type)}</b><span class="muted small">${esc(describeRule(r))}</span></div>`).join('') || '<p class="muted">No alert rules set.</p>'}
      </section>
      <section class="card">
        <h2>Sources</h2>
        ${runs.map((r) => `<div class="src"><span>${esc(r.label)}</span><span class="mono ${r.last_error ? 'bad' : 'muted'}">${r.last_error ? 'error' : `${r.job_count} open`}</span></div>`).join('') || '<p class="muted">No sources scanned yet.</p>'}
        <p class="small"><a href="/sources">Source details →</a></p>
      </section>
    </aside>
  </div>`);
}

function telegramStatus(db) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return 'Sent nowhere yet: Telegram isn\'t set up';
  if (telegramChatId(db)) return 'Sent to your Telegram';
  return 'Telegram bot ready: send it any message to connect';
}

export function describeRule(r) {
  if (r.type === 'burst') return `A company posts ${r.minRoles || 3}+ new roles in a week`;
  if (r.type === 'keywords') return `${r.seniorOnly ? 'Senior ' : ''}roles mentioning ${(r.keywords || []).join(', ')}`;
  if (r.type === 'watched') return 'Any new role at a company on your watchlist';
  if (r.type === 'heat') return `Any new role with heat ${r.minHeat || 50}+`;
  return '';
}

export function renderSources(db, watchlistProblems = [], now = new Date()) {
  const runs = db.prepare('SELECT * FROM source_runs ORDER BY (last_error IS NULL), label').all();
  return page('Sources', `
  <header class="top"><div><h1>Sources</h1><p class="live">Every feed Relay checks, and whether it's working.</p></div></header>
  ${watchlistProblems.length ? `<div class="card warn"><h2>Watchlist entries that couldn't be read</h2><ul>${watchlistProblems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
  <section class="card table-card"><div class="scroll"><table>
    <thead><tr><th>Source</th><th>Status</th><th>Open roles</th><th>Last checked</th></tr></thead>
    <tbody>${runs.map((r) => `<tr>
      <td>${esc(r.label)}<div class="mono muted small">${esc(r.source_key)}</div></td>
      <td>${r.last_error ? `<span class="bad">${esc(r.last_error)}</span>` : '<span class="ok">Working</span>'}</td>
      <td>${r.job_count}</td>
      <td class="mono">${esc(ago(r.last_run, now))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No scans yet.</td></tr>'}</tbody>
  </table></div></section>`, 'sources');
}

function page(title, body, active = 'feed') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay · ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="app">
<nav aria-label="Main" class="nav">
  <div class="logo"><svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#7C9BFF" stroke-width="2"><rect x="3" y="3" width="9" height="9" rx="2"/><rect x="16" y="16" width="9" height="9" rx="2"/><path d="M12 7.5h4.5a3 3 0 0 1 3 3V16"/></svg><span>Relay</span></div>
  <a href="/" class="${active === 'feed' ? 'on' : ''}">Lead feed</a>
  <a href="/sources" class="${active === 'sources' ? 'on' : ''}">Sources</a>
  <span class="soon">Talent bank · soon</span><span class="soon">Outreach · soon</span>
</nav>
<main class="main">${body}</main></div></body></html>`;
}

const CSS = `
:root{--ink:#111827;--muted:#4B5563;--line:#E5E7EB;--bg:#F3F4F6;--card:#fff;--accent:#2F54EB;--accent-d:#1D39C4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 'IBM Plex Sans',system-ui,sans-serif}
a{color:var(--accent)}a:hover{color:var(--accent-d)}
.app{display:flex;flex-wrap:wrap;min-height:100vh}
.nav{flex:1 1 200px;background:#0E1116;color:#D1D5DB;padding:24px 16px;display:flex;flex-direction:column;gap:4px}
.nav .logo{display:flex;align-items:center;gap:10px;padding:0 8px 24px;font:700 20px 'Space Grotesk',sans-serif;color:#fff}
.nav a{display:block;padding:10px 12px;border-radius:8px;color:#D1D5DB;text-decoration:none;font-size:14px}
.nav a.on{background:#1F2633;color:#fff;font-weight:600}.nav .soon{padding:10px 12px;font-size:13px;color:#8B93A1}
.main{flex:999 1 560px;min-width:0;padding:32px 40px 48px;display:flex;flex-direction:column;gap:22px}
h1{margin:0;font:700 34px 'Space Grotesk',sans-serif;letter-spacing:-.01em}
h2{margin:0 0 10px;font:600 19px 'Space Grotesk',sans-serif}
.top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:flex-end}
.live{margin:6px 0 0;font-size:13px;color:#374151;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;background:#047857;display:inline-block}.dot.amber{background:#C2410C}
.search{display:flex;gap:8px;flex-wrap:wrap}.search input{width:320px;max-width:100%;height:44px;padding:0 14px;border:1px solid #D1D5DB;border-radius:10px;font:inherit;font-size:14px}
.btn{height:36px;padding:0 12px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;border:1px solid #D1D5DB;background:#fff;color:var(--ink)}
.search .btn{height:44px;padding:0 18px;font-size:14px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.btn.ghost:hover{background:#F9FAFB}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px;display:flex;flex-direction:column;gap:4px}
.kpi span{font-size:13px;color:var(--muted)}.kpi b{font:600 30px 'Space Grotesk',sans-serif}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:14px 18px}.lbl{font-size:13px;font-weight:600;margin-right:4px}
.sep{width:1px;height:24px;background:var(--line);margin:0 4px}
.chip{display:inline-flex;align-items:center;height:36px;padding:0 12px;border:1px solid #D1D5DB;border-radius:999px;font-size:13px;color:var(--ink);text-decoration:none;background:#fff}
.chip.on{background:var(--ink);border-color:var(--ink);color:#fff}
.grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(260px,1fr);gap:24px;align-items:start}
.table-card{padding:0;overflow:hidden}.scroll{overflow-x:auto}
table{width:100%;min-width:760px;border-collapse:collapse;font-size:14px}
th{background:#F9FAFB;text-align:left;padding:12px 16px;font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
td{padding:14px 16px;border-top:1px solid var(--line);vertical-align:top}
.co{font-weight:600}.role a{color:#1F2937;text-decoration:none}.role a:hover{color:var(--accent);text-decoration:underline}.meta{font-size:13px;color:var(--muted)}
.sig{display:inline-block;margin:0 4px 4px 0;font-size:12px;padding:3px 8px;border-radius:999px;background:#FFF7ED;color:#9A3412;font-weight:500}
.heat{display:inline-block;min-width:36px;text-align:center;font:600 15px 'Space Grotesk',sans-serif;padding:4px 8px;border-radius:8px;background:#F3F4F6;color:#374151}
.heat.warm{background:#FEF3C7;color:#92400E}.heat.hot{background:#FFEDD5;color:#9A3412}
.actions form{display:flex;gap:6px;flex-wrap:wrap}
.mono{font-family:'IBM Plex Mono',monospace;font-size:12px}.muted{color:var(--muted)}.small{font-size:12px}
.side{display:flex;flex-direction:column;gap:24px}
.rule{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;flex-direction:column;gap:2px;font-size:14px}
.src{display:flex;justify-content:space-between;gap:10px;font-size:13px;border-top:1px solid var(--line);padding:8px 0}
.bad{color:#B42318}.ok{color:#047857}.empty{text-align:center;color:var(--muted);padding:40px}.pad{padding:12px 16px;margin:0}
.notice{margin:0;background:#EEF2FF;color:#3730A3;border-radius:10px;padding:10px 14px;font-size:14px}
.warn{border-color:#FED7AA;background:#FFF7ED}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:900px){.grid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.main{padding:20px 16px 40px}.nav{flex-direction:row;flex-wrap:wrap;align-items:center;padding:12px}.nav .logo{padding:0 8px 0 0}}
`;

export function startServer({ db, getSettings, getWatchlistProblems, port = Number(process.env.PORT) || 3000, password = process.env.APP_PASSWORD, log = console.log }) {
  if (!password) log('⚠ APP_PASSWORD is not set, so the lead feed is open to anyone with the link. Set it before going live.');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
      if (password && !authorised(req, password)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Relay", charset="UTF-8"' });
        return res.end('Password required');
      }
      const settings = getSettings();
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, renderFeed(db, url.searchParams, settings));
      if (req.method === 'GET' && url.pathname === '/sources') return send(res, 200, renderSources(db, getWatchlistProblems()));
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        return send(res, 200, JSON.stringify(queryFeed(db, url.searchParams, settings).rows), 'application/json');
      }
      const m = url.pathname.match(/^\/jobs\/(.+)\/status$/);
      if (req.method === 'POST' && m) {
        const form = new URLSearchParams(await body(req));
        const status = form.get('status');
        if (['new', 'interested', 'dismissed'].includes(status)) {
          db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, decodeURIComponent(m[1]));
        }
        const back = form.get('back') || '/';
        res.writeHead(303, { location: back.startsWith('/') && !back.startsWith('//') ? back : '/' });
        return res.end();
      }
      send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      log('Request error:', err);
      send(res, 500, 'Something went wrong. Check the app logs.', 'text/plain');
    }
  });
  server.listen(port, () => log(`Relay lead feed running on port ${port}`));
  return server;
}

function authorised(req, password) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  return pass === password;
}

function send(res, code, text, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
