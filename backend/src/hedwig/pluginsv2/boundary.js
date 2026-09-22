// Install-time boundary check for external (tier-2) plugins, shared by the loader and the CLI.
//
// Node cannot isolate code running in the same process: a plugin could import `node:fs`, read
// process.env or call the global fetch. What this check does is make those reaches visible and
// refuse them before an admin's install lands: backend files may import only files inside their
// own directory and a small allowlist of harmless built-ins, and a list of escape hatches
// (process, global fetch, eval, dynamic import of a computed name, …) is rejected outright. It is
// a static filter, not a sandbox; see docs/hedwig/PLUGINS.md "Security model".
import { createHash } from 'crypto';
import { readdir, readFile, stat, realpath } from 'fs/promises';
import { join, relative, resolve, dirname, sep, extname } from 'path';

export const SAFE_BUILTINS = new Set(['assert', 'buffer', 'crypto', 'events', 'path', 'querystring', 'string_decoder', 'url', 'util', 'timers', 'timers/promises']);

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[\w*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// Reaches around the facade that a static check can catch. Each is [regex, explanation].
const FORBIDDEN = [
  [/\bimport\s*\(\s*[^'"\s)]/, 'dynamic import() of a computed specifier'],
  [/\brequire\s*\(/, 'require() (plugins are ES modules; import siblings instead)'],
  [/(?<![.\w$])process\s*[.[]/, 'process.* (environment, exit, bindings)'],
  [/\bglobalThis\b|(?<![.\w$])global\s*[.[]/, 'globalThis / global'],
  [/(?<![.\w])fetch\s*\(/, 'the global fetch (use hedwig.net.fetch)'],
  [/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, 'raw network APIs (use hedwig.net.fetch)'],
  [/\beval\s*\(|\bnew\s+Function\s*\(|(?<![.\w])Function\s*\(/, 'eval / Function constructor'],
  [/\bimport\.meta\.(?:resolve|dirname|filename)\b/, 'import.meta.resolve/dirname/filename'],
  [/\b__proto__\b|\bconstructor\s*\.\s*constructor\b/, 'prototype escapes'],
];

const SKIP_DIRS = new Set(['.git', 'node_modules']);

async function walk(dir, root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push({ path: full, rel: relative(root, full), symlink: true });
      continue;
    }
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.isFile()) out.push({ path: full, rel: relative(root, full) });
  }
  return out;
}

/** Every file in the plugin directory (sorted, relative), skipping .git and node_modules. */
export async function listPluginFiles(dir) {
  const files = await walk(dir, dir);
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function stripComments(src) {
  // Good enough for a static filter: drops block and line comments outside obvious strings.
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

export function importsOf(src) {
  const code = stripComments(src);
  const out = new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) out.add(m[1]);
  }
  return [...out];
}

/**
 * Check one backend source file. Returns a list of problems (empty when clean).
 * @param {string} src file contents
 * @param {string} fileAbs absolute path of the file
 * @param {string} rootAbs absolute plugin directory
 */
export function checkSource(src, fileAbs, rootAbs, rel = relative(rootAbs, fileAbs)) {
  const problems = [];
  for (const spec of importsOf(src)) {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = resolve(dirname(fileAbs), spec);
      if (target !== rootAbs && !target.startsWith(rootAbs + sep)) problems.push(`${rel}: imports "${spec}", which is outside the plugin directory`);
      continue;
    }
    const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
    if (SAFE_BUILTINS.has(bare)) continue;
    if (spec.startsWith('node:') || isBuiltin(bare)) problems.push(`${rel}: imports built-in "${spec}", which is not allowed (allowed: ${[...SAFE_BUILTINS].join(', ')}); use the hedwig facade`);
    else problems.push(`${rel}: imports package "${spec}"; plugins may only import their own files (bundle dependencies into the plugin)`);
  }
  const code = stripComments(src);
  for (const [re, what] of FORBIDDEN) if (re.test(code)) problems.push(`${rel}: uses ${what}`);
  return problems;
}

const NODE_BUILTINS = new Set(['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite', 'test']);
function isBuiltin(name) {
  return NODE_BUILTINS.has(name.split('/')[0]);
}

const BACKEND_EXT = new Set(['.js', '.mjs', '.cjs']);

/**
 * Check a plugin directory: no symlinks, no native addons, every backend source file within the
 * boundary. The frontend bundle is excluded (it runs in the browser, not in the server process).
 * @returns {Promise<string[]>} problems
 */
export async function checkPluginDir(dir, manifest) {
  const root = await realpath(dir);
  const problems = [];
  const frontend = manifest?.frontend ? resolve(root, manifest.frontend) : null;
  const files = await listPluginFiles(root);
  for (const f of files) {
    if (f.symlink) { problems.push(`${f.rel}: symbolic links are not allowed inside a plugin`); continue; }
    const ext = extname(f.path);
    if (ext === '.node') { problems.push(`${f.rel}: native addons are not allowed`); continue; }
    if (!BACKEND_EXT.has(ext) || f.path === frontend) continue;
    const info = await stat(f.path);
    if (info.size > 2 * 1024 * 1024) { problems.push(`${f.rel}: larger than 2 MB`); continue; }
    problems.push(...checkSource(await readFile(f.path, 'utf8'), f.path, root, f.rel));
  }
  if (manifest?.backend) {
    const entry = resolve(root, manifest.backend);
    if (!entry.startsWith(root + sep)) problems.push('backend entry is outside the plugin directory');
    else if (!files.some((f) => f.path === entry)) problems.push(`backend entry ${manifest.backend} does not exist`);
  }
  if (manifest?.frontend && !files.some((f) => f.path === frontend)) problems.push(`frontend bundle ${manifest.frontend} does not exist`);
  return problems;
}

/**
 * sha256 over every file in the plugin directory (relative path + contents, sorted), skipping .git
 * and node_modules. This is what an install pins and every later load re-checks.
 */
export async function hashPluginDir(dir) {
  const h = createHash('sha256');
  for (const f of await listPluginFiles(dir)) {
    if (f.symlink) continue;
    h.update(`${f.rel.split(sep).join('/')}\0`);
    h.update(await readFile(f.path));
    h.update('\0');
  }
  return h.digest('hex');
}
