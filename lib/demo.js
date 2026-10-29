'use strict';
// Demo backend: in-memory fake cluster so the UI is explorable without one.
// Restart / scale / delete mutate this state so the actions feel real.

const { lookup, build, validateOpts } = require('./source');
const catalog = require('./catalog');
const template = require('./template');
const ago = m => new Date(Date.now() - m * 60000).toISOString();
const bad = msg => Object.assign(new Error(msg), { status: 400 });

function crd(group, kind, plural, scope, versions, instances) {
  return { name: `${plural}.${group}`, group, kind, plural, scope, versions, storageVersion: versions[0],
    instances: instances.map(([name, namespace, status, age = 600]) => ({ name, namespace: scope === 'Cluster' ? undefined : namespace, status, created: ago(age) })) };
}
function op(name, namespace, version, source, provider, description, replicas, image, crds, extra = {}) {
  const dep = `${name.toLowerCase().replace(/\s+/g, '-')}${extra.suffix ?? '-operator'}`;
  return { id: `${namespace}/${dep}`, name, namespace, version, source, provider, description, deployments: [dep],
    desired: replicas, ready: extra.ready ?? replicas, images: [image], crds, restarts: extra.restarts ?? 0, created: ago(extra.age ?? 40000),
    crash: !!extra.crash, progressing: false };
}

