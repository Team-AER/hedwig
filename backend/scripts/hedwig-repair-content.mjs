// Explicit, resumable maintenance. Defaults to read-only inspection.
import 'dotenv/config';
import { enqueueMetadataRefresh } from '../src/hedwig/content/metadata.js';
import { pool, query } from '../src/services/db.js';
import { normaliseSweep } from '../src/hedwig/content/store.js';
import { enqueueContentRepairs, contentRepairStatus, reindexContentBatch } from '../src/hedwig/content/repair.js';

const args = process.argv.slice(2);
const known = new Set(['--apply','--metadata','--normalise-only','--index-first']);
for (const arg of args) if (!known.has(arg) && !/^[0-9a-f-]{36}$/i.test(arg)) throw new Error(`Unknown option or invalid message UUID: ${arg}`);
const apply = args.includes('--apply');
const ids = args.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
try {
  if (apply) {
    let count = 0;
    for (;;) {
      const result = await normaliseSweep({ limit:100,messageIds:ids.length ? ids : null });
      count += result.processed;
      if (!result.processed) break;
      console.log(JSON.stringify({ normalised:count,...result }));
    }
    if (args.includes('--index-first')) {
      let indexed=0;
      for (;;) {
        const result=await reindexContentBatch({ messageIds:ids.length ? ids : null });
        if (!result.processed) break;
        indexed+=result.processed; console.log(JSON.stringify({ reindexed:indexed }));
      }
    }
    if (!args.includes('--normalise-only') && args.includes('--metadata')) console.log(JSON.stringify(await enqueueMetadataRefresh({ messageIds:ids.length ? ids : null })));
    if (!args.includes('--normalise-only')) console.log(JSON.stringify(await enqueueContentRepairs({ messageIds:ids.length ? ids : null,limit:100000 })));
  }
  console.log(JSON.stringify({ apply,status:await contentRepairStatus(),unparsed:(await query(`SELECT COUNT(*)::int AS n FROM messages m LEFT JOIN hedwig_email_content c ON c.message_id=m.id WHERE NOT m.is_deleted AND (m.body_html IS NOT NULL OR m.body_text IS NOT NULL) AND c.message_id IS NULL`)).rows[0].n }));
} finally { await pool.end(); }
