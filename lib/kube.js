'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Live backend: shells out to kubectl (argument arrays, never a shell) so it
// uses whatever kubeconfig/context/auth plugins the user already has.
const { exec, lookup, build, validateOpts } = require('./source');
const catalog = require('./catalog');

let contextOverride = null;

function run(args, { bin = 'kubectl', ...opts } = {}) {
  const flag = bin === 'helm' ? '--kube-context' : '--context';
  return exec(bin, contextOverride ? [flag, contextOverride, ...args] : args, opts);
}
const json = async args => JSON.parse(await run([...args, '-o', 'json']));

const NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const checkName = (v, what) => { if (typeof v !== 'string' || !NAME.test(v)) throw bad(`invalid ${what}`); return v; };

async function ping() {
  await run(['get', '--raw', '/readyz', '--request-timeout=4s'], { timeout: 8000 });
}

// ---- operator discovery ---------------------------------------------------

const GENERIC = new Set(['k8s', 'storage', 'networking', 'apiextensions', 'admissionregistration', 'apps', 'batch',
  'policy', 'rbac', 'authentication', 'authorization', 'certificates', 'coordination', 'discovery', 'events',
  'flowcontrol', 'node', 'scheduling', 'autoscaling', 'gateway', 'metrics', 'x-k8s', 'internal', 'resource']);
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function looksLikeOperator(d) {
  const ns = d.metadata.namespace;
  if (ns === 'kube-system' || ns === 'olm') return false;
  const l = d.metadata.labels || {};
  return l['control-plane'] === 'controller-manager' ||
    /operator|controller-manager/.test(d.metadata.name) ||
    /operator/.test(l['app.kubernetes.io/component'] || '') ||
    /operator/.test(l['app.kubernetes.io/name'] || '');
}

function crdInfo(c) {
  const vs = c.spec.versions || [];
  return {
    name: c.metadata.name, group: c.spec.group, kind: c.spec.names.kind, plural: c.spec.names.plural,
    scope: c.spec.scope, versions: vs.filter(v => v.served).map(v => v.name),
    storageVersion: (vs.find(v => v.storage) || {}).name,
  };
}

function instStatus(o) {
  const s = o.status || {};
  const conds = s.conditions || [];
  const c = conds.find(c => ['Ready', 'Available', 'Healthy'].includes(c.type));
  if (c) return c.status === 'True' ? 'Healthy' : c.status === 'False' ? 'Degraded' : 'Unknown';
  const ph = String((s.health && s.health.status) || s.phase || s.state || '').toLowerCase();
  if (/^(running|ready|active|succeeded|healthy|bound|synced|deployed|available|completed)$/.test(ph)) return 'Healthy';
  if (/fail|error|degraded|crash|invalid|unhealthy|missing/.test(ph)) return 'Degraded';
  if (/pend|progress|creat|updat|provision|sync|init/.test(ph)) return 'Progressing';
  return 'Unknown';
}

function depStatus(ready, desired, pods) {
  if (desired === 0) return 'Paused';
  if (pods.some(p => /CrashLoop|Error|ImagePull|OOMKilled/.test(p.reason || ''))) return 'Degraded';
  if (ready >= desired) return 'Healthy';
  if (pods.some(p => p.phase === 'Pending' || p.phase === 'ContainerCreating' || !p.ready)) return 'Progressing';
  return 'Degraded';
}

