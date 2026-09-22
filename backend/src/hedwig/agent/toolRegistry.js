// Agent tool registry. Core modules and plugins register tools here; the agent loop exposes the
// tools a user may use (plugin tools only when that user granted the plugin the tool's permission)
// to the model as OpenAI function definitions.
//
// A tool that changes mail or sends anything MUST set `mutates: true`. Mutating tools never run
// directly from a model call: the agent records a pending hedwig_agent_actions row and the user
// approves it (unless they turned confirmation off in settings).

/**
 * @typedef {object} AgentTool
 * @property {string} name          snake_case, unique; plugin tools are prefixed `<pluginId>__`
 * @property {string} description   what it does, for the model
 * @property {object} parameters    JSON schema for arguments
 * @property {boolean} [mutates]    changes mail/state visible to others; requires confirmation
 * @property {string} [pluginId]    set for plugin tools
 * @property {string} [permission]  permission the plugin needs granted, e.g. 'mail.read'
 * @property {(args: object) => string} [summarize]  one line shown in the confirmation card
 * @property {(args: object, ctx: {userId: string, runId?: string, signal?: AbortSignal}) => Promise<any>} handler
 */

const tools = new Map();
const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function registerTool(tool) {
  if (!tool || !NAME_RE.test(tool.name || '')) throw new Error(`agent tool name must match ${NAME_RE}`);
  if (tools.has(tool.name)) throw new Error(`agent tool ${tool.name} already registered`);
  if (typeof tool.handler !== 'function') throw new Error(`agent tool ${tool.name} needs a handler`);
  if (!tool.description) throw new Error(`agent tool ${tool.name} needs a description`);
  tools.set(tool.name, { parameters: { type: 'object', properties: {} }, mutates: false, ...tool });
}

export function unregisterPluginTools(pluginId) {
  for (const [name, t] of tools) if (t.pluginId === pluginId) tools.delete(name);
}

export function getTool(name) { return tools.get(name) || null; }

export function allTools() { return [...tools.values()]; }

/**
 * Tools available to a user. `grants` is a Set of `${pluginId}:${permission}` strings.
 * `allowed` optionally narrows to a list of names (automations).
 */
export function toolsFor({ grants = new Set(), activePlugins = new Set(), allowed = null } = {}) {
  return allTools().filter((t) => {
    if (allowed && allowed.length && !allowed.includes(t.name)) return false;
    if (!t.pluginId) return true;
    if (!activePlugins.has(t.pluginId)) return false;
    return !t.permission || grants.has(`${t.pluginId}:${t.permission}`);
  });
}

export function toOpenAiTools(list) {
  return list.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description + (t.mutates ? ' (requires the user to confirm)' : ''), parameters: t.parameters },
  }));
}

export function _resetTools() { tools.clear(); }
