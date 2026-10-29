#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const kube = require('./lib/kube');
const demo = require('./lib/demo');
const source = require('./lib/source');
const catalog = require('./lib/catalog');
const assist = require('./lib/assist');

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (flag('help')) {
  console.log('Usage: k8oui [--port 7788] [--host 127.0.0.1] [--demo] [--context NAME]');
  process.exit(0);
}
const PORT = +val('port', process.env.PORT || 7788);
const HOST = val('host', '127.0.0.1');

let backend = demo, mode = 'demo', reason = 'Demo mode requested';

async function goLive() {
  await kube.ping();
  backend = kube; mode = 'live'; reason = '';
}
async function init() {
  if (val('context')) await kube.setContext(val('context')).catch(e => console.error(e.message));
  if (flag('demo')) return;
  try { await goLive(); }
  catch (e) { reason = `Cluster unreachable: ${e.message}`; console.error(reason); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUB = path.join(__dirname, 'public');
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 1e6) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
});

const routes = {
  'GET /api/state': async () => ({
    mode, reason, ...(await backend.contexts().catch(() => ({ names: [], current: '' }))),
    operators: await backend.operators(), fetchedAt: new Date().toISOString(),
  }),
  'GET /api/operator': async ({ q }) => backend.detail(q.id),
  'GET /api/logs': async ({ q }) => ({ text: await backend.logs(q.id, q.pod, q.tail) }),
  'GET /api/yaml': async ({ q }) => ({ text: await backend.yaml(q) }),
  'POST /api/restart': async ({ b }) => ({ message: await backend.restart(b.id) }),
  'POST /api/scale': async ({ b }) => ({ message: await backend.scale(b.id, b.replicas) }),
  'POST /api/delete': async ({ b }) => ({ message: await backend.del(b.id, b.crd, b.name, b.ns) }),
  'POST /api/apply': async ({ b }) => ({ message: await backend.apply(b.id, b.yaml, !!b.dryRun, !!b.create) }),
  'GET /api/template': async ({ q }) => ({ text: await backend.template(q.id, q.crd, q.ns) }),
  'POST /api/install/plan': async ({ b }) => source.resolve(b.source),
  'POST /api/install/apply': async ({ b }) => ({ message: await backend.install(b.planId, b.index, { release: b.release, namespace: b.namespace }, !!b.dryRun) }),
  'GET /api/catalog': async () => ({ items: catalog.list() }),
  'POST /api/catalog/preview': async ({ b }) => ({ steps: catalog.plan(b, !!b.dryRun).steps.map(x => x.shown) }),
  'POST /api/catalog/install': async ({ b }) => ({ message: await backend.installPreset(b, !!b.dryRun) }),
  'POST /api/assist/context': async ({ b }) => ({ text: await assist.context(backend, mode, b) }),
  'POST /api/assist/ask': async ({ b }) => assist.ask(backend, mode, b),
  'POST /api/uninstall': async ({ b }) => ({ message: await backend.uninstall(b.id) }),
  'POST /api/context': async ({ b }) => { await backend.setContext(b.name); return { ok: true }; },
  'POST /api/mode': async ({ b }) => {
    if (b.mode === 'demo') { backend = demo; mode = 'demo'; reason = 'Demo mode requested'; demo.reset(); }
    else {
      try { await goLive(); }
      catch (e) { throw Object.assign(new Error(`Cluster unreachable: ${e.message}`), { status: 502 }); }
    }
    return { mode };
  },
};

const hostOk = h => {
  const name = (h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1', HOST].includes(name);
};

http.createServer(async (req, res) => {
  try {
    // DNS-rebinding guard + CSRF guard (cross-origin pages cannot set custom headers without a preflight, which we never grant).
    if (!hostOk(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-requested-with'] !== 'k8oui') return send(res, 403, { error: 'missing X-Requested-With header' });
      const r = routes[`${req.method} ${url.pathname}`];
      if (!r) return send(res, 404, { error: 'not found' });
      const b = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await r({ q: Object.fromEntries(url.searchParams), b }));
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUB, rel);
    if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(file, (err, data) => err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream'));
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, HOST, async () => {
  await init();
  console.log(`k8oui listening on http://${HOST}:${PORT}  (${mode}${reason ? ': ' + reason : ''})`);
});
