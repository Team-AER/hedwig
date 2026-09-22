// Registers the agent module's tools. Tool names are split between modules (see
// docs/hedwig/API.md): the agent owns the generic mail tools; context and triage own theirs, and
// the stand-ins in fallbacks.js are only registered when those modules did not register their own.
import { registerTool, getTool } from '../toolRegistry.js';
import { readTools } from './read.js';
import { mutatingTools } from './mutate.js';
import { stateTools } from './state.js';
import { fallbackTools } from './fallbacks.js';

export const OWNED_TOOLS = [...readTools, ...mutatingTools, ...stateTools];

export function registerAgentTools() {
  for (const tool of OWNED_TOOLS) registerTool(tool);
  const fallbacks = [];
  for (const tool of fallbackTools) {
    if (getTool(tool.name)) continue;
    registerTool(tool);
    fallbacks.push(tool.name);
  }
  return { fallbacks };
}
