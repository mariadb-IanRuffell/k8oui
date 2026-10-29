'use strict';
// Parses and vets a user-typed kubectl command for the console. No shell is ever
// involved (the result is an argv array), the verb must be on a fixed list, and
// flags that redirect credentials, escalate identity or never terminate are refused.
const bad = msg => Object.assign(new Error(msg), { status: 400 });

const READ = new Set(['get', 'describe', 'logs', 'top', 'events', 'api-resources', 'api-versions', 'explain', 'version', 'cluster-info', 'diff', 'wait']);
const WRITE = new Set(['apply', 'create', 'delete', 'patch', 'scale', 'label', 'annotate', 'set', 'replace', 'taint', 'cordon', 'uncordon', 'drain', 'expose', 'autoscale', 'rollout']);
const BLOCKED = /^--(kubeconfig|server|token|username|password|client-key|client-certificate|certificate-authority|insecure-skip-tls-verify|tls-server-name|as|as-group|as-uid|raw|context|cluster|user|proxy-url|cache-dir|watch|watch-only|follow|output-watch-events|profile|profile-output|log-file|log-dir)(=|$)/;

function tokenize(s) {
  const out = []; let cur = '', q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += c;
  }
  if (q) throw bad('unterminated quote');
  if (cur || has) out.push(cur);
  return out;
}

function parse(command) {
  if (typeof command !== 'string' || !command.trim()) throw bad('enter a kubectl command');
  if (command.length > 20000) throw bad('command too long');
  let args = tokenize(command.trim());
  if (args[0] === 'kubectl') args.shift();
  const verb = args[0];
  if (!verb || verb.startsWith('-')) throw bad('start with a kubectl verb, for example: get pods -A');
  if (args.some(a => /^(\||>|>>|&&|;|\|\|)$/.test(a))) throw bad('pipes and redirects are not supported: there is no shell, run a single kubectl command');
  let write = WRITE.has(verb);
  if (verb === 'auth') { if (!['can-i', 'whoami'].includes(args[1])) throw bad('only `auth can-i` and `auth whoami` are allowed'); }
  else if (verb === 'config') { if (!['get-contexts', 'current-context'].includes(args[1])) throw bad('only `config get-contexts` and `config current-context` are allowed'); }
  else if (!READ.has(verb) && !write) throw bad(`\`${verb}\` is not available here. Allowed: ${[...READ, ...WRITE].sort().join(', ')}, auth can-i, config get-contexts`);
  if (verb === 'rollout' && ['status', 'history'].includes(args[1])) write = false;
  for (const a of args.slice(1)) {
    if (a === '--') break;
    if (BLOCKED.test(a) || (/^-[sw]/.test(a) && !a.startsWith('--')) || (verb === 'logs' && a === '-f')) throw bad(`flag ${a.split('=')[0]} is not allowed here`);
  }
  return { args, write };
}

module.exports = { parse };
