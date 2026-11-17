// eTimeOffice (Team Office) attendance MCP connector — no dependencies, Node 18+.
// Serves the IncNut Warehouse Attendance web page (no login) and exposes the same attendance to Claude as an MCP server.
//
// Env:
//   ETO_CORP, ETO_USER, ETO_PASS   eTimeOffice login — Corporate ID, username, password (required)
//   MCP_SECRET               optional: long random string; the Claude connector URL is https://<host>/mcp/<MCP_SECRET>
//   PAGE_KEY                 optional: if set, the attendance page is at /att/<PAGE_KEY> instead of the plain address
//   ETO_BASE                 default https://api.etimeoffice.com/api
//   PORT                     default 8080
//   CACHE_SECONDS            reuse an answer for this long, default 120

const http = require('http');

const CFG = {
  secret: process.env.MCP_SECRET || '',
  port: +process.env.PORT || 8080,
  cacheMs: (+process.env.CACHE_SECONDS || 120) * 1000,
};
const VERSION = '1.2.0';

// ---------- eTimeOffice (Team Office) attendance ----------
const ETO = { corp: process.env.ETO_CORP || '', user: process.env.ETO_USER || '', pass: process.env.ETO_PASS || '', base: (process.env.ETO_BASE || 'https://api.etimeoffice.com/api').replace(/\/$/, '') };
const DMY = /^\d{2}\/\d{2}\/\d{4}(_\d{2}:\d{2})?$/;
async function etoGet(ep, params) {
  if (!ETO.corp || !ETO.user || !ETO.pass) throw new Error('eTimeOffice login is not set on the connector (add ETO_CORP, ETO_USER, ETO_PASS on the server)');
  const auth = 'Basic ' + Buffer.from(`${ETO.corp}:${ETO.user}:${ETO.pass}:true`).toString('base64');
  const q = Object.entries(params).map(([k, v]) => `${k}=${String(v).replace(/[^\w\/:._-]/g, encodeURIComponent)}`).join('&');
  const r = await fetch(`${ETO.base}/${ep}?${q}`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok || !j) throw new Error(`eTimeOffice ${ep} failed (${r.status}): ${t.slice(0, 200)}`);
  if (j.Error === true || j.error === true) throw new Error(`eTimeOffice ${ep}: ${String(j.Msg || j.msg || 'error').slice(0, 200)}`);
  return j;
}
const listIn = j => { for (const k of ['InOutPunchData', 'PunchData', 'data', 'Data']) if (Array.isArray(j[k])) return j[k]; const a = Object.values(j).find(Array.isArray); return a || []; };
async function attendance({ from, to, emp = 'ALL', kind = 'inout' }) {
  if (!DMY.test(from) || !DMY.test(to)) throw new Error('from/to must be DD/MM/YYYY (inout) or DD/MM/YYYY_HH:MM (punch)');
  const ep = kind === 'punch' ? 'DownloadPunchData' : kind === 'mcid' ? 'DownloadPunchDataMCID' : 'DownloadInOutPunchData';
  const j = await etoGet(ep, { Empcode: emp || 'ALL', FromDate: from, ToDate: to });
  const rows = listIn(j);
  return { source: 'eTimeOffice ' + ep, from, to, emp: emp || 'ALL', fetched_at: new Date().toISOString(), count: rows.length, rows };
}

// ---------- MCP tools ----------
const TOOLS = [
  {
    name: 'attendance',
    description: 'Cloud attendance from eTimeOffice (Team Office). kind "inout" (default) = one row per employee per day with in time, out time, work time, overtime, late-in, early-out and status (DownloadInOutPunchData, dates DD/MM/YYYY); "punch" = raw punches (DownloadPunchData, DD/MM/YYYY_HH:MM); "mcid" = punches with machine id. Returns {source, from, to, emp, fetched_at, count, rows}.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'DD/MM/YYYY (or DD/MM/YYYY_HH:MM for punch)' }, to: { type: 'string' }, emp: { type: 'string', description: 'employee code or ALL (default)' }, kind: { type: 'string', enum: ['inout', 'punch', 'mcid'] } }, required: ['from', 'to'], additionalProperties: false },
  },
];
const cache = new Map();
async function callTool(name, args) {
  if (name !== 'attendance') throw new Error('Unknown tool: ' + name);
  const k = JSON.stringify(args), c = cache.get(k);
  if (c && Date.now() - c.at < CFG.cacheMs) return c.v;
  const v = await attendance(args); cache.set(k, { at: Date.now(), v });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}

