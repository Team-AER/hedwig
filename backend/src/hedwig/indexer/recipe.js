// Index recipes. The chunker version is `index.recipe`; the full recipe that keys vectors is
// `<chunker version>:<embedding model>`. When either changes, messages are re-chunked and
// re-embedded in the background while search keeps using the previous recipe for a user until the
// new one is complete for them (checked on every coverage refresh).
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { embeddingProfile } from '../embeddings.js';
import { getState, setState } from '../state.js';

export const VECTOR_DIMS = 1024; // hedwig_chunk_vectors.vector is vector(1024)

/** @returns {Promise<{ version: string, model: string, full: string, vectors: boolean, dims: number|null, reason: string|null }>} */
export async function currentRecipe() {
  const cfg = await getConfig();
  const version = String(cfg['index.recipe'] || 'v1').trim() || 'v1';
  const profile = await embeddingProfile().catch(() => null);
  const model = profile?.model || 'none';
  let reason = null;
  if (!profile) reason = 'embeddings are off';
  else if (profile.dims !== VECTOR_DIMS) reason = `embedding model has ${profile.dims} dims; the chunk index stores ${VECTOR_DIMS}`;
  return { version, model, full: `${version}:${model}`, vectors: !reason, dims: profile?.dims ?? null, reason };
}

export function splitRecipe(full) {
  const s = String(full || '');
  const i = s.indexOf(':');
  return i < 0 ? { version: s, model: '' } : { version: s.slice(0, i), model: s.slice(i + 1) };
}

const userKey = (userId) => `index.recipe.${userId}`;

/**
 * The recipes retrieval should use for a user.
 * active = what search reads; target = what is being built. They differ only during a rebuild.
 */
export async function recipesFor(userId) {
  const cur = await currentRecipe();
  const st = await getState(userKey(userId), null).catch(() => null);
  const active = st?.active || cur.full;
  const a = splitRecipe(active);
  // Query vectors come from the configured model, so old-recipe vectors are only comparable when
  // the model did not change; otherwise the vector arm reads what the new model has embedded so far.
  const vecRecipe = a.model === cur.model ? active : cur.full;
  return {
    activeVersion: a.version || cur.version,
    targetVersion: cur.version,
    vecRecipe,
    vectors: cur.vectors,
    current: cur,
    active,
  };
}

/**
 * Called when the configured recipe may have changed: marks every message whose chunks or vectors
 * belong to another recipe as due. Cheap when nothing changed.
 */
export async function applyRecipeChange(cur = null) {
  const recipe = cur || await currentRecipe();
  const last = await getState('index.recipe.global', null);
  if (last?.full === recipe.full) return false;
  if (last?.version && last.version !== recipe.version) {
    await query('UPDATE hedwig_index_msg SET chunk_version = NULL, embed_recipe = NULL, updated_at = NOW() WHERE chunk_version IS DISTINCT FROM $1', [recipe.version]);
  }
  await query('UPDATE hedwig_index_msg SET embed_recipe = NULL, updated_at = NOW() WHERE embed_recipe IS NOT NULL AND embed_recipe <> $1', [recipe.full]);
  await setState('index.recipe.global', { full: recipe.full, version: recipe.version, changedAt: new Date().toISOString() });
  return true;
}

/**
 * Switch each user's active recipe to the target once every indexed message of theirs is chunked
 * (and embedded, when vectors are on) under it, then drop the old recipe's chunks and vectors.
 */
export async function switchCompletedUsers(userIds, cur = null) {
  const recipe = cur || await currentRecipe();
  const switched = [];
  for (const userId of userIds) {
    const st = await getState(userKey(userId), null);
    if (!st?.active) {
      await setState(userKey(userId), { active: recipe.full, since: new Date().toISOString() });
      continue;
    }
    if (st.active === recipe.full) continue;
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM hedwig_index_msg x WHERE x.user_id = $1
             AND (x.chunk_version IS DISTINCT FROM $2 OR ($4 AND x.embed_recipe IS DISTINCT FROM $3)))::int
       + (SELECT COUNT(*) FROM hedwig_msg h LEFT JOIN hedwig_index_msg x ON x.message_id = h.message_id
           WHERE h.user_id = $1 AND (h.skip_reason IS NULL OR h.skip_reason = 'spam') AND x.message_id IS NULL)::int AS due`,
      [userId, recipe.version, recipe.full, recipe.vectors],
    );
    if (rows[0].due > 0) continue;
    await setState(userKey(userId), { active: recipe.full, since: new Date().toISOString(), previous: st.active });
    await query('DELETE FROM hedwig_chunks WHERE user_id = $1 AND recipe <> $2', [userId, recipe.version]);
    await query('DELETE FROM hedwig_chunk_vectors WHERE user_id = $1 AND recipe <> $2', [userId, recipe.full]);
    switched.push(userId);
  }
  return switched;
}
