// Runs backend/migrations-hedwig/*.sql after the upstream migrations, in the same
// schema_migrations table (versions prefixed 'hedwig/'). Kept separate from upstream's numbering
// so monthly upstream merges never collide with Hedwig's schema.
import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { pool, query } from '../services/db.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations-hedwig');
export const HEDWIG_SCHEMA_VERSION_PREFIX = 'hedwig/';

export async function hedwigMigrationFiles() {
  let names;
  try { names = await readdir(DIR); } catch { return []; }
  return Promise.all(names.filter((f) => /^h\d{4}_.+\.sql$/.test(f)).sort().map(async (f) => ({
    version: HEDWIG_SCHEMA_VERSION_PREFIX + f.replace(/\.sql$/, ''),
    sql: await readFile(join(DIR, f), 'utf8'),
  })));
}

export async function runHedwigMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7418291835)');
    await client.query('SET statement_timeout = 0');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    let ran = 0;
    for (const { version, sql } of await hedwigMigrationFiles()) {
      if (applied.has(version)) continue;
      console.log(`Hedwig migrations: applying ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${version}: ${err.message}`, { cause: err });
      }
      ran++;
    }
    console.log(ran ? `Hedwig migrations: ${ran} applied` : 'Hedwig migrations: schema up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(7418291835)').catch(() => {});
    client.release();
  }
}

/** True once every Hedwig migration file is recorded as applied. The worker waits on this. */
export async function hedwigSchemaReady() {
  const files = await hedwigMigrationFiles();
  if (!files.length) return true;
  try {
    const { rows } = await query('SELECT version FROM schema_migrations WHERE version = ANY($1::text[])', [files.map((f) => f.version)]);
    return rows.length === files.length;
  } catch {
    return false;
  }
}
