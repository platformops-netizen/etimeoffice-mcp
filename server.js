// eTimeOffice (Team Office) attendance MCP connector — no dependencies, Node 18+.
// Exposes cloud attendance to Claude as an MCP server (Streamable HTTP, stateless JSON).
//
// Env:
//   ETO_CORP, ETO_USER, ETO_PASS   eTimeOffice login — Corporate ID, username, password (required)
//   MCP_SECRET               long random string; the connector URL is https://<host>/mcp/<MCP_SECRET> (required)
//   ETO_BASE                 default https://api.etimeoffice.com/api
//   PORT                     default 8080
//   CACHE_SECONDS            reuse an answer for this long, default 120

const http = require('http');

const CFG = {
  secret: process.env.MCP_SECRET || '',
  port: +process.env.PORT || 8080,
  cacheMs: (+process.env.CACHE_SECONDS || 120) * 1000,
};
const VERSION = '1.0.0';

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
  if (path === '' || path === '/health') return send(200, { ok: true, service: 'etimeoffice-mcp', version: VERSION });
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
  if (!CFG.secret) { console.error('Set MCP_SECRET'); process.exit(1); }
  if (!ETO.corp || !ETO.user || !ETO.pass) console.warn('ETO_CORP / ETO_USER / ETO_PASS not set: attendance calls will fail until they are');
  server.listen(CFG.port, () => console.log(`etimeoffice MCP on :${CFG.port}  →  /mcp/<MCP_SECRET>`));
}
module.exports = { server, handle, CFG };
