import { query } from '../services/db.js';

export async function getState(key, fallback = null) {
  const { rows } = await query('SELECT value FROM hedwig_state WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setState(key, value) {
  await query(
    `INSERT INTO hedwig_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}
