'use strict';
// Builds a starter manifest for a CRD from its OpenAPI schema: required fields
// filled with defaults/placeholders, optional fields listed in comments.

function node(schema, depth = 0) {
  if (!schema) return { t: 'val', v: 'CHANGE_ME' };
  if (schema.default !== undefined && typeof schema.default !== 'object') return { t: 'val', v: schema.default };
  if (schema.enum && schema.enum.length) return { t: 'val', v: schema.enum[0] };
  if (schema['x-kubernetes-int-or-string']) return { t: 'val', v: 1 };
  switch (schema.type) {
    case 'integer': case 'number': return { t: 'val', v: schema.minimum !== undefined ? schema.minimum : 1 };
    case 'boolean': return { t: 'val', v: false };
    case 'array': return depth > 6 ? { t: 'val', v: [] } : { t: 'arr', item: node(schema.items, depth + 1) };
    case 'object': {
      const props = schema.properties || {};
      const req = schema.required || [];
      if (depth > 7) return { t: 'obj', entries: [], optional: [] };
      return {
        t: 'obj',
        entries: req.filter(k => props[k]).map(k => [k, node(props[k], depth + 1)]),
        optional: Object.keys(props).filter(k => !req.includes(k)),
      };
    }
    default: return { t: 'val', v: 'CHANGE_ME' };
  }
}

// Sensible starting values for well-known kinds whose schemas mark nothing required.
// Only applied to MariaDB-group CRDs, and only for top-level spec fields the schema has.
const REF = { 'mariaDbRef.name': 'my-mariadb' };
const HINTS = {
  MariaDB: { 'rootPasswordSecretKeyRef.name': 'my-mariadb-root', 'rootPasswordSecretKeyRef.generate': true, 'rootPasswordSecretKeyRef.key': 'password', 'storage.size': '1Gi', replicas: 1, imagePullSecrets: [{ name: 'mariadb-enterprise' }] },
  Database: REF, MaxScale: REF,
  User: { ...REF, host: '%' },
  Grant: { ...REF, privileges: ['ALL PRIVILEGES'], database: '*', table: '*', username: 'my-user' },
  Backup: { ...REF, 'storage.persistentVolumeClaim.accessModes': ['ReadWriteOnce'], 'storage.persistentVolumeClaim.resources.requests.storage': '1Gi' },
  Connection: { ...REF, username: 'my-user', 'passwordSecretKeyRef.name': 'my-user-password', 'passwordSecretKeyRef.key': 'password', secretName: 'my-connection' },
};
function applyHints(specNode, specSchema, group, kind) {
  const hints = /mariadb\.com$/.test(group) && HINTS[kind];
  if (!hints || !specNode || specNode.t !== 'obj') return;
  const props = (specSchema && specSchema.properties) || {};
  for (const [path, value] of Object.entries(hints)) {
    const parts = path.split('.');
    if (!props[parts[0]]) continue;
    let cur = specNode;
    parts.forEach((k, i) => {
      cur.optional = cur.optional.filter(o => o !== k);
      let next = cur.entries.find(e => e[0] === k);
      if (i === parts.length - 1) { if (next) next[1] = { t: 'val', v: value }; else cur.entries.push([k, { t: 'val', v: value }]); return; }
      if (!next || next[1].t !== 'obj') { next = [k, { t: 'obj', entries: [], optional: [] }]; cur.entries = cur.entries.filter(e => e[0] !== k); cur.entries.push(next); }
      cur = next[1];
    });
  }
}

const fmt = v => (typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? JSON.stringify(v) : String(v));

function objLines(n, ind) {
  const pad = '  '.repeat(ind), out = [];
  for (const [k, c] of n.entries) out.push(...entryLines(k, c, ind));
  if (n.optional.length) out.push(`${pad}# optional: ${n.optional.slice(0, 14).join(', ')}${n.optional.length > 14 ? ', …' : ''}`);
  return out;
}
function entryLines(k, n, ind) {
  const pad = '  '.repeat(ind);
  if (n.t === 'val') return [`${pad}${k}: ${fmt(n.v)}`];
  if (n.t === 'obj') return n.entries.length ? [`${pad}${k}:`, ...objLines(n, ind + 1)] : [`${pad}${k}: {}` + (n.optional.length ? `   # optional: ${n.optional.slice(0, 14).join(', ')}${n.optional.length > 14 ? ', …' : ''}` : '')];
  const it = n.item;
  if (it.t === 'val') return [`${pad}${k}:`, `${pad}- ${fmt(it.v)}`];
  if (it.t === 'obj' && it.entries.length) {
    const lines = objLines(it, ind + 1);
    lines[0] = pad + '- ' + lines[0].slice((ind + 1) * 2);
    return [`${pad}${k}:`, ...lines];
  }
  return [`${pad}${k}:`, `${pad}- {}`];
}

function fromCrd(crd, namespace) {
  const spec = crd.spec;
  const ver = spec.versions.find(v => v.storage) || spec.versions[0];
  const root = (ver.schema && ver.schema.openAPIV3Schema) || {};
  const props = root.properties || {};
  const top = (root.required || []).filter(k => !['apiVersion', 'kind', 'metadata', 'status'].includes(k));
  const keys = [...new Set(['spec', ...top])].filter(k => props[k] || k === 'spec');
  const lines = [
    `apiVersion: ${spec.group}/${ver.name}`,
    `kind: ${spec.names.kind}`,
    'metadata:',
    `  name: my-${spec.names.kind.toLowerCase()}`,
    ...(spec.scope === 'Namespaced' ? [`  namespace: ${namespace || 'default'}`] : []),
  ];
  for (const k of keys) {
    const n = props[k] ? node(props[k]) : { t: 'obj', entries: [], optional: [] };
    if (k === 'spec') applyHints(n, props.spec, spec.group, spec.names.kind);
    lines.push(...entryLines(k, n, 0));
  }
  return lines.join('\n') + '\n';
}

// Fallback when no schema is available (demo mode).
function basic(c, namespace) {
  return [`apiVersion: ${c.group}/${c.storageVersion || c.versions[0]}`, `kind: ${c.kind}`, 'metadata:', `  name: my-${c.kind.toLowerCase()}`,
    ...(c.scope === 'Namespaced' ? [`  namespace: ${namespace || 'default'}`] : []), 'spec: {}', ''].join('\n');
}

module.exports = { fromCrd, basic };