// ---------- Public attendance page (read-only weblink, no login): /att/<key> ----------
const PAGE_KEY = (process.env.PAGE_KEY || '').trim(); // optional: when set, the page lives at /att/<PAGE_KEY> instead of /
const pagePath = () => PAGE_KEY ? '/att/' + PAGE_KEY : '';
const pageCache = new Map();
// Roster (week offs) from the "IncNut Roster" Google Sheet, written by THE DEN dashboard; read as public CSV, cached 5 minutes
const ROSTER_SHEET = process.env.ROSTER_SHEET || '1YCJfqZS_cgBTPs523iNIxK9ajgyvCvd_sYi6qjDsd3c';
let rosterCache = { at: 0, rows: [] };
async function rosterRows(force) {
  if (!ROSTER_SHEET) return [];
  if (!force && Date.now() - rosterCache.at < 300e3) return rosterCache.rows;
  try {
    const r = await fetch('https://docs.google.com/spreadsheets/d/' + ROSTER_SHEET + '/gviz/tq?tqx=out:csv&sheet=Roster');
    const t = await r.text(); if (!r.ok || /^\s*</.test(t)) throw new Error('roster sheet not readable');
    const rows = t.split(/\r?\n/).slice(1).map(l => { const c = [...l.matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replace(/""/g, '"'));
      return { m: String(c[0] || '').trim(), c: String(c[1] || '').trim(), n: c[2] || '', dep: c[3] || '', o: new Set(String(c[4] || '').split(/[^0-9]+/).filter(Boolean).map(Number)) }; }).filter(x => /^\d{4}-\d{2}$/.test(x.m) && x.c);
    rosterCache = { at: Date.now(), rows };
  } catch (e) { rosterCache.at = Date.now() - 240e3; }
  return rosterCache.rows;
}
async function attPage(req, res, path) {
  const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }); res.end(body); };
  if (path !== pagePath()) return html(404, 'Not found');
  const q = new URL(req.url, 'http://x').searchParams;
  const ist = new Date(Date.now() + 330 * 60e3), todayK = ist.toISOString().slice(0, 10);
  let day = /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : todayK;
  if (day > todayK) day = todayK;
  const [Y, M, D] = day.split('-'), dmy = `${D}/${M}/${Y}`;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ok = v => /\d{1,2}:\d{2}/.test(String(v || '')) && !/^0?0:00(:00)?$/.test(String(v).trim());
  const mins = v => { const m = String(v || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  let rows = [], err = '', fetched = '';
  try {
    const c = pageCache.get(day);
    if (c && Date.now() - c.at < 60e3 && q.get('r') !== '1') { rows = c.rows; fetched = c.fetched; }
    else { const a = await attendance({ from: dmy, to: dmy }); rows = a.rows; fetched = a.fetched_at; pageCache.set(day, { at: Date.now(), rows, fetched }); }
  } catch (e) { err = String(e.message || e); }
  const ros = await rosterRows(q.get('r') === '1');
  const offOn = k => new Set(ros.filter(x => x.m === k.slice(0, 7) && x.o.has(+k.slice(8))).map(x => x.c));
  const offToday = offOn(day), tmrK = new Date(Date.UTC(+Y, +M - 1, +D) + 864e5).toISOString().slice(0, 10), offTmr = ros.filter(x => x.m === tmrK.slice(0, 7) && x.o.has(+tmrK.slice(8)));
  const R = rows.map(r => {
    const i = String(r.INTime || '').trim(), o = String(r.OUTTime || '').trim(), st = String(r.Status || '').trim().toUpperCase();
    const pres = ok(i) || /^(P|WOP|POW|HP|HD|P\/)/.test(st), off = !ok(i) && /^(WO|H|HO|HLD)$/.test(st);
    let h = null; if (ok(i) && ok(o)) { let b = mins(o); const a2 = mins(i); if (b < a2) b += 1440; h = (b - a2) / 60; }
    const late = ok(i) ? Math.max(0, mins(i) - 540) : 0;
    const exp = ok(i) ? (() => { const t = (mins(i) + 540) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); })() : '';
    const ro = offToday.has(String(r.Empcode || '').trim());
    return { ro, c: String(r.Empcode || '').trim(), n: String(r.Name || '').trim(), i: ok(i) ? i.slice(0, 5) : '', o: ok(o) ? o.slice(0, 5) : '', exp, st, cat: pres ? 'P' : ro ? 'RO' : off ? 'WO' : st === 'A' || !st || st === '--' ? 'A' : 'L', h, late };
  }).sort((a, b) => ({ P: 0, L: 1, A: 2, RO: 3, WO: 4 }[a.cat] - { P: 0, L: 1, A: 2, RO: 3, WO: 4 }[b.cat]) || (a.i || '99').localeCompare(b.i || '99') || a.n.localeCompare(b.n));
  const cnt = k => R.filter(r => r.cat === k).length, isToday = day === todayK;
  const prev = new Date(Date.UTC(+Y, +M - 1, +D) - 864e5).toISOString().slice(0, 10), next = new Date(Date.UTC(+Y, +M - 1, +D) + 864e5).toISOString().slice(0, 10);
  const base = pagePath() || '/', lbl = new Date(Date.UTC(+Y, +M - 1, +D)).toUTCString().slice(0, 16);
  const curM = todayK.slice(0, 7), nxtM = new Date(Date.UTC(+todayK.slice(0, 4), +todayK.slice(5, 7), 1)).toISOString().slice(0, 7);
  const rm = q.get('rm') === nxtM ? nxtM : curM, RM = ros.filter(x => x.m === rm).sort((a, b) => a.dep.localeCompare(b.dep) || a.n.localeCompare(b.n));
  const rmDim = new Date(Date.UTC(+rm.slice(0, 4), +rm.slice(5, 7), 0)).getUTCDate(), rmDays = Array.from({ length: rmDim }, (_, i) => ({ d: i + 1, wd: new Date(Date.UTC(+rm.slice(0, 4), +rm.slice(5, 7) - 1, i + 1)).getUTCDay() }));
  const WDN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], monName = k => new Date(k + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const tdCol = rm === curM ? +todayK.slice(8) : 0;
  const rosterHtml = !ros.length ? '' : `<h2 style="font-size:1.1rem;margin:26px 0 6px">Planned roster \u00b7 week offs</h2>
<div class="bar" style="margin:6px 0 10px">${[[curM, 'This month'], [nxtM, 'Next month']].map(([k, l]) => `<a class="b${k === rm ? ' p' : ''}" href="${base}?d=${day}&rm=${k}#roster">${l} \u00b7 ${monName(k).split(' ')[0]}</a>`).join('')}</div>
<div id="roster">${RM.length ? `<div class="rw"><table class="rt"><thead><tr><th class="st">Employee</th>${rmDays.map(x => `<th class="${x.wd === 0 ? 'su' : ''}${x.d === tdCol ? ' td' : ''}">${x.d}<small>${WDN[x.wd].slice(0, 2)}</small></th>`).join('')}</tr></thead><tbody>
${RM.map(x => `<tr><td class="st"><b>${esc(x.n)}</b><span class="c">${esc(x.c)}${x.dep && x.dep !== 'Not mapped' ? ' \u00b7 ' + esc(x.dep) : ''}</span></td>${rmDays.map(dd => x.o.has(dd.d) ? `<td class="ro${dd.wd === 0 ? ' su' : ''}${dd.d === tdCol ? ' td' : ''}">OFF</td>` : `<td class="${dd.d === tdCol ? 'td' : ''}"></td>`).join('')}</tr>`).join('')}
<tr class="tt"><td class="st">Off that day</td>${rmDays.map(dd => `<td class="${dd.d === tdCol ? 'td' : ''}">${RM.filter(x => x.o.has(dd.d)).length}</td>`).join('')}</tr>
<tr class="tt"><td class="st">Working</td>${rmDays.map(dd => `<td class="${dd.d === tdCol ? 'td' : ''}">${RM.length - RM.filter(x => x.o.has(dd.d)).length}</td>`).join('')}</tr></tbody></table></div>` : `<p class="sub">No roster planned for ${monName(rm)} yet.</p>`}</div>`;
  const cell = r => {
    if (r.cat === 'A') return '<td class="bad">Absent</td><td></td><td></td><td></td>';
    if (r.cat === 'RO') return '<td class="off">Week off (roster)</td><td></td><td></td><td></td>';
    if (r.cat === 'WO') return '<td class="off">Week off</td><td></td><td></td><td></td>';
    if (r.cat === 'L') return `<td class="off">${esc(r.st)}</td><td></td><td></td><td></td>`;
    const hrs = r.h == null ? (r.i && (!isToday) ? '<td class="bad">No out-punch</td>' : '<td class="muted">In progress</td>') : `<td class="${r.h >= 9 ? 'good' : 'bad'}">${r.h.toFixed(1)} h</td>`;
    return `<td class="good">Present${r.ro ? '<span class="c">on roster week off</span>' : ''}</td><td>${esc(r.i) || '—'}${r.late ? `<span class="late">late ${r.late}m</span>` : ''}</td><td>${r.o ? `${esc(r.o)}${r.exp ? `<span class="c">due ${esc(r.exp)}</span>` : ''}` : (r.exp ? `<span class="due">Can leave ${esc(r.exp)}</span>` : '—')}</td>${hrs}`;
  };
  html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>IncNut Warehouse Attendance · ${esc(lbl)}</title>${isToday ? '<meta http-equiv="refresh" content="300">' : ''}
<style>:root{--bg:#f3f5f8;--card:#fff;--ink:#18212f;--mut:#5b6678;--line:#dde2ea;--g:#1f7a45;--gb:#e3f4ea;--r:#c62e2e;--rb:#fbe6e6;--o:#b26a00}
@media (prefers-color-scheme:dark){:root{--bg:#0f141c;--card:#161d28;--ink:#e6eaf1;--mut:#9aa5b8;--line:#273142;--g:#7fd6a0;--gb:#173a26;--r:#ff7a7a;--rb:#3a1d22;--o:#f0b452}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.w{max-width:900px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:0 0 2px}.sub{color:var(--mut);font-size:.85rem}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0}
a.b,button{font:600 .9rem system-ui;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px;border-radius:9px;text-decoration:none;cursor:pointer}
a.b.p{background:#2747d6;border-color:#2747d6;color:#fff}
.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px}.k div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.k b{display:block;font-size:1.6rem}.k span{color:var(--mut);font-size:.8rem}
input[type=search]{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);flex:1 1 180px}
table{width:100%;border-collapse:separate;border-spacing:0 4px;font-size:.92rem}th{text-align:left;color:var(--mut);font-size:.78rem;padding:4px 8px}
td{background:var(--card);padding:8px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}td:first-child{border-left:1px solid var(--line);border-radius:8px 0 0 8px}td:last-child{border-right:1px solid var(--line);border-radius:0 8px 8px 0}
td.good{background:var(--gb);color:var(--g);font-weight:600}td.bad{background:var(--rb);color:var(--r);font-weight:600}td.off,td.muted{color:var(--mut)}
.late{display:block;color:var(--o);font-size:.75rem;font-weight:600}.c{color:var(--mut);font-size:.75rem;display:block}.due{display:inline-block;background:var(--gb);color:var(--g);font-weight:700;padding:2px 8px;border-radius:6px}.rw{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}table.rt{border-collapse:collapse;border-spacing:0;font-size:.78rem;width:auto}table.rt th,table.rt td{border:0;border-bottom:1px solid var(--line);border-radius:0;padding:5px 4px;text-align:center;min-width:30px;background:var(--card)}table.rt th small{display:block;font-weight:400;color:var(--mut)}table.rt .st{position:sticky;left:0;z-index:1;text-align:left;min-width:150px;white-space:nowrap;border-right:1px solid var(--line)}table.rt td.ro{background:var(--rb);color:var(--r);font-weight:700}table.rt td.ro.su{background:#fdeedc;color:#b26a00}table.rt th.su{color:var(--o)}table.rt .td{outline:2px solid #2747d6;outline-offset:-2px}table.rt tr.tt td{font-weight:700;color:var(--mut)}.err{background:var(--rb);color:var(--r);padding:10px;border-radius:9px}
@media (max-width:560px){.k{grid-template-columns:repeat(2,minmax(0,1fr))}table{font-size:.82rem}td{padding:7px 5px}th{padding:4px 5px}}</style></head><body><div class="w">
<h1>IncNut Warehouse Attendance</h1><div class="sub" style="margin-bottom:2px">Hyderabad warehouse</div><div class="sub">${esc(lbl)}${isToday ? ' · today' : ''} · from eTimeOffice · fetched ${esc(new Date(new Date(fetched || Date.now()).getTime() + 330 * 60e3).toISOString().slice(11, 16))} IST${isToday ? ' · refreshes every 5 minutes' : ''}</div>
<div class="bar"><a class="b p" href="${base}?d=${day}&r=1">⟳ Refresh</a><a class="b" href="${base}?d=${prev}">← Previous day</a>${isToday ? '' : `<a class="b" href="${base}?d=${next}">Next day →</a><a class="b" href="${base}">Today</a>`}<input type="search" id="q" placeholder="Search name or code" oninput="f(this.value)"></div>
${err ? `<div class="err">Could not load attendance: ${esc(err)}</div>` : ''}
<div class="k"><div><b>${cnt('P')}</b><span>Present</span></div><div><b>${cnt('A')}</b><span>Absent</span></div>${ros.length ? `<div><b>${cnt('RO')}</b><span>Week off (roster)</span></div>` : ''}<div><b>${R.filter(r => r.late).length}</b><span>Late in (after 09:00)</span></div><div><b>${R.filter(r => r.h != null && r.h < 9).length}</b><span>Under 9 hours</span></div></div>
<table><thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out / can leave</th><th>Hours</th></tr></thead><tbody id="t">
${R.map(r => `<tr data-s="${esc((r.n + ' ' + r.c).toLowerCase())}"><td><b>${esc(r.n)}</b><span class="c">${esc(r.c)}</span></td>${cell(r)}</tr>`).join('')}
</tbody></table>${offTmr.length ? `<h2 style="font-size:1.05rem;margin:18px 0 6px">Week off tomorrow as per roster \u00b7 ${offTmr.length}</h2><p style="margin:0 0 8px">${offTmr.sort((a, b) => a.n.localeCompare(b.n)).map(x => `<b>${esc(x.n)}</b> <span class="c" style="display:inline">${esc(x.c)}</span>`).join(' \u00b7 ')}</p>` : ''}${rosterHtml}<p class="sub">Week off (roster) = planned off in the IncNut roster, not counted as absent. Hours = out-punch − in-punch. Green = 9 hours or more, red = under 9 hours or missing out-punch. Late = in-punch after 09:00. Can leave = in-punch + 9 hours.</p></div>
<script>function f(v){v=v.trim().toLowerCase();document.querySelectorAll('#t tr').forEach(function(t){t.style.display=!v||t.dataset.s.indexOf(v)>-1?'':'none';});}</script></body></html>`);
}

// ---------- JSON-RPC over Streamable HTTP (stateless) ----------
async function handle(msg) {
  const { id, method, params } = msg || {};
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null; // notification
  try {
    if (method === 'initialize') return ok({
      protocolVersion: (params && params.protocolVersion) || '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'etimeoffice-attendance', version: VERSION },
      instructions: 'Cloud attendance from eTimeOffice (Team Office). Call attendance with from/to dates (DD/MM/YYYY) to get daily in/out rows per employee.',
    });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const data = await callTool(params && params.name, (params && params.arguments) || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    return err(-32601, 'Method not found: ' + method);
  } catch (e) { return err(-32603, String(e.message || e)); }
}

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const path = req.url.split('?')[0].replace(/\/+$/, '');
  if (path === '/health') return send(200, { ok: true, service: 'incnut-warehouse-attendance', version: VERSION });
  if (req.method === 'GET' && (path === pagePath() || (!PAGE_KEY && path === ''))) return attPage(req, res, pagePath());
  if (path === '') return send(404, { error: 'not found' });
  if (!CFG.secret || path !== '/mcp/' + CFG.secret) return send(404, { error: 'not found' });
  if (req.method === 'GET' || req.method === 'DELETE') return send(405, { error: 'stateless server: POST only' });
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  let raw = ''; req.setEncoding('utf8');
  for await (const ch of req) { raw += ch; if (raw.length > 2e6) return send(413, { error: 'too large' }); }
  let body; try { body = JSON.parse(raw); } catch (_) { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const batch = Array.isArray(body), msgs = batch ? body : [body];
  const out = (await Promise.all(msgs.map(handle))).filter(Boolean);
  if (!out.length) { res.writeHead(202); return res.end(); }
  send(200, batch ? out : out[0]);
});

if (require.main === module) {
  if (!CFG.secret) console.warn('MCP_SECRET not set: the Claude connector endpoint is off; the attendance page still works');
  if (!ETO.corp || !ETO.user || !ETO.pass) console.warn('ETO_CORP / ETO_USER / ETO_PASS not set: attendance calls will fail until they are');
  server.listen(CFG.port, () => console.log(`etimeoffice MCP on :${CFG.port}  →  /mcp/<MCP_SECRET>`));
}
module.exports = { server, handle, CFG };
