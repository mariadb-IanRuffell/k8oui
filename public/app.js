'use strict';
// ---- helpers ---------------------------------------------------------------
const NS_SVG = 'http://www.w3.org/2000/svg';
function el(ns, tag, attrs, kids) {
  const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.setAttribute('class', v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const h = (tag, attrs, ...kids) => el(null, tag, attrs, kids);
const s = (tag, attrs, ...kids) => el(NS_SVG, tag, attrs, kids);
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('k8oui.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('k8oui.' + k, JSON.stringify(v)); } catch {} },
};

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Requested-With': 'k8oui', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : ''), role: err ? 'alert' : 'status' }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}
function age(iso) {
  if (!iso) return '—';
  const sec = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  for (const [n, u] of [[86400, 'd'], [3600, 'h'], [60, 'm']]) if (sec >= n) return Math.floor(sec / n) + u;
  return Math.floor(sec) + 's';
}
const badge = st => h('span', { class: `badge s-${st}` }, st);
const STATUSES = ['Healthy', 'Progressing', 'Degraded', 'Paused', 'Unknown'];
const COLOR = { Healthy: 'var(--ok)', Progressing: 'var(--prog)', Degraded: 'var(--bad)', Paused: 'var(--pause)', Unknown: 'var(--unk)' };
const rank = { Degraded: 4, Progressing: 3, Paused: 2, Unknown: 1, Healthy: 0 };
const worst = list => list.reduce((w, x) => (rank[x] > rank[w] ? x : w), 'Healthy');

// ---- state -----------------------------------------------------------------
const state = {
  data: null, view: store.get('view', 'operators'), status: null, q: '',
  sel: null, tab: 'overview', detail: null, logPod: null, logTail: 200, busy: false,
};

async function load() {
  try {
    state.data = await api('/api/state');
    renderTop();
    renderMain();
    if (state.sel && !$('dlg').open && ['overview', 'resources', 'pods', 'events'].includes(state.tab)) refreshDetail();
  } catch (e) {
    $('content').replaceChildren(h('div', { class: 'empty' }, 'Cannot reach the k8oui server: ' + e.message));
  }
}

// ---- top bar ---------------------------------------------------------------
function renderTop() {
  const d = state.data;
  const pill = $('mode');
  pill.className = 'pill ' + d.mode;
  pill.textContent = d.mode === 'live' ? 'Live cluster' : 'Demo data';
  const ctx = $('ctx');
  ctx.replaceChildren(...d.names.map(n => h('option', { value: n, selected: n === d.current }, n)));
  ctx.disabled = d.mode !== 'live';
  const b = $('banner');
  if (d.mode === 'demo') {
    b.hidden = false;
    b.replaceChildren(h('span', {}, d.reason + '. Showing sample operators; actions only change the demo.'),
      h('button', { class: 'btn small', onclick: () => switchMode('live') }, 'Connect to cluster'));
  } else {
    b.hidden = true;
    b.replaceChildren(h('span', {}, ''), h('button', { class: 'btn small', onclick: () => switchMode('demo') }, 'Use demo data'));
  }
}
async function switchMode(mode) {
  try { await api('/api/mode', { mode }); resetDock(); await load(); toast(mode === 'live' ? 'Connected' : 'Demo mode'); }
  catch (e) { toast(e.message, true); }
}

// ---- summary + filters -----------------------------------------------------
function filtered() {
  const q = state.q.toLowerCase();
  return state.data.operators.filter(o =>
    (!state.status || o.status === state.status) &&
    (!q || [o.name, o.namespace, o.provider, ...o.crds.map(c => c.kind + ' ' + c.group)].some(t => t && t.toLowerCase().includes(q))));
}
function renderMain() {
  const ops = state.data.operators;
  const count = st => ops.filter(o => o.status === st).length;
  const tile = (n, label, cls) => h('div', { class: 'tile ' + (cls || '') }, h('b', {}, n), h('span', {}, label));
  $('summary').replaceChildren(
    tile(ops.length, 'Operators'), tile(count('Healthy'), 'Healthy'),
    tile(count('Degraded') + count('Progressing'), 'Need attention', count('Degraded') ? 'bad' : ''),
    tile(ops.reduce((n, o) => n + o.crds.length, 0), 'CRDs managed'),
    tile(ops.reduce((n, o) => n + o.instanceCount, 0), 'Custom resources'));
  $('chips').replaceChildren(...STATUSES.filter(st => count(st)).map(st =>
    h('button', { class: 'chip', 'aria-pressed': String(state.status === st), onclick: () => { state.status = state.status === st ? null : st; renderMain(); } }, `${st} ${count(st)}`)));
  for (const b of $('views').children) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  const list = filtered();
  $('content').replaceChildren(!list.length
    ? h('div', { class: 'empty' }, ops.length ? 'No operators match the filter.' : 'No operators found in this cluster.')
    : state.view === 'topology' ? topology(list) : table(list));
}

function table(list) {
  const rows = list.map(o => {
    const sts = o.crds.flatMap(c => c.instances.map(i => i.status));
    const dots = o.crds.flatMap(c => c.instances).slice(0, 30).map(i => h('i', { class: 'dot ' + i.status, title: `${i.name}: ${i.status}` }));
    return h('tr', { class: 'click', tabindex: 0, onclick: () => openDrawer(o.id), onkeydown: e => e.key === 'Enter' && openDrawer(o.id) },
      h('td', {}, badge(o.status)),
      h('td', {}, h('div', { class: 'name' }, o.name, ' ', h('span', { class: 'tag', title: o.source === 'olm' ? 'Managed by OLM' : 'Detected from Deployment/CRD labels' }, o.source === 'olm' ? 'OLM' : 'detected')),
        h('div', { class: 'muted' }, o.namespace)),
      h('td', { class: 'num' }, o.version ? 'v' + o.version.replace(/^v/, '') : '—'),
      h('td', { class: 'num' }, `${o.ready}/${o.desired}`),
      h('td', {}, h('span', { class: 'num' }, o.crds.length), ' ', h('span', { class: 'muted' }, o.crds.slice(0, 3).map(c => c.kind).join(', ') + (o.crds.length > 3 ? '…' : ''))),
      h('td', {}, h('div', { class: 'num' }, o.instanceCount), sts.length ? h('div', { class: 'dots' }, dots) : null),
      h('td', { class: 'num', title: 'Container restarts' }, o.restarts || '0'),
      h('td', { class: 'num' }, age(o.created)));
  });
  return h('table', {}, h('thead', {}, h('tr', {}, ...['Status', 'Operator', 'Version', 'Ready', 'CRDs', 'Resources', 'Restarts', 'Age'].map(t => h('th', {}, t)))), h('tbody', {}, rows));
}

// ---- topology --------------------------------------------------------------
function topology(list) {
  const W = 1000, ROW = 36, GAP = 22, TOP = 30, MAXDOT = 22;
  let y = TOP;
  const nodes = [], edges = [];
  for (const o of list) {
    const rows = Math.max(o.crds.length, 1), h0 = rows * ROW;
    const cy = y + h0 / 2;
    nodes.push(s('g', { class: 'node', tabindex: 0, role: 'button', 'aria-label': `Operator ${o.name}, ${o.status}`, onclick: () => openDrawer(o.id), onkeydown: e => e.key === 'Enter' && openDrawer(o.id) },
      s('rect', { x: 20, y: cy - 24, width: 230, height: 48, rx: 10, stroke: COLOR[o.status] }),
      s('text', { x: 34, y: cy - 3 }, trunc(o.name, 24)),
      s('text', { x: 34, y: cy + 13, class: 'sub' }, `${o.status} · ${o.ready}/${o.desired} · ${trunc(o.namespace, 16)}`),
      s('title', {}, `${o.name} (${o.namespace}) — ${o.status}`)));
    o.crds.forEach((c, i) => {
      const ry = y + i * ROW + ROW / 2;
      const cs = worst(c.instances.map(x => x.status));
      edges.push(s('path', { class: 'edge', d: `M250 ${cy} C 310 ${cy}, 310 ${ry}, 360 ${ry}` }));
      nodes.push(s('g', { class: 'node', tabindex: 0, role: 'button', 'aria-label': `${c.kind}, ${c.instances.length} resources`, onclick: () => openDrawer(o.id, 'resources'), onkeydown: e => e.key === 'Enter' && openDrawer(o.id, 'resources') },
        s('rect', { x: 360, y: ry - 14, width: 210, height: 28, rx: 7, stroke: c.instances.length ? COLOR[cs] : 'var(--line)' }),
        s('text', { x: 372, y: ry + 4.5 }, trunc(c.kind, 20)),
        s('text', { x: 560, y: ry + 4.5, class: 'sub', 'text-anchor': 'end' }, c.scope === 'Cluster' ? 'cluster' : 'ns'),
        s('title', {}, `${c.name} (${c.scope})`)));
      c.instances.slice(0, MAXDOT).forEach((inst, j) => nodes.push(
        s('circle', { cx: 595 + j * 16, cy: ry, r: 6, fill: COLOR[inst.status], tabindex: 0, role: 'button', 'aria-label': `${inst.name}: ${inst.status}`,
          onclick: () => openCR(o.id, c, inst), onkeydown: e => e.key === 'Enter' && openCR(o.id, c, inst) },
          s('title', {}, `${inst.namespace ? inst.namespace + '/' : ''}${inst.name} — ${inst.status}`))));
      if (c.instances.length > MAXDOT) nodes.push(s('text', { x: 595 + MAXDOT * 16, y: ry + 4, class: 'sub' }, `+${c.instances.length - MAXDOT}`));
    });
    y += h0 + GAP;
  }
  const svg = s('svg', { viewBox: `0 0 ${W} ${y}`, role: 'group', 'aria-label': 'Operator topology' },
    s('text', { x: 20, y: 14, class: 'col' }, 'Operators'), s('text', { x: 360, y: 14, class: 'col' }, 'Custom resource definitions'), s('text', { x: 595, y: 14, class: 'col' }, 'Resources (one dot each)'),
    edges, nodes);
  return h('div', { class: 'topo' }, svg,
    h('div', { class: 'legend' }, STATUSES.map(st => h('span', {}, h('i', { class: 'dot ' + st, style: 'display:inline-block;margin-right:5px' }), st)), h('span', {}, 'Click an operator, CRD or dot to drill in')));
}
const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

// ---- drawer ----------------------------------------------------------------
const TABS = [['overview', 'Overview'], ['resources', 'Resources'], ['pods', 'Pods'], ['logs', 'Logs'], ['events', 'Events'], ['manifest', 'Manifest']];

// ---- dock: persistent tabs (operator, Claude sessions, kubectl) ------------
// Panes stay in the DOM while hidden, so typed text, answers and output survive tab switches.
const dock = { tabs: new Map(), active: null };
function dockRender() {
  const empty = dock.tabs.size === 0;
  $('dock').hidden = empty; document.body.classList.toggle('dock-open', !empty);
  $('dock-tabs').replaceChildren(...[...dock.tabs].map(([key, t]) => h('div', { class: 'dtab', role: 'tab', 'aria-selected': String(key === dock.active) },
    h('button', { title: t.title, onclick: () => dockActivate(key) }, t.title),
    h('button', { class: 'dtab-x', 'aria-label': `Close ${t.title}`, onclick: () => dockClose(key) }, '×'))));
}
function dockActivate(key) {
  dock.active = key;
  for (const [k, t] of dock.tabs) t.el.hidden = k !== key;
  dockRender();
}
function dockOpen(key, title, build) {
  let t = dock.tabs.get(key);
  if (!t) { t = { el: build() }; t.el.classList.add('dock-pane'); $('dock-panes').append(t.el); dock.tabs.set(key, t); }
  t.title = title; dockActivate(key);
  return t.el;
}
function dockClose(key) {
  const t = dock.tabs.get(key); if (!t) return;
  t.el.remove(); dock.tabs.delete(key);
  if (key === 'op') state.sel = null;
  if (dock.active === key) dockActivate([...dock.tabs.keys()].pop() ?? null); else dockRender();
}
// Claude sessions describe one cluster; drop them (and the operator tab) when the context or mode changes.
function resetDock() { closeDrawer(); for (const k of [...dock.tabs.keys()]) if (k.startsWith('claude:')) dockClose(k); }

async function openDrawer(id, tab = 'overview') {
  state.sel = id; state.tab = tab; state.detail = null; state.logPod = null;
  const o = state.data.operators.find(x => x.id === id);
  dockOpen('op', o ? o.name : id, () => h('div', { id: 'drawer-body' }));
  renderDrawer();
  await refreshDetail();
}
function closeDrawer() { dockClose('op'); }
async function refreshDetail() {
  const id = state.sel;
  try {
    const d = await api('/api/operator?' + qs({ id }));
    if (state.sel !== id) return;
    state.detail = d; renderDrawer();
  } catch (e) { if (state.sel === id) { state.detail = { error: e.message }; renderDrawer(); } }
}
function renderDrawer() {
  if (!$('drawer-body')) return;
  const d = state.detail, summary = state.data.operators.find(o => o.id === state.sel);
  const o = d && !d.error ? d : summary;
  if (!o) { $('drawer-body').replaceChildren(h('div', { class: 'dbody' }, h('p', {}, 'This operator no longer exists.'), h('button', { class: 'btn', onclick: closeDrawer }, 'Close'))); return; }
  const head = h('div', { class: 'dh' },
    h('h2', {}, o.name, badge(o.status)),
    h('div', { class: 'sub' }, `${o.namespace}${o.version ? ' · v' + o.version.replace(/^v/, '') : ''} · ${o.source === 'olm' ? 'OLM-managed' : 'detected'}`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => doRestart(o) }, '⟳ Restart'),
      h('button', { class: 'btn', onclick: () => doScale(o) }, 'Scale…'),
      o.crds.length > 0 && h('button', { class: 'btn', onclick: () => { state.tab = 'resources'; renderDrawer(); } }, 'Create resource…'),
      h('button', { class: 'btn', onclick: refreshDetail }, 'Reload'),
      h('button', { class: 'btn claude', onclick: () => askClaude(o) }, '✦ Ask Claude'),
      o.helm && h('button', { class: 'btn danger', onclick: () => doUninstall(o) }, 'Uninstall')),
    h('div', { class: 'dtabs', role: 'tablist' }, TABS.map(([k, label]) =>
      h('button', { role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => { state.tab = k; renderDrawer(); } }, label))));
  const body = h('div', { class: 'dbody' });
  if (d && d.error) body.append(h('div', { class: 'msg err' }, d.error));
  else tabBody(body, o, d && !d.error ? d : null);
  $('drawer-body').replaceChildren(head, body);
}
function tabBody(body, o, d) {
  const loading = () => body.append(h('p', { class: 'muted' }, 'Loading…'));
  switch (state.tab) {
    case 'overview':
      body.append(h('dl', { class: 'kv' },
        h('dt', {}, 'Replicas'), h('dd', {}, `${o.ready} ready of ${o.desired}`),
        h('dt', {}, 'Deployments'), h('dd', {}, o.deployments.join(', ')),
        h('dt', {}, 'Images'), h('dd', {}, o.images.map(i => h('div', {}, h('code', {}, i)))),
        o.provider && [h('dt', {}, 'Provider'), h('dd', {}, o.provider)],
        h('dt', {}, 'CRDs'), h('dd', {}, o.crds.map(c => c.kind).join(', ') || '—'),
        h('dt', {}, 'Resources'), h('dd', {}, String(o.instanceCount)),
        h('dt', {}, 'Restarts'), h('dd', {}, String(o.restarts)),
        h('dt', {}, 'Age'), h('dd', {}, age(o.created))),
        o.description && h('p', { class: 'muted' }, o.description));
      if (!d) return loading();
      if (d.conditions.length) body.append(h('h3', {}, 'Conditions'), ...d.conditions.map(c => h('div', { class: 'ev' }, h('span', { class: 'r' }, c.type), ' ', c.status, c.reason ? ` · ${c.reason}` : '', c.message ? h('div', { class: 'muted' }, c.message) : null)));
      break;
    case 'resources':
      if (!o.crds.length) body.append(h('p', { class: 'muted' }, 'No custom resource definitions are attributed to this operator.'));
      for (const c of o.crds) {
        body.append(h('details', { open: c.instances.length > 0 && o.crds.length <= 4 },
          h('summary', {}, h('b', {}, c.kind), h('span', { class: 'muted' }, `${c.group}/${c.storageVersion || c.versions[0]} · ${c.scope}`), h('span', { class: 'spacer' }), h('span', { class: 'num' }, c.instances.length),
            h('button', { class: 'btn small', title: `Create a new ${c.kind}`, onclick: e => { e.preventDefault(); e.stopPropagation(); newCR(o, c); } }, '+ New')),
          c.instances.length ? h('table', {}, h('tbody', {}, c.instances.map(i => h('tr', {},
            h('td', {}, badge(i.status)), h('td', {}, h('div', { class: 'name' }, i.name), h('div', { class: 'muted' }, i.namespace || 'cluster-wide')), h('td', { class: 'num' }, age(i.created)),
            h('td', {}, h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: () => openCR(o.id, c, i) }, 'View / edit'),
              h('button', { class: 'btn small danger', onclick: () => doDelete(o, c, i) }, 'Delete'))))))) : h('div', { class: 'dbody muted' }, 'No instances')));
      }
      break;
    case 'pods': {
      if (!d) return loading();
      if (!d.pods.length) return body.append(h('p', { class: 'muted' }, 'No pods (is the operator scaled to 0?)'));
      const multiNs = new Set(d.pods.map(p => p.namespace)).size > 1;
      body.append(h('table', {}, h('thead', {}, h('tr', {}, ...['Pod', 'Ready', 'State', 'Restarts', 'Node', 'Age', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, d.pods.map(p => h('tr', {},
          h('td', {}, h('code', {}, p.name), h('div', { class: 'muted' }, [multiNs && p.namespace, p.role === 'managed' ? `managed by ${p.owner}` : 'operator'].filter(Boolean).join(' · '))),
          h('td', { class: 'num' }, p.ready ? '1/1' : '0/1'),
          h('td', {}, badge(p.reason ? 'Degraded' : p.ready ? 'Healthy' : 'Progressing'), ' ', p.reason || p.phase),
          h('td', { class: 'num' }, p.restarts), h('td', {}, p.node || '—'), h('td', { class: 'num' }, age(p.created)),
          h('td', {}, h('button', { class: 'btn small', onclick: () => { state.logPod = p.name; state.tab = 'logs'; renderDrawer(); } }, 'Logs')))))));
      break;
    }
    case 'logs': {
      if (!d) return loading();
      if (!d.pods.length) return body.append(h('p', { class: 'muted' }, 'No pods to read logs from.'));
      if (!state.logPod || !d.pods.some(p => p.name === state.logPod)) state.logPod = d.pods[0].name;
      const pre = h('pre', { class: 'log' }, 'Loading…');
      const fetchLogs = async () => {
        pre.textContent = 'Loading…';
        try { pre.textContent = (await api('/api/logs?' + qs({ id: o.id, pod: state.logPod, ns: (d.pods.find(p => p.name === state.logPod) || {}).namespace, tail: state.logTail }))).text || '(no output)'; pre.scrollTop = pre.scrollHeight; }
        catch (e) { pre.textContent = e.message; }
      };
      body.append(h('div', { class: 'row' },
        h('select', { 'aria-label': 'Pod', onchange: e => { state.logPod = e.target.value; fetchLogs(); } }, d.pods.map(p => h('option', { value: p.name, selected: p.name === state.logPod }, p.name))),
        h('select', { 'aria-label': 'Lines', onchange: e => { state.logTail = +e.target.value; fetchLogs(); } }, [100, 200, 500, 1000].map(n => h('option', { value: n, selected: n === state.logTail }, `last ${n}`))),
        h('button', { class: 'btn', onclick: fetchLogs }, 'Refresh')), pre);
      fetchLogs();
      break;
    }
    case 'events':
      if (!d) return loading();
      body.append(d.events.length ? h('div', {}, d.events.map(e => h('div', { class: 'ev ' + e.type }, h('span', { class: 'r' }, e.reason), h('span', { class: 'muted' }, ` · ${e.object} · ${age(e.time)} ago${e.count > 1 ? ` · ×${e.count}` : ''}`), h('div', {}, e.message)))) : h('p', { class: 'muted' }, 'No recent events.'));
      break;
    case 'manifest': {
      const pre = h('pre', { class: 'log' }, 'Loading…');
      const sel = h('select', { 'aria-label': 'Deployment', onchange: () => load1() }, o.deployments.map(n => h('option', { value: n }, n)));
      const load1 = async () => { try { pre.textContent = (await api('/api/yaml?' + qs({ id: o.id, deployment: sel.value }))).text; } catch (e) { pre.textContent = e.message; } };
      body.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Deployment'), sel), pre);
      load1();
      break;
    }
  }
}

