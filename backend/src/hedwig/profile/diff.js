// Line-based unified diff between two profile versions. Profiles are at most a few dozen lines, so
// a plain LCS table is fine. Pure.

function lcsTable(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

/** Edit script: [{ op: ' '|'-'|'+', line, a, b }] where a/b are 0-based positions in each side. */
export function editScript(a, b) {
  const t = lcsTable(a, b);
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i], a: i, b: j }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) { out.push({ op: '-', line: a[i], a: i, b: j }); i++; }
    else { out.push({ op: '+', line: b[j], a: i, b: j }); j++; }
  }
  while (i < a.length) { out.push({ op: '-', line: a[i], a: i, b: j }); i++; }
  while (j < b.length) { out.push({ op: '+', line: b[j], a: i, b: j }); j++; }
  return out;
}

const splitLines = (text) => (String(text || '') === '' ? [] : String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/**
 * Unified diff (`--- a` / `+++ b` / `@@ -l,s +l,s @@` hunks) with `context` lines around changes.
 * Empty string when the texts are the same.
 */
export function unifiedDiff(before, after, { context = 3, from = 'before', to = 'after' } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  const script = editScript(a, b);
  if (!script.some((e) => e.op !== ' ')) return '';
  // Group changes into hunks that share context.
  const hunks = [];
  let cur = null;
  script.forEach((e, idx) => {
    if (e.op === ' ') return;
    const start = Math.max(0, idx - context);
    const end = Math.min(script.length - 1, idx + context);
    if (cur && start <= cur.end + 1) cur.end = Math.max(cur.end, end);
    else { cur = { start, end }; hunks.push(cur); }
  });
  const lines = [`--- ${from}`, `+++ ${to}`];
  for (const h of hunks) {
    const part = script.slice(h.start, h.end + 1);
    const aLen = part.filter((e) => e.op !== '+').length;
    const bLen = part.filter((e) => e.op !== '-').length;
    const aStart = aLen ? part.find((e) => e.op !== '+').a + 1 : part[0].a;
    const bStart = bLen ? part.find((e) => e.op !== '-').b + 1 : part[0].b;
    lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const e of part) lines.push(`${e.op}${e.line}`);
  }
  return `${lines.join('\n')}\n`;
}
