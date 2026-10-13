// Connectors: Hedwig as a remote MCP server for Claude, ChatGPT and other MCP clients. The public
// endpoints (POST /mcp, OAuth, discovery) are mounted by mountHedwig; this module adds the signed-in
// routes for the /connect page and Settings → Connectors.
import { mountMcpRoutes } from './routes.js';

export { mountMcpPublic } from './routes.js';

export default {
  name: 'mcp',
  routes(r) {
    mountMcpRoutes(r);
  },
};
