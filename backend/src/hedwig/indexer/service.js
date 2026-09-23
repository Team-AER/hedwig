// Index operations used by the module, routes and other streams.
import { query } from '../../services/db.js';
import { getConfig, saveSystemConfig } from '../config.js';
import { getState } from '../state.js';
import { indexMessages, embedPending, drain, chunkPending } from './store.js';
import { coverageSummary, refreshCoverage, resetCoverage } from './coverage.js';
import { applyRecipeChange, currentRecipe } from './recipe.js';
import { reconcileBodies, requestAttachments, requestBodies } from './acquire.js';

export { retrieve, indexStatus, messageParts, attachmentCards } from './retrieve.js';
export { splitBody } from './parse.js';

/** Pipeline step: chunk every row now; embed live mail right away, history via the sweep. */
export async function indexStep(rows, ctx = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled || !rows.length) return;
  const res = await indexMessages(rows);
  if (!ctx.historical && res.messages) {
    await embedPending({ messageIds: rows.map((r) => r.id), maxChunks: 512 })
      .catch((err) => console.warn('[hedwig] index: live embedding deferred to the sweep:', err.message));
  }
}

/** Worker sweeps, each bounded by a time budget. */
export const sweeps = {
  chunk: () => drain(() => chunkPending({ limit: 100 })),
  embed: async () => {
    const cfg = await getConfig();
    return drain(() => embedPending({ maxChunks: cfg['index.embedBatch'] * 4 }), { budgetMs: 10_000 });
  },
  acquire: async () => {
    await reconcileBodies();
    const bodies = await requestBodies();
    const attachments = await requestAttachments();
    return bodies + attachments;
  },
  coverage: () => refreshCoverage(),
};

/**
 * Admin rebuild. `recipe` sets index.recipe (every user re-chunks and re-embeds in the background;
 * search keeps the old recipe per user until theirs is complete). `userId` (or neither) forces the
 * user's (everyone's) messages to be re-chunked and re-embedded under the current recipe.
 */
export async function rebuild({ userId = null, recipe = null } = {}) {
  let recipeChanged = false;
  if (recipe) {
    const v = String(recipe).trim();
    if (!/^[\w.-]{1,40}$/.test(v)) { const e = new Error('recipe must be 1-40 letters, digits, dots, dashes or underscores'); e.status = 400; throw e; }
    await saveSystemConfig({ 'index.recipe': v });
    recipeChanged = await applyRecipeChange();
  }
  let messages = 0;
  if (userId || !recipe) {
    const { rowCount } = await query(
      `UPDATE hedwig_index_msg SET chunk_version = NULL, embed_recipe = NULL, error = NULL, updated_at = NOW()
        ${userId ? 'WHERE user_id = $1' : ''}`,
      userId ? [userId] : [],
    );
    messages = rowCount;
  }
  await resetCoverage({ userId });
  return { ok: true, recipe: (await currentRecipe()).full, recipeChanged, userId, messages };
}

/** Totals for /admin/health. */
export async function indexHealth() {
  const cfg = await getConfig();
  const [coverage, recipe, embedError, backlog] = await Promise.all([
    coverageSummary(),
    currentRecipe(),
    getState('index.embedError', null),
    query(`SELECT COUNT(*) FILTER (WHERE chunk_version IS NULL AND error IS NULL)::int AS unchunked,
                  COUNT(*) FILTER (WHERE embed_recipe IS NULL AND chunk_version IS NOT NULL)::int AS unembedded,
                  COUNT(*) FILTER (WHERE body_state = 'requested')::int AS bodies_requested,
                  COUNT(*) FILTER (WHERE body_state IN ('failed','empty'))::int AS bodies_failed,
                  COUNT(*) FILTER (WHERE attach_state = 'failed')::int AS attachments_failed,
                  COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors
             FROM hedwig_index_msg`),
  ]);
  return {
    coverage,
    backlog: backlog.rows[0],
    recipe: { current: recipe.full, vectors: recipe.vectors, note: recipe.reason },
    tika: { enabled: cfg['index.tikaEnabled'], url: cfg['index.tikaUrl'] },
    embedError: embedError?.error || null,
  };
}