async function discover() {
  const [deps, crdList, csvs] = await Promise.all([
    json(['get', 'deploy', '-A']),
    json(['get', 'crd']),
    json(['get', 'csv', '-A']).catch(() => ({ items: [] })),
  ]);
  const crds = new Map(crdList.items.map(c => [c.metadata.name, crdInfo(c)]));
  const depIndex = new Map(deps.items.map(d => [`${d.metadata.namespace}/${d.metadata.name}`, d]));
  const ops = [];
  const claimed = new Set();
  const seenCsv = new Set();

  // 1. OLM-managed operators
  for (const csv of csvs.items) {
    const opNs = (csv.metadata.annotations || {})['olm.operatorNamespace'] || csv.metadata.namespace;
    if (csv.metadata.namespace !== opNs) continue; // skip OLM's per-namespace copies
    const key = `${opNs}/${csv.metadata.name}`;
    if (seenCsv.has(key)) continue; seenCsv.add(key);
    const specDeps = (csv.spec.install && csv.spec.install.spec && csv.spec.install.spec.deployments) || [];
    const owned = ((csv.spec.customresourcedefinitions || {}).owned || []).map(o => o.name);
    specDeps.forEach(d => claimed.add(`${opNs}/${d.name}`));
    ops.push({
      id: `${opNs}/${specDeps[0] ? specDeps[0].name : csv.metadata.name}`,
      name: csv.spec.displayName || csv.metadata.name, namespace: opNs, version: csv.spec.version,
      source: 'olm', provider: (csv.spec.provider || {}).name, description: csv.spec.description && csv.spec.description.split('\n')[0],
      csvPhase: (csv.status || {}).phase, deployments: specDeps.map(d => d.name), crdNames: owned.filter(n => crds.has(n)),
    });
  }

  // 2. Heuristically detected operators (Helm/kustomize/plain manifests)
  const found = deps.items.filter(d => !claimed.has(`${d.metadata.namespace}/${d.metadata.name}`) && looksLikeOperator(d));
  const inferred = found.map(d => {
    const l = d.metadata.labels || {}, a = d.metadata.annotations || {};
    const img = d.spec.template.spec.containers[0].image || '';
    return {
      id: `${d.metadata.namespace}/${d.metadata.name}`,
      name: l['app.kubernetes.io/name'] || l['app.kubernetes.io/instance'] || d.metadata.name.replace(/-?(controller-manager|operator|controller)$/, '') || d.metadata.name,
      namespace: d.metadata.namespace,
      version: l['app.kubernetes.io/version'] || (img.split(':')[1] || '').split('@')[0] || undefined,
      source: 'inferred', deployments: [d.metadata.name], crdNames: [],
      helm: a['meta.helm.sh/release-name'] ? `${a['meta.helm.sh/release-namespace']}/${a['meta.helm.sh/release-name']}` : null,
      tokens: [norm(d.metadata.name), norm(d.metadata.namespace), norm(l['app.kubernetes.io/name'] || ''), norm(l['app.kubernetes.io/part-of'] || '')].filter(Boolean),
    };
  });
  const free = new Set([...crds.keys()]);
  ops.forEach(o => o.crdNames.forEach(n => free.delete(n)));
  const rawCrd = new Map(crdList.items.map(c => [c.metadata.name, c]));
  for (const n of free) {
    const ci = crds.get(n), raw = rawCrd.get(n);
    const ann = raw.metadata.annotations || {};
    const helm = ann['meta.helm.sh/release-name'] ? `${ann['meta.helm.sh/release-namespace']}/${ann['meta.helm.sh/release-name']}` : null;
    const relBase = helm && helm.replace(/-crds$/, '');
    let hit = helm && inferred.find(o => o.helm === helm || o.helm === relBase);
    if (!hit) {
      const labels = ci.group.split('.').map(norm).filter(l => l.length >= 4 && !GENERIC.has(l));
      hit = inferred.find(o => labels.some(l => o.tokens.some(t => t.includes(l))));
    }
    if (hit) hit.crdNames.push(n);
  }
  ops.push(...inferred);
  return { ops, crds, depIndex };
}

async function fetchInstances(c) {
  try {
    const r = await json(['get', `${c.plural}.${c.group}`, '-A', '--request-timeout=10s']);
    return r.items.slice(0, 200).map(o => ({
      name: o.metadata.name, namespace: o.metadata.namespace, status: instStatus(o), created: o.metadata.creationTimestamp,
    }));
  } catch { return []; }
}

async function podsFor(dep) {
  const sel = Object.entries((dep.spec.selector || {}).matchLabels || {}).map(([k, v]) => `${k}=${v}`).join(',');
  if (!sel) return [];
  const r = await json(['get', 'pods', '-n', dep.metadata.namespace, '-l', sel]);
  return r.items.map(p => {
    const cs = p.status.containerStatuses || [];
    const waiting = cs.map(c => c.state && c.state.waiting && c.state.waiting.reason).find(Boolean);
    const term = cs.map(c => c.lastState && c.lastState.terminated && c.lastState.terminated.reason).find(Boolean);
    return {
      name: p.metadata.name, phase: p.status.phase, ready: cs.length > 0 && cs.every(c => c.ready),
      restarts: cs.reduce((n, c) => n + c.restartCount, 0), node: p.spec.nodeName, created: p.metadata.creationTimestamp,
      reason: waiting || (p.status.phase === 'Failed' ? p.status.reason : undefined) || (waiting ? term : undefined),
      containers: p.spec.containers.map(c => c.name),
    };
  });
}

