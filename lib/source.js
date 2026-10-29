'use strict';
// Turns a GitHub URL or local folder into installable candidates (Helm chart,
// bundled manifest, kustomize, plain manifests) and builds the install command.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const bad = msg => Object.assign(new Error(msg), { status: 400 });

// Run a binary with an argument array (never a shell).
function exec(bin, args, { input, timeout = 20000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', d => (out += d));
    p.stderr.setEncoding('utf8').on('data', d => (err += d));
    const t = setTimeout(() => p.kill(), timeout);
    p.on('error', e => {
      clearTimeout(t);
      reject(e.code === 'ENOENT' ? Object.assign(new Error(`${bin} not found in PATH`), { status: 400 }) : e);
    });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out || err);
      else reject(Object.assign(new Error(err.trim().split('\n').slice(-3).join('\n') || `${bin} exited with ${code}`), { code, stdout: out, stderr: err }));
    });
    p.stdin.end(input ?? '');
  });
}

const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.\-]+)(?:\/([\w.\-/]+))?)?\/?$/;
const plans = new Map();

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { return []; } };
const yamls = d => { try { return fs.readdirSync(d).filter(f => /\.ya?ml$/.test(f) && f !== 'kustomization.yaml'); } catch { return []; } };

function detect(root) {
  const out = [];
  const rel = p => path.relative(root, p) || '.';
  // Helm charts: root, or one level under common chart folders
  const chartDirs = [root, ...['charts', 'chart', 'helm', 'deploy/charts', 'deploy/helm'].flatMap(g => {
    const base = path.join(root, g);
    return [base, ...subdirs(base).map(s => path.join(base, s))];
  })];
  for (const d of chartDirs) if (isFile(path.join(d, 'Chart.yaml'))) out.push({ kind: 'helm', path: d, label: `Helm chart (${rel(d)})` });
  for (const f of ['dist/install.yaml', 'install.yaml', 'deploy/install.yaml', 'manifests/install.yaml', 'deploy/operator.yaml'])
    if (isFile(path.join(root, f))) out.push({ kind: 'manifest', path: path.join(root, f), label: `Bundled manifest (${f})` });
  for (const d of ['config/default', 'deploy', '.'])
    if (isFile(path.join(root, d, 'kustomization.yaml'))) out.push({ kind: 'kustomize', path: path.join(root, d), label: `Kustomize (${d})` });
  for (const d of ['deploy', 'manifests', 'config/manager'])
    if (yamls(path.join(root, d)).length && !isFile(path.join(root, d, 'kustomization.yaml')) && !out.some(c => c.kind === 'manifest' && path.dirname(c.path) === path.join(root, d)))
      out.push({ kind: 'dir', path: path.join(root, d), label: `Manifest directory (${d}/, ${yamls(path.join(root, d)).length} files)` });
  return out;
}

function describe(c, release, ns) {
  const cmd = build(c, { release, namespace: ns }, false);
  return `${cmd.bin} ${cmd.args.join(' ')}`;
}

function build(c, { release, namespace } = {}, dryRun) {
  const rel = release || path.basename(c.kind === 'helm' ? c.path : (c.root || c.path)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'operator';
  const ns = namespace || rel;
  switch (c.kind) {
    case 'helm': return { bin: 'helm', args: ['upgrade', '--install', rel, c.path, '--namespace', ns, '--create-namespace', ...(dryRun ? ['--dry-run=client'] : [])], timeout: 180000 };
    case 'kustomize': return { bin: 'kubectl', args: ['apply', '--server-side', '-k', c.path, ...(dryRun ? ['--dry-run=server'] : [])], timeout: 120000 };
    default: return { bin: 'kubectl', args: ['apply', '--server-side', '-f', c.path, ...(dryRun ? ['--dry-run=server'] : [])], timeout: 120000 };
  }
}

const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
function validateOpts({ release, namespace } = {}) {
  for (const [v, w] of [[release, 'release name'], [namespace, 'namespace']]) if (v && (!NAME.test(v) || v.length > 53)) throw bad(`invalid ${w}`);
  return { release: release || undefined, namespace: namespace || undefined };
}

async function resolve(source) {
  source = String(source || '').trim();
  if (!source) throw bad('enter a GitHub URL or a local folder');
  let dir, name, origin, temp = null;
  const m = GH.exec(source);
  if (m) {
    const [, owner, repo, branch, sub] = m;
    if (sub && sub.split('/').includes('..')) throw bad('invalid path');
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'k8oui-'));
    try {
      await exec('git', ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), '--', `https://github.com/${owner}/${repo}.git`, temp], { timeout: 90000 });
    } catch (e) { fs.rmSync(temp, { recursive: true, force: true }); throw bad(`git clone failed: ${e.message}`); }
    dir = sub ? path.join(temp, sub) : temp;
    if (!dir.startsWith(temp) || !isDir(dir)) { fs.rmSync(temp, { recursive: true, force: true }); throw bad('path not found in repository'); }
    name = sub ? path.basename(sub) : repo; origin = `github.com/${owner}/${repo}${branch ? '@' + branch : ''}`;
  } else if (/^https?:\/\/|^git@/.test(source)) {
    throw bad('only https://github.com/<owner>/<repo>[/tree/<branch>/<path>] URLs are supported');
  } else {
    dir = path.resolve(source.replace(/^~(?=$|\/)/, os.homedir()));
    if (!isDir(dir)) throw bad(`not a directory: ${dir}`);
    name = path.basename(dir); origin = dir;
  }
  const score = c => (c.kind === 'helm' ? (/operator/.test(c.path) ? 0 : 1) + (/crds?$|cluster$/.test(c.path) ? 2 : 0) : 5);
  const candidates = detect(dir).map(c => ({ ...c, root: dir })).sort((a, b) => score(a) - score(b));
  const id = crypto.randomBytes(8).toString('hex');
  plans.set(id, { dir, temp, candidates, name });
  const t = setTimeout(() => { plans.delete(id); if (temp) fs.rmSync(temp, { recursive: true, force: true }); }, 30 * 60000); t.unref();
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const hasHelm = await exec('helm', ['version', '--short'], { timeout: 5000 }).then(() => true, () => false);
  const cands = candidates.map((c, i) => ({ index: i, kind: c.kind, label: c.label, command: describe(c, null, null), unavailable: c.kind === 'helm' && !hasHelm ? 'helm is not installed (brew install helm)' : undefined }));
  return {
    id, name, origin, defaultRelease: slug,
    candidates: cands,
    warnings: candidates.length ? [] : ['No Helm chart, kustomization or manifest found. Looked for Chart.yaml, install.yaml, config/default, deploy/ and manifests/.'],
  };
}

function lookup(id, index) {
  const p = plans.get(id);
  if (!p) throw bad('plan expired; inspect the source again');
  const c = p.candidates[index];
  if (!c) throw bad('unknown install method');
  return { p, c };
}

module.exports = { exec, resolve, lookup, build, validateOpts };
