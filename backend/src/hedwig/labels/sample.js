// Stratified sampling for the nightly judge: folder × sender volume × age, so the few messages the
// judge can afford cover spam folders, rare senders and old mail, not just this week's inbox.

/** Deterministic PRNG (mulberry32) so a night's sample is reproducible from its seed. */
export function prng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function folderClass(row) {
  const f = String(row.folder || '');
  const su = row.special_use || '';
  if (su === '\\Junk' || /(^|[/.])(spam|junk|junk e-?mail|bulk mail)$/i.test(f)) return 'spam';
  if (su === '\\Archive' || /(^|[/.])(archive|archives)$/i.test(f)) return 'archive';
  if (/^inbox$/i.test(f)) return 'inbox';
  return 'other';
}

export function volumeBucket(n) {
  const v = Number(n) || 0;
  if (v <= 2) return 'rare';
  if (v <= 10) return 'regular';
  return 'frequent';
}

export function ageBucket(date, now = Date.now()) {
  const days = (now - new Date(date).getTime()) / 86400_000;
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'older';
}

export function stratumOf(row, now = Date.now()) {
  return `${folderClass(row)}|${volumeBucket(row.sender_volume)}|${ageBucket(row.date, now)}`;
}

function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Take `n` rows spread evenly across strata: round-robin over the non-empty strata (in a seeded
 * order), a seeded shuffle within each, so a stratum with 3 rows gets all 3 before a stratum with
 * 3,000 gets its 4th. Returns rows with `stratum` attached.
 */
export function stratifiedSample(rows, n, { seed = 1, now = Date.now() } = {}) {
  if (!(n > 0) || !rows.length) return [];
  const rand = prng(seed);
  const strata = new Map();
  for (const r of rows) {
    const key = stratumOf(r, now);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(r);
  }
  const queues = shuffle([...strata.keys()].sort(), rand).map((key) => ({ key, items: shuffle(strata.get(key), rand) }));
  const out = [];
  while (out.length < n && queues.some((q) => q.items.length)) {
    for (const q of queues) {
      if (out.length >= n) break;
      const item = q.items.shift();
      if (item) out.push({ ...item, stratum: q.key });
    }
  }
  return out;
}