let cache = null, cacheAt = 0, inflight = null;
async function operators(force) {
  if (!force && cache && Date.now() - cacheAt < 4000) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const { ops, crds, depIndex } = await discover();
    const out = await Promise.all(ops.map(async o => {
      const deps = o.deployments.map(n => depIndex.get(`${o.namespace}/${n}`)).filter(Boolean);
      const pods = (await Promise.all(deps.map(podsFor))).flat();
      const desired = deps.reduce((n, d) => n + (d.spec.replicas ?? 1), 0);
      const ready = deps.reduce((n, d) => n + (d.status.readyReplicas || 0), 0);
      let status = deps.length ? depStatus(ready, desired, pods) : 'Unknown';
      if (o.csvPhase && o.csvPhase !== 'Succeeded' && status === 'Healthy') status = o.csvPhase === 'Installing' ? 'Progressing' : 'Degraded';
      const cr = await Promise.all(o.crdNames.map(async n => {
        const c = crds.get(n); return { ...c, instances: await fetchInstances(c) };
      }));
      const images = [...new Set(deps.flatMap(d => d.spec.template.spec.containers.map(c => c.image)))];
      return {
        id: o.id, name: o.name, namespace: o.namespace, version: o.version, source: o.source, provider: o.provider, helm: o.helm || undefined,
        description: o.description, status, ready, desired, images, deployments: o.deployments,
        crds: cr, instanceCount: cr.reduce((n, c) => n + c.instances.length, 0),
        restarts: pods.reduce((n, p) => n + p.restarts, 0), created: deps[0] && deps[0].metadata.creationTimestamp,
      };
    }));
    out.sort((a, b) => a.name.localeCompare(b.name));
    cache = out; cacheAt = Date.now();
    return out;
  })().finally(() => { inflight = null; });
  return inflight;
}

async function find(id) {
  const op = (await operators()).find(o => o.id === id);
  if (!op) throw Object.assign(new Error('operator not found'), { status: 404 });
  return op;
}
const invalidate = () => { cache = null; };

