// Hedwig eval harness (v2 stream D).
//
//   node scripts/hedwig-eval.mjs <suite> [--prompt <version>] [--prompt-id <id>] [--model <model>]
//                                        [--user <uuid>] [--limit <n>] [--live] [--no-record] [--json]
//
// Suites: retrieval, ask, sort, needs_you, spam, rescue. Classification suites score the stored
// decisions (hedwig_sort, or hedwig_triage before sorting exists) unless --prompt, --model or --live
// asks for a live run of the prompt (default sort.reflex; --prompt-id labels.judge also works).
// Silver and gold metrics print separately, with the change against the last accepted run of the
// same suite and scope. Exit code 1 when a gate fails (eval.gatePoints; spam false positives never up).
/* global process, console */
import 'dotenv/config';
import { pool } from '../src/services/db.js';
import { EVAL_SUITES, runAndRecord } from '../src/hedwig/labels/eval.js';

function parseArgs(argv) {
  const out = { suite: null, record: true, json: false, live: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--prompt') out.promptVersion = next();
    else if (a === '--prompt-id') out.promptId = next();
    else if (a === '--model') out.model = next();
    else if (a === '--user') out.userId = next();
    else if (a === '--limit') out.limit = Number(next()) || null;
    else if (a === '--live') out.live = true;
    else if (a === '--no-record') out.record = false;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('--') && !out.suite) out.suite = a;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const COUNT_KEYS = new Set(['n', 'tp', 'fp', 'fn', 'tn', 'missing', 'items', 'support']);

function table(title, metrics, diff) {
  const lines = [`  ${title}`];
  const rows = [];
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') walk(v, key);
      else rows.push([key, v]);
    }
  };
  walk(metrics);
  if (!rows.length) return `${lines[0]}\n    (no labelled items)`;
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    const leaf = k.split('.').pop();
    const shown = COUNT_KEYS.has(leaf) ? String(v ?? '—') : pct(v);
    const d = diff && Number.isFinite(diff[k]) && diff[k] !== 0 ? `  (${diff[k] > 0 ? '+' : ''}${COUNT_KEYS.has(leaf) ? diff[k] : `${diff[k]} pt`})` : '';
    lines.push(`    ${k.padEnd(width)}  ${shown}${d}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.suite) {
    console.log(`usage: node scripts/hedwig-eval.mjs <${EVAL_SUITES.join('|')}> [--prompt v] [--prompt-id id] [--model m] [--user id] [--limit n] [--live] [--no-record] [--json]`);
    return args.help ? 0 : 2;
  }
  if (!EVAL_SUITES.includes(args.suite)) throw new Error(`suite must be one of ${EVAL_SUITES.join(', ')}`);
  const out = await runAndRecord(args.suite, args);
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\nHedwig eval · ${args.suite}${out.id ? ` · run ${out.id}` : ' · not recorded'}`);
    console.log(`  source: ${out.metrics.scope.source || '—'}${out.promptId ? ` · prompt ${out.promptId}@${out.promptVersion || '?'}` : ''}${out.metrics.scope.live && out.model ? ` · ${out.model}` : ''}`);
    console.log(`  scope: ${args.userId || 'all users'} · ${out.nGold} gold, ${out.nSilver} silver`);
    console.log(out.previous ? `  compared with accepted run ${out.previous.id} (${new Date(out.previous.started_at).toISOString()})` : '  no accepted run to compare with (baseline)');
    console.log('');
    console.log(table('gold', out.metrics.gold, out.diff?.gold));
    console.log('');
    console.log(table('silver', out.metrics.silver, out.diff?.silver));
    console.log('');
    if (out.gates.failures.length) {
      console.log('  gates: FAILED');
      for (const f of out.gates.failures) console.log(`    - ${f}`);
    } else {
      console.log(`  gates: passed${out.gates.baseline ? ' (baseline)' : ''}`);
    }
    console.log(`  accepted: ${out.accepted ? 'yes' : 'no'}${out.nGold + out.nSilver === 0 ? ' (nothing to score)' : ''}\n`);
  }
  return out.gates.pass ? 0 : 1;
}

let code;
try {
  code = await main();
} catch (err) {
  console.error(`hedwig-eval: ${err.message}`);
  code = 2;
} finally {
  await pool.end().catch(() => {});
}
process.exit(code);
