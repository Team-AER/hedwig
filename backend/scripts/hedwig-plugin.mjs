#!/usr/bin/env node
// Hedwig plugin author tool.
//
//   npm run plugin -- new <id> [--dir <parent>]        scaffold a plugin from the hello-hedwig example
//   npm run plugin -- validate <dir>                   manifest + install-time boundary check
//   npm run plugin -- pack <dir> [--out <file>]        tar.gz + sha256 (what an admin pins)
//   npm run plugin -- dev <dir> [--plugins-dir <dir>]  symlink into a plugins dir for local testing
//
// validate runs exactly the checks the server runs before it loads an external plugin, so a plugin
// that passes here installs; one that fails here is refused by the server with the same message.
import { readFile, writeFile, mkdir, cp, stat, symlink, lstat, readdir, realpath } from 'fs/promises';
import { createWriteStream } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { validateManifest, ID_RE } from '../src/hedwig/pluginsv2/manifest.js';
import { checkPluginDir, hashPluginDir, listPluginFiles } from '../src/hedwig/pluginsv2/boundary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, '../../examples/plugins/hello-hedwig');

function usage(code = 1) {
  console.log(`Usage:
  hedwig-plugin new <id> [--dir <parent>]
  hedwig-plugin validate <dir>
  hedwig-plugin pack <dir> [--out <file.tgz>]
  hedwig-plugin dev <dir> [--plugins-dir <dir>]   (default: $HEDWIG_PLUGINS_DIR or /plugins)`);
  process.exit(code);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) { console.error(`${name} needs a value`); process.exit(1); }
  args.splice(i, 2);
  return v;
}

async function readManifest(dir) {
  const raw = JSON.parse(await readFile(join(dir, 'hedwig.plugin.json'), 'utf8'));
  return validateManifest(raw, { tier: 2, source: join(dir, 'hedwig.plugin.json') });
}

/** Validate a plugin dir; prints problems and returns the manifest, or null when invalid. */
async function validate(dir, { quiet = false } = {}) {
  let manifest;
  try {
    manifest = await readManifest(dir);
  } catch (err) {
    console.error(`✗ ${err.errors ? `manifest has ${err.errors.length} problem(s):\n  - ${err.errors.join('\n  - ')}` : err.message}`);
    return null;
  }
  if (basename(await realpath(dir)) !== manifest.id) {
    console.warn(`! the directory is named "${basename(dir)}"; the server requires plugins.dir/<id>, i.e. "${manifest.id}" (pack and dev do this for you)`);
  }
  const problems = await checkPluginDir(dir, manifest);
  if (problems.length) {
    console.error(`✗ boundary check failed:\n  - ${problems.join('\n  - ')}`);
    return null;
  }
  if (!quiet) {
    console.log(`✓ ${manifest.id} ${manifest.version} (${manifest.name})`);
    console.log(`  permissions: ${manifest.permissions.map((p) => p.name + (p.optional ? '?' : '')).join(', ') || 'none'}`);
    if (manifest.hooks.length) console.log(`  hooks: ${manifest.hooks.join(', ')}`);
    if (manifest.net.length) console.log(`  network: ${manifest.net.join(', ')}`);
    console.log(`  sha256: ${await hashPluginDir(dir)}`);
  }
  return manifest;
}

async function cmdNew(args) {
  const parent = flag(args, '--dir') || process.cwd();
  const id = args[0];
  if (!id || !ID_RE.test(id)) { console.error(`id must match ${ID_RE}, e.g. "acme.weather"`); process.exit(1); }
  const target = resolve(parent, id);
  if (await stat(target).catch(() => null)) { console.error(`${target} already exists`); process.exit(1); }
  await mkdir(dirname(target), { recursive: true });
  await cp(TEMPLATE, target, { recursive: true });
  const name = id.split('.').pop().split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  for (const f of await listPluginFiles(target)) {
    if (!/\.(json|js|mjs)$/.test(f.path)) continue;
    const src = await readFile(f.path, 'utf8');
    await writeFile(f.path, src.replaceAll('hello-hedwig', id).replaceAll('hello_hedwig', id.replace(/[.-]/g, '_')).replaceAll('Hello Hedwig', name));
  }
  const manifestPath = join(target, 'hedwig.plugin.json');
  const m = JSON.parse(await readFile(manifestPath, 'utf8'));
  m.version = '0.1.0';
  m.description = `${name}: describe what it does in one sentence.`;
  m.author = 'You';
  await writeFile(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`Created ${target}\nNext: edit hedwig.plugin.json, then\n  npm run plugin -- validate ${target}\n  npm run plugin -- dev ${target}`);
}

async function cmdValidate(args) {
  if (!args[0]) usage();
  process.exit((await validate(resolve(args[0]))) ? 0 : 1);
}

async function cmdPack(args) {
  const out = flag(args, '--out');
  if (!args[0]) usage();
  const dir = resolve(args[0]);
  const manifest = await validate(dir, { quiet: true });
  if (!manifest) process.exit(1);
  const file = resolve(out || `${manifest.id}-${manifest.version}.tgz`);
  const files = (await listPluginFiles(dir)).filter((f) => !f.symlink);
  await new Promise((resolveP, reject) => {
    const stream = createWriteStream(file);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });
    stream.on('close', resolveP);
    archive.on('error', reject);
    archive.pipe(stream);
    // Fixed mtime so the same sources always produce the same tarball bytes.
    for (const f of files) archive.file(f.path, { name: `${manifest.id}/${f.rel.split('\\').join('/')}`, date: new Date('2000-01-01T00:00:00Z'), mode: 0o644 });
    archive.finalize();
  });
  const tarSha = createHash('sha256').update(await readFile(file)).digest('hex');
  const dirSha = await hashPluginDir(dir);
  await writeFile(`${file}.sha256`, `${tarSha}  ${basename(file)}\n`);
  console.log(`Packed ${file}\n  tarball sha256: ${tarSha}\n  plugin sha256 (what the server pins after install): ${dirSha}`);
}

async function cmdDev(args) {
  const pluginsDir = resolve(flag(args, '--plugins-dir') || process.env.HEDWIG_PLUGINS_DIR || '/plugins');
  if (!args[0]) usage();
  const dir = resolve(args[0]);
  const manifest = await validate(dir, { quiet: true });
  if (!manifest) process.exit(1);
  await mkdir(pluginsDir, { recursive: true });
  const link = join(pluginsDir, manifest.id);
  const existing = await lstat(link).catch(() => null);
  if (existing) {
    if (!existing.isSymbolicLink() || (await realpath(link)) !== (await realpath(dir))) {
      console.error(`${link} already exists and is not a link to ${dir}`);
      process.exit(1);
    }
  } else {
    await symlink(dir, link, 'dir');
  }
  const others = (await readdir(pluginsDir)).filter((n) => !n.startsWith('.') && n !== manifest.id);
  console.log(`Linked ${link} → ${dir}${others.length ? ` (also in ${pluginsDir}: ${others.join(', ')})` : ''}
The server loads it at start (and pins its sha256 on first sight). After editing files, reload it:
  Admin → Plugins → Reload, or POST /api/hedwig/admin/plugins/${manifest.id}/reload
Point the server at this directory with the admin setting plugins.dir (env HEDWIG_PLUGINS_DIR=${pluginsDir}).`);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { new: cmdNew, validate: cmdValidate, pack: cmdPack, dev: cmdDev };
if (!commands[cmd]) usage(cmd ? 1 : 0);
commands[cmd](rest).catch((err) => { console.error(err.message || err); process.exit(1); });