// ---- dialogs & actions -----------------------------------------------------
function dialog(content) {
  const d = $('dlg');
  d.replaceChildren(h('div', { class: 'dlg' }, content));
  if (!d.open) d.showModal();
  return d;
}
function confirmDlg(title, text, okLabel, danger) {
  return new Promise(resolve => {
    const d = dialog([h('h2', {}, title), h('p', {}, text),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => d.close('no') }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => d.close('yes') }, okLabel))]);
    d.onclose = () => resolve(d.returnValue === 'yes');
  });
}
async function act(fn, okMsg) {
  try { const r = await fn(); toast(r && r.message || okMsg); await load(); if (state.sel) await refreshDetail(); }
  catch (e) { toast(e.message, true); }
}
async function doRestart(o) {
  if (await confirmDlg(`Restart ${o.name}?`, `Runs a rolling restart of ${o.deployments.join(', ')} in ${o.namespace}. Managed workloads keep running, but reconciliation pauses briefly.`, 'Restart', false))
    act(() => api('/api/restart', { id: o.id }));
}
function doScale(o) {
  const input = h('input', { type: 'number', min: 0, max: 20, value: o.desired, 'aria-label': 'Replicas', style: 'width:90px' });
  const d = dialog([h('h2', {}, `Scale ${o.name}`),
    h('p', { class: 'muted' }, 'Setting replicas to 0 pauses the operator: existing resources keep running but are no longer reconciled.'),
    h('div', { class: 'row' }, 'Replicas', input),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => { d.close(); act(() => api('/api/scale', { id: o.id, replicas: +input.value })); } }, 'Scale'))]);
  input.select();
}
async function doDelete(o, c, i) {
  if (await confirmDlg(`Delete ${c.kind} “${i.name}”?`, `This deletes ${c.plural}.${c.group}/${i.name}${i.namespace ? ' in ' + i.namespace : ''} from the cluster. The operator will tear down whatever it manages for it.`, 'Delete', true))
    act(() => api('/api/delete', { id: o.id, crd: c.name, name: i.name, ns: i.namespace }));
}
async function newCR(o, c) {
  let text;
  try { text = (await api('/api/template?' + qs({ id: o.id, crd: c.name, ns: o.namespace }))).text; }
  catch (e) { return toast(e.message, true); }
  const ta = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Manifest YAML' }, text);
  const msg = h('div', { class: 'msg', hidden: true });
  const show = (t, err) => { msg.hidden = false; msg.className = 'msg ' + (err ? 'err' : 'ok'); msg.textContent = t; };
  const run = async dry => {
    try { show((await api('/api/apply', { id: o.id, yaml: ta.value, dryRun: dry, create: true })).message); if (!dry) { await load(); await refreshDetail(); } }
    catch (e) { show(e.message, true); }
  };
  const d = dialog([h('h2', {}, `New ${c.kind}`),
    h('div', { class: 'muted' }, `Starter manifest from the ${c.name} schema: required fields are filled in (replace CHANGE_ME), optional fields are listed in comments.`),
    ta, msg,
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => d.close() }, 'Close'),
      h('button', { class: 'btn', onclick: () => run(true) }, 'Validate (dry run)'),
      h('button', { class: 'btn primary', onclick: () => run(false) }, 'Create'))]);
  ta.focus();
}
async function openCR(id, c, i) {
  let text;
  try { text = (await api('/api/yaml?' + qs({ id, crd: c.name, name: i.name, ns: i.namespace }))).text; }
  catch (e) { return toast(e.message, true); }
  const ta = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Manifest YAML' }, text);
  const msg = h('div', { class: 'msg', hidden: true });
  const show = (t, err) => { msg.hidden = false; msg.className = 'msg ' + (err ? 'err' : 'ok'); msg.textContent = t; };
  const run = async dryRun => { try { show((await api('/api/apply', { id, yaml: ta.value, dryRun })).message); if (!dryRun) await load(); } catch (e) { show(e.message, true); } };
  const d = dialog([h('h2', {}, `${c.kind} / ${i.name}`), h('div', { class: 'muted' }, 'Edit and apply the manifest. Status and managed fields are ignored by the API server.'), ta, msg,
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => d.close() }, 'Close'),
      h('button', { class: 'btn claude', onclick: () => { d.close(); askClaude(state.data.operators.find(x => x.id === id) || { id, name: id }, { crd: c.name, name: i.name, ns: i.namespace }, `${c.kind}/${i.name}`); } }, '✦ Ask Claude'),
      h('button', { class: 'btn', onclick: () => run(true) }, 'Validate (dry run)'),
      h('button', { class: 'btn primary', onclick: () => run(false) }, 'Apply'))]);
}