let state;
function seed() {
  state = [
    op('cert-manager', 'cert-manager', '1.15.3', 'olm', 'The cert-manager maintainers', 'Automatically provision and manage TLS certificates in Kubernetes.', 1, 'quay.io/jetstack/cert-manager-controller:v1.15.3', [
      crd('cert-manager.io', 'Certificate', 'certificates', 'Namespaced', ['v1'], [['api-tls', 'prod', 'Healthy', 9000], ['web-tls', 'prod', 'Healthy', 9000], ['grafana-tls', 'monitoring', 'Healthy', 5000], ['legacy-tls', 'staging', 'Degraded', 300]]),
      crd('cert-manager.io', 'Issuer', 'issuers', 'Namespaced', ['v1'], [['selfsigned', 'prod', 'Healthy', 20000]]),
      crd('cert-manager.io', 'ClusterIssuer', 'clusterissuers', 'Cluster', ['v1'], [['letsencrypt-prod', '', 'Healthy', 30000], ['letsencrypt-staging', '', 'Healthy', 30000]]),
      crd('cert-manager.io', 'CertificateRequest', 'certificaterequests', 'Namespaced', ['v1'], [['api-tls-1', 'prod', 'Healthy', 9000], ['legacy-tls-1', 'staging', 'Degraded', 300]]),
    ], { suffix: '' }),
    op('MariaDB', 'mariadb-system', '0.0.32', 'olm', 'MariaDB plc', 'Run and operate MariaDB and MaxScale clusters on Kubernetes.', 1, 'docker-registry3.mariadb.com/mariadb-operator/mariadb-operator:0.0.32', [
      crd('k8s.mariadb.com', 'MariaDB', 'mariadbs', 'Namespaced', ['v1alpha1'], [['mariadb-galera', 'db', 'Healthy', 12000], ['mariadb-repl', 'db', 'Healthy', 7000], ['dev-db', 'dev', 'Progressing', 4]]),
      crd('k8s.mariadb.com', 'MaxScale', 'maxscales', 'Namespaced', ['v1alpha1'], [['maxscale-galera', 'db', 'Healthy', 12000]]),
      crd('k8s.mariadb.com', 'Backup', 'backups', 'Namespaced', ['v1alpha1'], [['nightly', 'db', 'Healthy', 1400], ['pre-upgrade', 'db', 'Healthy', 900]]),
      crd('k8s.mariadb.com', 'User', 'users', 'Namespaced', ['v1alpha1'], [['app', 'db', 'Healthy', 12000], ['exporter', 'db', 'Healthy', 12000]]),
      crd('k8s.mariadb.com', 'Grant', 'grants', 'Namespaced', ['v1alpha1'], [['app-grant', 'db', 'Healthy', 12000]]),
    ], { suffix: '-operator' }),
    op('Prometheus Operator', 'monitoring', '0.76.0', 'inferred', undefined, undefined, 1, 'quay.io/prometheus-operator/prometheus-operator:v0.76.0', [
      crd('monitoring.coreos.com', 'Prometheus', 'prometheuses', 'Namespaced', ['v1'], [['k8s', 'monitoring', 'Healthy', 30000]]),
      crd('monitoring.coreos.com', 'Alertmanager', 'alertmanagers', 'Namespaced', ['v1'], [['main', 'monitoring', 'Healthy', 30000]]),
      crd('monitoring.coreos.com', 'ServiceMonitor', 'servicemonitors', 'Namespaced', ['v1'], Array.from({ length: 9 }, (_, i) => [`svc-${i + 1}`, 'monitoring', 'Healthy', 20000])),
      crd('monitoring.coreos.com', 'PrometheusRule', 'prometheusrules', 'Namespaced', ['v1'], [['node-rules', 'monitoring', 'Healthy', 30000], ['k8s-rules', 'monitoring', 'Healthy', 30000]]),
    ], { suffix: '-operator' }),
    op('Strimzi', 'kafka', '0.43.0', 'olm', 'Strimzi', 'Apache Kafka running on Kubernetes.', 2, 'quay.io/strimzi/operator:0.43.0', [
      crd('kafka.strimzi.io', 'Kafka', 'kafkas', 'Namespaced', ['v1beta2'], [['events', 'kafka', 'Degraded', 8000]]),
      crd('kafka.strimzi.io', 'KafkaTopic', 'kafkatopics', 'Namespaced', ['v1beta2'], [['orders', 'kafka', 'Healthy', 7000], ['payments', 'kafka', 'Healthy', 7000], ['audit', 'kafka', 'Unknown', 7000]]),
      crd('kafka.strimzi.io', 'KafkaUser', 'kafkausers', 'Namespaced', ['v1beta2'], [['svc-orders', 'kafka', 'Healthy', 7000]]),
    ], { suffix: '-cluster-operator', ready: 1, crash: true, restarts: 14 }),
    op('Argo CD', 'argocd', '0.11.0', 'olm', 'Argo CD Community', 'Declarative GitOps continuous delivery.', 1, 'quay.io/argoprojlabs/argocd-operator:v0.11.0', [
      crd('argoproj.io', 'ArgoCD', 'argocds', 'Namespaced', ['v1beta1'], [['argocd', 'argocd', 'Healthy', 20000]]),
      crd('argoproj.io', 'Application', 'applications', 'Namespaced', ['v1alpha1'], [['guestbook', 'argocd', 'Healthy', 5000], ['payments', 'argocd', 'Progressing', 20], ['search', 'argocd', 'Healthy', 5000]]),
    ], { suffix: '-operator', age: 20000 }),
    op('CloudNativePG', 'cnpg-system', '1.24.0', 'inferred', undefined, undefined, 0, 'ghcr.io/cloudnative-pg/cloudnative-pg:1.24.0', [
      crd('postgresql.cnpg.io', 'Cluster', 'clusters', 'Namespaced', ['v1'], [['pg-main', 'db', 'Unknown', 3000]]),
      crd('postgresql.cnpg.io', 'Backup', 'backups', 'Namespaced', ['v1'], []),
    ], { suffix: '-controller-manager', age: 3000 }),
  ];
}
seed();

const statusOf = o => o.desired === 0 ? 'Paused' : o.crash ? 'Degraded' : o.progressing || o.ready < o.desired ? 'Progressing' : 'Healthy';
const rid = n => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const view = o => ({ ...o, status: statusOf(o), instanceCount: o.crds.reduce((n, c) => n + c.instances.length, 0),
  crds: o.crds.map(c => ({ ...c })), crash: undefined, progressing: undefined });
const get = id => { const o = state.find(o => o.id === id); if (!o) throw Object.assign(new Error('operator not found'), { status: 404 }); return o; };

function podsOf(o) {
  const dep = o.deployments[0];
  const hash = rid(9);
  const managed = o.crds.flatMap(c => c.instances.slice(0, 3).map(i => {
    const bad = i.status && i.status !== 'Healthy';
    return { name: `${i.name}-0`, namespace: i.namespace || o.namespace, role: 'managed', owner: `${c.kind}/${i.name}`, phase: bad ? 'Pending' : 'Running', ready: !bad,
      restarts: 0, node: 'worker-2', created: i.created || ago(600), reason: bad ? 'ImagePullBackOff' : undefined, containers: ['main'] };
  }));
  return Array.from({ length: o.desired }, (_, i) => {
    const crashing = o.crash && i === o.desired - 1;
    return { namespace: o.namespace, role: 'operator', name: `${dep}-${hash}-${rid(5)}`, phase: crashing ? 'Running' : o.progressing ? 'Pending' : 'Running', ready: !crashing && !o.progressing,
      restarts: crashing ? o.restarts : 0, node: `worker-${(i % 3) + 1}`, created: o.progressing ? ago(0.1) : ago(Math.min(o.age || 2000, 2000)),
      reason: crashing ? 'CrashLoopBackOff' : undefined, containers: ['manager'] };
  }).concat(managed);
}

