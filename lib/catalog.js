'use strict';
// Curated operators that need more than "apply this folder": a Helm repo, a
// separate CRDs chart, and (for enterprise images) a registry pull secret.
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const VERSION = /^[0-9A-Za-z*][0-9A-Za-z.*+~^<>=, -]{0,39}$/;

const PRESETS = {
  'mariadb-enterprise': {
    id: 'mariadb-enterprise',
    name: 'MariaDB Enterprise Operator',
    description: 'Run MariaDB Enterprise Server and MaxScale on Kubernetes. Installs the CRDs chart, then the operator, from the official Helm repository.',
    docs: 'https://mariadb.com/docs/tools/enterprise/mariadb-enterprise-operator/installation/helm',
    repo: { name: 'mariadb-enterprise-operator', url: 'https://operator.mariadb.com' },
    crdsChart: 'mariadb-enterprise-operator-crds',
    chart: 'mariadb-enterprise-operator',
    release: 'mariadb-enterprise-operator',
    defaultNamespace: 'mariadb-enterprise-operator',
    registry: { server: 'docker.mariadb.com', secretName: 'mariadb-enterprise' },
    options: [
      { key: 'currentNamespaceOnly', label: 'Only watch the operator’s own namespace', set: 'currentNamespaceOnly=true' },
      { key: 'metrics', label: 'Enable Prometheus metrics (requires Prometheus Operator)', set: 'metrics.enabled=true' },
      { key: 'certManager', label: 'Use cert-manager for webhook certificates (requires cert-manager)', set: 'webhook.cert.certManager.enabled=true' },
    ],
  },
};

const list = () => Object.values(PRESETS).map(({ id, name, description, docs, defaultNamespace, registry, options }) =>
  ({ id, name, description, docs, defaultNamespace, registry, options: options.map(({ key, label }) => ({ key, label })) }));

function validate(input) {
  const p = PRESETS[input.preset];
  if (!p) throw bad('unknown catalog entry');
  const ns = input.namespace || p.defaultNamespace;
  const secretName = input.secretName || p.registry.secretName;
  for (const [v, w] of [[ns, 'namespace'], [secretName, 'secret name']]) if (!NAME.test(v) || v.length > 63) throw bad(`invalid ${w}`);
  if (input.version && !VERSION.test(input.version)) throw bad('invalid chart version');
  const createSecret = !!input.createSecret;
  if (createSecret) {
    for (const [v, w] of [[input.username, 'username'], [input.password, 'password']])
      if (typeof v !== 'string' || !v || v.length > 512 || /[\u0000-\u001f]/.test(v)) throw bad(`${w} is required`);
  }
  return { p, ns, secretName, createSecret, version: input.version || null, options: p.options.filter(o => input.options && input.options[o.key]) };
}

// Ordered steps. `shown` is what the UI/logs display; it never contains credentials.
function plan(input, dryRun) {
  const { p, ns, secretName, createSecret, version, options } = validate(input);
  const steps = [];
  const ver = version ? ['--version', version] : [];
  const dry = dryRun ? ['--dry-run=client'] : [];
  if (createSecret && !dryRun) {
    const auth = Buffer.from(`${input.username}:${input.password}`).toString('base64');
    const cfg = { auths: { [p.registry.server]: { username: input.username, password: input.password, auth } } };
    const manifest = { apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns } },
      { apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/dockerconfigjson', metadata: { name: secretName, namespace: ns },
        data: { '.dockerconfigjson': Buffer.from(JSON.stringify(cfg)).toString('base64') } },
    ] };
    steps.push({ bin: 'kubectl', args: ['apply', '-f', '-'], input: JSON.stringify(manifest), timeout: 30000,
      shown: `kubectl apply -f -   # Namespace ${ns} + docker-registry Secret ${secretName} for ${p.registry.server} (credentials not shown)` });
  }
  const add = ['repo', 'add', p.repo.name, p.repo.url, '--force-update'];
  steps.push({ bin: 'helm', args: add, timeout: 60000, shown: `helm ${add.join(' ')}` });
  const crds = ['upgrade', '--install', `${p.release}-crds`, `${p.repo.name}/${p.crdsChart}`, '-n', ns, '--create-namespace', ...ver, ...dry];
  steps.push({ bin: 'helm', args: crds, timeout: 180000, shown: `helm ${crds.join(' ')}` });
  const values = [`imagePullSecrets:\n  - name: ${secretName}`, `webhook:\n  imagePullSecrets:\n    - name: ${secretName}`, `certController:\n  imagePullSecrets:\n    - name: ${secretName}`].join('\n') + '\n';
  const op = ['upgrade', '--install', p.release, `${p.repo.name}/${p.chart}`, '-n', ns, '--create-namespace', '-f', '-', ...options.flatMap(o => ['--set', o.set]), ...ver, ...dry];
  steps.push({ bin: 'helm', args: op, input: values, timeout: 180000, shown: `helm ${op.join(' ')}   # values: imagePullSecrets → ${secretName}` });
  return { steps, ns, release: p.release, preset: p, dryRun: !!dryRun, skippedSecret: createSecret && dryRun };
}

module.exports = { list, plan };