// ---- ask Claude ------------------------------------------------------------
// Minimal safe Markdown: fenced code blocks (with Copy), `inline code`, **bold**, paragraphs.
function inline(t) {
  return t.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map(x =>
    x.startsWith('`') ? h('code', {}, x.slice(1, -1)) : x.startsWith('**') ? h('b', {}, x.slice(2, -2)) : x);
}
function markdown(src) {
  const out = [];
  for (const [i, chunk] of src.split(/^```.*\n?/m).entries()) {
    if (i % 2) {
      const code = chunk.replace(/\n$/, '');
      const copy = h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; } } }, 'Copy');
      const runnable = /^kubectl\s/.test(code) && !code.includes('\n') && !/[|><;&]/.test(code);
      out.push(h('div', { class: 'codeblock' }, h('span', { class: 'cbtns' }, runnable && h('button', { class: 'btn small', onclick: () => kubectlConsole(code) }, 'Run in console'), copy), h('pre', { class: 'log' }, code)));
    } else for (const para of chunk.split(/\n{2,}/).filter(x => x.trim())) {
      const lines = para.split('\n');
      if (/^\s*(\d+\.|[-*])\s/.test(lines[0])) out.push(h('ul', {}, lines.map(l => h('li', {}, inline(l.replace(/^\s*(\d+\.|[-*])\s/, ''))))));
      else out.push(h('p', {}, inline(para.replace(/\n/g, ' '))));
    }
  }
  return out;
}
function askClaude(o, target, label) {
  const key = `claude:${o.id}|${target ? `${target.crd}/${target.ns || ''}/${target.name}` : ''}`;
  dockOpen(key, `✦ ${label || o.name}`, () => {
    const q = h('input', { type: 'text', placeholder: 'Optional: what are you seeing? (default: diagnose and suggest a fix)', 'aria-label': 'Question', style: 'flex:1;min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--text)' });
    const preview = h('pre', { class: 'log', style: 'max-height:30vh' }, 'Collecting diagnostics…');
    const answer = h('div', { class: 'answer' });
    const askBtn = h('button', { class: 'btn primary', disabled: true }, 'Ask Claude');
    const loadPreview = async () => {
      try { preview.textContent = (await api('/api/assist/context', { id: o.id, target })).text; askBtn.disabled = false; }
      catch (e) { preview.textContent = e.message; }
    };
    const go = async () => {
      askBtn.disabled = true; q.disabled = true; askBtn.textContent = 'Thinking…';
      answer.replaceChildren(h('p', { class: 'muted' }, 'Claude is analysing the diagnostics. This can take up to a minute; you can switch tabs meanwhile.'));
      try { answer.replaceChildren(...markdown((await api('/api/assist/ask', { id: o.id, target, question: q.value })).text)); }
      catch (e) { answer.replaceChildren(h('div', { class: 'msg err' }, e.message)); }
      askBtn.disabled = false; q.disabled = false; askBtn.textContent = 'Ask again';
      loadPreview();
    };
    askBtn.onclick = go;
    q.onkeydown = e => { if (e.key === 'Enter' && !askBtn.disabled) go(); };
    loadPreview();
    return h('div', { class: 'dbody' }, h('h2', { style: 'margin:0 0 6px;font-size:18px' }, `Ask Claude about ${label || o.name}`),
      h('div', { class: 'muted' }, 'Read-only diagnostics (status, pods, events, recent logs' + (target ? ', this resource' : '') + ') are sent to Claude through your local claude CLI after you click Ask. Obvious credentials are redacted, but review it first. Claude cannot run anything; apply fixes yourself.'),
      h('details', { style: 'margin:10px 0' }, h('summary', {}, 'What will be sent'), preview),
      h('div', { class: 'row' }, q, askBtn), answer);
  });
}

// ---- add operator ----------------------------------------------------------
function addOperator() {
  const src = h('input', { type: 'text', placeholder: 'https://github.com/owner/repo  or  /path/to/operator', 'aria-label': 'GitHub URL or local folder', style: 'flex:1;min-width:260px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px' });
  const rel = h('input', { type: 'text', 'aria-label': 'Release name', placeholder: 'release name (Helm)', style: 'width:150px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px' });
  const ns = h('input', { type: 'text', 'aria-label': 'Namespace', placeholder: 'namespace (Helm)', style: 'width:150px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px' });
  const detected = h('div'), msg = h('div', { class: 'msg', hidden: true }), foot = h('div', { class: 'foot' });
  let plan = null;
  const show = (t, err) => { msg.hidden = false; msg.className = 'msg ' + (err ? 'err' : 'ok'); msg.textContent = t; };
  const pick = () => { const r = detected.querySelector('input[name=m]:checked'); return r ? +r.value : -1; };
  const setBusy = (b, label) => { for (const x of d.querySelectorAll('button')) x.disabled = b; if (label) show(label); };
  const inspect = async () => {
    plan = null; detected.replaceChildren(); foot.replaceChildren(close, inspectBtn); msg.hidden = true;
    setBusy(true, /github\.com/.test(src.value) ? 'Cloning repository…' : 'Inspecting folder…');
    try {
      plan = await api('/api/install/plan', { source: src.value });
      msg.hidden = true;
      detected.replaceChildren(h('h3', {}, `Found in ${plan.origin}`),
        ...plan.warnings.map(w => h('div', { class: 'msg err' }, w)),
        ...plan.candidates.map((c, i) => h('label', { class: 'ev', style: 'display:block;cursor:pointer' },
          h('input', { type: 'radio', name: 'm', value: c.index, disabled: !!c.unavailable, checked: i === plan.candidates.findIndex(x => !x.unavailable) }), ' ', h('b', {}, c.label), c.unavailable && h('span', { class: 'tag' }, c.unavailable), h('div', { class: 'muted' }, h('code', {}, c.command)))));
      if (plan.candidates.some(c => !c.unavailable)) foot.replaceChildren(close, h('button', { class: 'btn', onclick: () => run(true) }, 'Dry run'), h('button', { class: 'btn primary', onclick: () => run(false) }, 'Install'));
    } catch (e) { show(e.message, true); }
    setBusy(false);
    if (plan && plan.candidates.some(c => !c.unavailable)) foot.querySelector('.primary').focus();
  };
  const run = async dry => {
    if (!dry && !(await confirmInstall(plan, pick()))) return;
    setBusy(true, dry ? 'Running dry run…' : 'Installing…');
    try {
      show((await api('/api/install/apply', { planId: plan.id, index: pick(), dryRun: dry, release: rel.value, namespace: ns.value })).message);
      if (!dry) { toast('Installed. Waiting for the operator to appear…'); load(); setTimeout(load, 4000); setTimeout(load, 12000); }
    } catch (e) { show(e.message, true); }
    setBusy(false);
  };
  const close = h('button', { class: 'btn', onclick: () => d.close() }, 'Close');
  const inspectBtn = h('button', { class: 'btn primary', onclick: inspect }, 'Inspect');
  src.addEventListener('keydown', e => e.key === 'Enter' && inspect());
  foot.append(close, inspectBtn);
  const cat = h('div');
  api('/api/catalog').then(r => cat.replaceChildren(h('h3', {}, 'Catalog'), ...r.items.map(p =>
    h('div', { class: 'ev', style: 'display:flex;gap:12px;align-items:center' },
      h('div', { style: 'flex:1' }, h('b', {}, p.name), h('div', { class: 'muted' }, p.description)),
      h('button', { class: 'btn primary', onclick: () => presetForm(p) }, 'Install…')),
    ), h('h3', {}, 'From GitHub or a local folder'))).catch(() => {});
  const d = dialog([h('h2', {}, 'Add operator'), cat,
    h('div', { class: 'muted' }, 'Point at a GitHub repo (https://github.com/owner/repo[/tree/branch/path]) or a folder on this machine. k8oui detects how to install it; nothing runs until you choose Dry run or Install.'),
    h('div', { class: 'row' }, src), h('div', { class: 'row' }, rel, ns, h('span', { class: 'muted' }, 'Helm only; blank = defaults')),
    detected, msg, foot]);
  src.focus();
}
function confirmInstall(plan, i) { return swapConfirm('Install this operator?', plan.candidates[i].command); }
function swapConfirm(title, text) {
  return new Promise(resolve => {
    const d = $('dlg');
    const prev = [...d.firstChild.childNodes];
    const back = v => { d.replaceChildren(h('div', { class: 'dlg' }, prev)); resolve(v); };
    d.replaceChildren(h('div', { class: 'dlg' }, h('h2', {}, title),
      h('p', {}, 'This runs the following against your current cluster and applies code from the source you entered. Review it first.'),
      h('pre', { class: 'log' }, text), h('div', { class: 'foot' },
        h('button', { class: 'btn', onclick: () => back(false) }, 'Back'), h('button', { class: 'btn primary', onclick: () => back(true) }, 'Install'))));
  });
}

const INPUT_STYLE = 'background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px';
function presetForm(p) {
  const field = (label, input) => h('label', { style: 'display:grid;gap:3px' }, h('span', { class: 'muted' }, label), input);
  const text = (v, extra) => h('input', { type: 'text', value: v || '', autocomplete: 'off', spellcheck: 'false', style: INPUT_STYLE, ...extra });
  const ns = text(p.defaultNamespace), version = text('', { placeholder: 'latest, or e.g. 25.10.*' });
  const secretName = text(p.registry.secretName);
  const user = text('', { 'aria-label': 'Username' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password or token', style: INPUT_STYLE });
  const mode = ['create', 'existing'].map(v => h('input', { type: 'radio', name: 'secretmode', value: v, checked: v === 'create', onchange: sync }));
  const opts = p.options.map(o => h('input', { type: 'checkbox', 'data-key': o.key }));
  const creds = h('div', { style: 'display:grid;gap:8px;grid-template-columns:1fr 1fr' }, field('Username', user), field('Password / token', pass));
  const msg = h('div', { class: 'msg', hidden: true });
  const show = (t, err) => { msg.hidden = false; msg.className = 'msg ' + (err ? 'err' : 'ok'); msg.textContent = t; msg.scrollIntoView({ block: 'nearest' }); };
  function sync() { creds.style.display = mode[0].checked ? 'grid' : 'none'; }
  const body = dry => ({ preset: p.id, namespace: ns.value, secretName: secretName.value, createSecret: mode[0].checked,
    username: user.value, password: pass.value, version: version.value, dryRun: dry, options: Object.fromEntries(opts.map(o => [o.dataset.key, o.checked])) });
  const busy = b => { for (const x of d.querySelectorAll('button')) x.disabled = b; };
  const go = async dry => {
    msg.hidden = true;
    try {
      if (!dry) {
        const pv = await api('/api/catalog/preview', body(false));
        if (!(await swapConfirm(`Install ${p.name}?`, pv.steps.join('\n\n')))) return;
      }
      busy(true); show(dry ? 'Running dry run…' : 'Installing… this can take a minute.');
      show((await api('/api/catalog/install', body(dry))).message);
      if (!dry) { pass.value = ''; toast('Installed. Waiting for the operator to appear…'); load(); setTimeout(load, 4000); setTimeout(load, 12000); }
    } catch (e) { show(e.message, true); }
    busy(false);
  };
  const d = dialog([h('h2', {}, `Install ${p.name}`),
    h('div', { class: 'muted' }, 'Installs the CRDs chart and the operator with Helm into one namespace. ', h('a', { href: p.docs, target: '_blank', rel: 'noopener noreferrer' }, 'Documentation')),
    h('div', { style: 'display:grid;gap:8px;grid-template-columns:1fr 1fr' }, field('Namespace', ns), field('Chart version (optional)', version)),
    h('h3', {}, `Image pull secret for ${p.registry.server}`),
    h('label', {}, mode[0], ' Create it from my MariaDB customer credentials'),
    h('label', {}, mode[1], ' Use a secret that already exists in that namespace'),
    creds, field('Secret name', secretName),
    h('div', { class: 'muted' }, 'Credentials are sent only to your local k8oui server, written to the cluster as a Secret, and never stored or logged by k8oui.'),
    h('h3', {}, 'Options'), ...p.options.map((o, i) => h('label', {}, opts[i], ' ', o.label)),
    msg,
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: addOperator }, 'Back'), h('button', { class: 'btn', onclick: () => d.close() }, 'Close'),
      h('button', { class: 'btn', onclick: () => go(true) }, 'Dry run'), h('button', { class: 'btn primary', onclick: () => go(false) }, 'Install'))]);
  user.focus();
}
async function doUninstall(o) {
  if (await confirmDlg(`Uninstall ${o.name}?`, `Runs helm uninstall for release ${o.helm}. The operator stops reconciling; its CRDs and existing custom resources stay in the cluster.`, 'Uninstall', true))
    act(async () => { const r = await api('/api/uninstall', { id: o.id }); closeDrawer(); return r; }, 'Uninstalled');
}

// ---- wiring ----------------------------------------------------------------
let timer;
function schedule() { clearInterval(timer); if ($('auto').checked) timer = setInterval(() => !document.hidden && !$('dlg').open && load(), 10000); }
$('auto').checked = store.get('auto', true);
$('auto').onchange = () => { store.set('auto', $('auto').checked); schedule(); };
$('refresh').onclick = load;
$('add').onclick = addOperator;
$('ctx').onchange = async e => { try { await api('/api/context', { name: e.target.value }); resetDock(); await load(); } catch (err) { toast(err.message, true); } };
$('search').oninput = e => { state.q = e.target.value; if (state.data) renderMain(); };
for (const b of $('views').children) b.onclick = () => { state.view = b.dataset.view; store.set('view', state.view); renderMain(); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('dlg').open && dock.active === 'op' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) closeDrawer();
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('search').focus(); }
});
schedule();
load();

// ---- kubectl console (a dock tab) -------------------------------------------
const kHist = [];
function kubectlConsole(prefill = '') {
  dockOpen('kubectl', '>_ kubectl', () => {
    const input = h('input', { type: 'text', class: 'kinput', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'kubectl command', placeholder: 'get pods -A    (no shell: one kubectl command, no pipes)' });
    const out = h('pre', { class: 'log', style: 'min-height:120px;max-height:none;white-space:pre;word-break:normal' }, 'Runs against the selected context. Mutating commands ask for confirmation.');
    const runBtn = h('button', { class: 'btn primary' }, 'Run');
    let hi = kHist.length;
    const run = async () => {
      const command = input.value.trim(); if (!command) return;
      if (kHist[kHist.length - 1] !== command) kHist.push(command); hi = kHist.length;
      runBtn.disabled = true; out.textContent = 'Running…';
      try {
        let r = await api('/api/kubectl', { command });
        if (r.needsConfirm) {
          if (!await confirmDlg('Run a command that changes the cluster?', r.command, 'Run', true)) { out.textContent = 'Cancelled.'; return; }
          out.textContent = 'Running…';
          r = await api('/api/kubectl', { command, confirm: true });
        }
        out.textContent = `$ kubectl ${command.replace(/^kubectl\s+/, '')}\n${r.output || '(no output)'}${r.code ? `\n[exit ${r.code}]` : ''}`;
        out.scrollTop = out.scrollHeight;
        if (r.code === 0 && /^(kubectl\s+)?(apply|create|delete|patch|scale|label|annotate|set|replace|taint|cordon|uncordon|drain|expose|autoscale|rollout)\b/.test(command)) load();
      } catch (e) { out.textContent = e.message; }
      finally { runBtn.disabled = false; input.focus(); }
    };
    runBtn.onclick = run;
    input.onkeydown = e => {
      if (e.key === 'Enter') run();
      else if (e.key === 'ArrowUp' && kHist.length) { hi = Math.max(0, hi - 1); input.value = kHist[hi]; e.preventDefault(); }
      else if (e.key === 'ArrowDown') { hi = Math.min(kHist.length, hi + 1); input.value = kHist[hi] || ''; e.preventDefault(); }
    };
    return h('div', { class: 'dbody' }, h('h2', { style: 'margin:0 0 10px;font-size:18px' }, 'kubectl'), h('div', { class: 'row' }, h('span', { class: 'muted' }, 'kubectl'), input, runBtn), out);
  });
  const input = document.querySelector('.kinput');
  if (prefill) input.value = prefill.replace(/^kubectl\s+/, '');
  input.focus();
}
$('kubectl').onclick = () => kubectlConsole();
