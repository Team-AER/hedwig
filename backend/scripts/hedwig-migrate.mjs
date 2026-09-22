// Apply upstream + Hedwig migrations without starting the API (dev and CI).
import 'dotenv/config';
import { runMigrations } from '../src/services/migrations.js';
import { runHedwigMigrations } from '../src/hedwig/migrate.js';
import { pool } from '../src/services/db.js';

await runMigrations();
await runHedwigMigrations();
await pool.end();