function toYaml(v, ind = 0) {
  const pad = '  '.repeat(ind);
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x ? `${pad}- ${toYaml(x, ind + 1).trimStart()}` : `${pad}- ${x}`)).join('\n');
  return Object.entries(v).map(([k, x]) => {
    if (x && typeof x === 'object') return `${pad}${k}:\n${toYaml(x, ind + 1)}`;
    return `${pad}${k}: ${typeof x === 'string' && /[:#{}\[\]]/.test(x) ? JSON.stringify(x) : x}`;
  }).join('\n');
}

module.exports = {
  reset: seed,
  async installPreset(input, dryRun) {
    const pl = catalog.plan(input, dryRun);
    const text = pl.steps.map(st => `$ ${st.shown}`).join('\n\n') + '\n\n(demo mode: nothing was executed)';
    if (!dryRun && !state.some(o => o.helm === `${pl.ns}/${pl.release}`)) {
      const o = op(pl.preset.name, pl.ns, '25.10.1', 'inferred', 'MariaDB plc', undefined, 1, 'docker.mariadb.com/mariadb-enterprise-operator:25.10.1', [
        crd('k8s.mariadb.com', 'MariaDB', 'mariadbs', 'Namespaced', ['v1alpha1'], []),
        crd('k8s.mariadb.com', 'MaxScale', 'maxscales', 'Namespaced', ['v1alpha1'], []),
        crd('k8s.mariadb.com', 'Backup', 'backups', 'Namespaced', ['v1alpha1'], []),
      ], { age: 1 });
      o.id = `${pl.ns}/${pl.release}`; o.deployments = [pl.release]; o.helm = o.id; o.progressing = true;
      state.push(o); setTimeout(() => { o.progressing = false; }, 4000);
    }
    return text;
  },
  async uninstall(id) {
    const o = get(id);
    if (!o.helm) throw bad('this operator was not installed with Helm');
    state = state.filter(x => x !== o);
    return `$ helm uninstall ${o.helm.split('/')[1]} -n ${o.helm.split('/')[0]}\n(demo mode) CRDs and custom resources are left in place.`;
  },
  async install(planId, index, opts, dryRun) {
    const { p, c } = lookup(planId, index);
    const cmd = build(c, validateOpts(opts), dryRun);
    const text = `$ ${cmd.bin} ${cmd.args.join(' ')}\n(demo mode: nothing was executed)`;
    if (!dryRun && !state.some(o => o.name === p.name)) {
      const ns = (opts && opts.namespace) || p.name;
      state.push(op(p.name, ns, undefined, 'inferred', undefined, undefined, 1, `example.com/${p.name}:latest`, [], { suffix: '-operator', age: 1 }));
      state[state.length - 1].progressing = true;
      const o = state[state.length - 1]; setTimeout(() => { o.progressing = false; }, 4000);
    }
    return text;
  },
  async operators() { return state.map(view); },
  async detail(id) {
    const o = get(id), v = view(o);
    const bits = [['Normal', 'Pulled', `Container image "${o.images[0]}" already present on machine`], ['Normal', 'Created', 'Created container manager'], ['Normal', 'Started', 'Started container manager']];
    const events = bits.map(([type, reason, message], i) => ({ type, reason, message, object: `Pod/${o.deployments[0]}`, time: ago(i + 1) }));
    if (o.crash) events.unshift({ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container manager in pod', object: `Pod/${o.deployments[0]}`, time: ago(0.5), count: 212 });
    return { ...v, pods: podsOf(o), events,
      conditions: [{ type: 'Available', status: v.status === 'Healthy' ? 'True' : 'False', reason: 'MinimumReplicasAvailable' }, { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }] };
  },
  async logs(id, pod) {
    const o = get(id);
    if (!o.deployments.some(d => String(pod).startsWith(d + '-')) && !podsOf(o).some(p => p.name === pod)) throw bad('pod does not belong to this operator');
    const lines = [];
    for (let i = 12; i > 0; i--) {
      const t = new Date(Date.now() - i * 15000).toISOString();
      lines.push(`${t} INFO  controller.reconcile  Reconciling ${o.crds[0].kind}  {"name":"${(o.crds[0].instances[0] || {}).name || 'x'}"}`);
      if (o.crash && i % 4 === 0) lines.push(`${t} ERROR controller.reconcile  failed to reach quorum: 1/3 brokers ready`);
    }
    if (o.crash) lines.push(`${new Date().toISOString()} FATAL manager  panic: timed out waiting for cache sync`);
    return lines.join('\n');
  },
  async yaml(q) {
    const o = get(q.id);
    if (q.deployment) return toYaml({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: q.deployment, namespace: o.namespace },
      spec: { replicas: o.desired, template: { spec: { containers: [{ name: 'manager', image: o.images[0] }] } } } });
    const c = o.crds.find(c => c.name === q.crd); if (!c) throw bad('unknown CRD');
    const i = c.instances.find(i => i.name === q.name && i.namespace === (q.ns || undefined)); if (!i) throw bad('not found');
    return toYaml({ apiVersion: `${c.group}/${c.storageVersion}`, kind: c.kind, metadata: { name: i.name, ...(i.namespace ? { namespace: i.namespace } : {}), creationTimestamp: i.created },
      spec: { replicas: 3, version: 'latest' }, status: { phase: i.status } });
  },
  async restart(id) {
    const o = get(id); o.progressing = true; o.crash = false; o.restarts = 0;
    setTimeout(() => { o.progressing = false; o.ready = o.desired; }, 4000);
    return `Restarting ${o.deployments[0]}`;
  },
  async scale(id, n) {
    const o = get(id);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw bad('replicas must be an integer 0-20');
    o.desired = n; o.ready = n; if (n === 0) o.crash = false;
    return `Scaled to ${n}`;
  },
  async del(id, crd, name, ns) {
    const o = get(id), c = o.crds.find(c => c.name === crd); if (!c) throw bad('unknown CRD');
    const n = c.instances.length;
    c.instances = c.instances.filter(i => !(i.name === name && i.namespace === (ns || undefined)));
    if (c.instances.length === n) throw bad('not found');
    return `${c.plural}.${c.group} "${name}" deleted`;
  },
  async template(id, crd, ns) {
    const c = get(id).crds.find(c => c.name === crd); if (!c) throw bad('unknown CRD');
    return template.basic(c, ns);
  },
  async apply(id, yaml, dryRun, create) {
    const o = get(id);
    const kinds = [...String(yaml).matchAll(/^kind:\s*["']?([A-Za-z0-9]+)/gm)].map(m => m[1]);
    const allowed = new Set(o.crds.map(c => c.kind));
    if (!kinds.length || kinds.some(k => !allowed.has(k))) throw bad(`manifest may only contain this operator's kinds: ${[...allowed].join(', ')}`);
    if (create && !dryRun) {
      const kind = kinds[0], c = o.crds.find(c => c.kind === kind);
      const name = (/^metadata:\s*\n\s+name:\s*(\S+)/m.exec(yaml) || [])[1], ns = (/^\s+namespace:\s*(\S+)/m.exec(yaml) || [])[1];
      if (!name) throw bad('metadata.name is required');
      if (c.instances.some(i => i.name === name && i.namespace === (ns || undefined))) throw bad(`${c.plural}.${c.group} "${name}" already exists`);
      c.instances.push({ name, namespace: c.scope === 'Cluster' ? undefined : ns || 'default', status: 'Progressing', created: ago(0) });
      setTimeout(() => { const i = c.instances.find(i => i.name === name); if (i) i.status = 'Healthy'; }, 4000);
      return `${c.plural}.${c.group}/${name} created (demo mode)`;
    }
    return `${kinds.join(', ')} configured${dryRun ? ' (server dry run)' : ''} (demo mode: change not persisted)`;
  },
  async kubectl() { throw bad('The kubectl console needs a live cluster. Demo mode has none.'); },
  async contexts() { return { names: ['demo'], current: 'demo' }; },
  async setContext() {},
};