module.exports = {
  ping, operators,
  async installPreset(input, dryRun) {
    const pl = catalog.plan(input, dryRun);
    let log = pl.skippedSecret ? '(dry run: the image pull secret is not created)\n\n' : '';
    for (const st of pl.steps) {
      log += `$ ${st.shown}\n`;
      try { log += (await run(st.args, { bin: st.bin, input: st.input, timeout: st.timeout })).trim() + '\n\n'; }
      catch (e) { e.message = `${log}ERROR: ${e.message}`; throw e; }
    }
    invalidate();
    return log.trim();
  },
  async uninstall(id) {
    const op = await find(id);
    if (!op.helm) throw bad('this operator was not installed with Helm');
    const [ns, rel] = op.helm.split('/');
    checkName(ns, 'namespace'); checkName(rel, 'release');
    const out = await run(['uninstall', rel, '-n', ns], { bin: 'helm', timeout: 120000 });
    invalidate();
    return `$ helm uninstall ${rel} -n ${ns}\n${out.trim()}\nCRDs and custom resources are left in place.`;
  },
  async install(planId, index, opts, dryRun) {
    const { c } = lookup(planId, index);
    const cmd = build(c, validateOpts(opts), dryRun);
    let log = '';
    if (c.kind === 'helm' && /^dependencies:/m.test(fs.readFileSync(path.join(c.path, 'Chart.yaml'), 'utf8'))) {
      const dep = ['dependency', 'build', c.path];
      log += `$ helm ${dep.join(' ')}\n${(await run(dep, { bin: 'helm', timeout: 120000 })).trim()}\n\n`;
    }
    const out = await run(cmd.args, { bin: cmd.bin, timeout: cmd.timeout });
    invalidate();
    return `${log}$ ${cmd.bin} ${cmd.args.join(' ')}\n${out.trim()}`;
  },
  async detail(id) {
    const op = await find(id);
    const deps = (await Promise.all(op.deployments.map(n => json(['get', 'deploy', n, '-n', op.namespace])))).filter(Boolean);
    const pods = (await Promise.all(deps.map(podsFor))).flat();
    const ev = await json(['get', 'events', '-n', op.namespace]).catch(() => ({ items: [] }));
    const events = ev.items
      .filter(e => op.deployments.some(n => (e.involvedObject.name || '').startsWith(n)))
      .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || 0) - new Date(a.lastTimestamp || a.eventTime || 0))
      .slice(0, 40)
      .map(e => ({ type: e.type, reason: e.reason, message: e.message, object: `${e.involvedObject.kind}/${e.involvedObject.name}`, time: e.lastTimestamp || e.eventTime, count: e.count }));
    const conditions = deps.flatMap(d => (d.status.conditions || []).map(c => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })));
    return { ...op, pods, events, conditions };
  },
  async logs(id, pod, tail) {
    const op = await find(id);
    checkName(pod, 'pod');
    if (!op.deployments.some(d => pod.startsWith(d + '-'))) throw bad('pod does not belong to this operator');
    return run(['logs', pod, '-n', op.namespace, '--all-containers', `--tail=${Math.min(Math.max(+tail || 200, 10), 2000)}`, '--timestamps']);
  },
  async yaml(q) {
    const op = await find(q.id);
    if (q.deployment) {
      if (!op.deployments.includes(q.deployment)) throw bad('unknown deployment');
      return run(['get', 'deploy', q.deployment, '-n', op.namespace, '-o', 'yaml']);
    }
    const c = op.crds.find(c => c.name === q.crd);
    if (!c) throw bad('unknown CRD');
    checkName(q.name, 'name');
    const a = ['get', `${c.plural}.${c.group}`, q.name, '-o', 'yaml'];
    if (c.scope === 'Namespaced') a.push('-n', checkName(q.ns, 'namespace'));
    return run(a);
  },
  async restart(id) {
    const op = await find(id);
    for (const d of op.deployments) await run(['rollout', 'restart', `deployment/${d}`, '-n', op.namespace]);
    invalidate();
    return `Restarting ${op.deployments.join(', ')}`;
  },
  async scale(id, n) {
    const op = await find(id);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw bad('replicas must be an integer 0-20');
    for (const d of op.deployments) await run(['scale', `deployment/${d}`, `--replicas=${n}`, '-n', op.namespace]);
    invalidate();
    return `Scaled to ${n}`;
  },
  async del(id, crd, name, ns) {
    const op = await find(id);
    const c = op.crds.find(c => c.name === crd);
    if (!c) throw bad('unknown CRD');
    checkName(name, 'name');
    const a = ['delete', `${c.plural}.${c.group}`, name, '--wait=false'];
    if (c.scope === 'Namespaced') a.push('-n', checkName(ns, 'namespace'));
    const r = await run(a); invalidate(); return r.trim();
  },
  async apply(id, yaml, dryRun) {
    const op = await find(id);
    if (typeof yaml !== 'string' || !yaml.trim() || yaml.length > 500000) throw bad('empty or oversized manifest');
    const kinds = [...yaml.matchAll(/^kind:\s*["']?([A-Za-z0-9]+)/gm)].map(m => m[1]);
    const allowed = new Set(op.crds.map(c => c.kind));
    if (!kinds.length || kinds.some(k => !allowed.has(k))) throw bad(`manifest may only contain this operator's kinds: ${[...allowed].join(', ')}`);
    const a = ['apply', '-f', '-']; if (dryRun) a.push('--dry-run=server');
    const r = await run(a, { input: yaml }); invalidate(); return r.trim();
  },
  async contexts() {
    const names = (await run(['config', 'get-contexts', '-o', 'name'])).split('\n').filter(Boolean);
    const current = contextOverride || (await run(['config', 'current-context']).catch(() => '')).trim();
    return { names, current };
  },
  async setContext(name) {
    const { names } = await this.contexts();
    if (!names.includes(name)) throw bad('unknown context');
    contextOverride = name; invalidate();
  },
};
