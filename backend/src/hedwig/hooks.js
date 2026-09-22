// Hedwig hook points, dispatched through upstream's plugin registry so a single manifest carries
// both upstream hooks (inboxIngest, onSentMessage, …) and Hedwig's. Names are listed here so the
// plugin docs, the permission checker and the dispatch sites agree.
import { pluginRegistry } from '../plugins/registry.js';

export const HEDWIG_HOOKS = Object.freeze({
  // collectHook: return { features?: Record<string, number>, verdict?: { category, reason } } to steer triage.
  beforeTriage: 'hedwig.beforeTriage',
  // runHook: a triage decision was stored. ctx: { userId, messageId, triage }
  afterTriage: 'hedwig.afterTriage',
  // runHook: an entity or topic card summary was rebuilt. ctx: { userId, kind: 'entity'|'topic', id }
  onContextBuilt: 'hedwig.onContextBuilt',
  // collectHook: return { block?: boolean, warn?: string, reason?: string } for an outgoing message.
  beforeSend: 'hedwig.beforeSend',
  // runHook: a message entered Hedwig's pipeline. ctx: { userId, messageId, accountId }
  onMessageIndexed: 'hedwig.onMessageIndexed',
  // collectHook: return insight cards { title, body, severity, data } for a user's daily run.
  collectInsights: 'hedwig.collectInsights',
});

export function runHedwigHook(name, ctx) {
  return pluginRegistry.runHook(name, ctx);
}

export function collectHedwigHook(name, ctx) {
  return pluginRegistry.collectHook(name, ctx);
}
