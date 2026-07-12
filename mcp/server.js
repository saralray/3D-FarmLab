// Builds the MCP server and registers all tools, bound to one { apiBase, apiKey }.
//
// A fresh server is built per identity: for stdio the key is PRINTFARM_API_KEY;
// for the HTTP transport a new server is built per request from the caller's
// key (stateless key passthrough — see index.js), so tool handlers always call
// /api/v1 as whoever made the MCP request.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApiClient } from './apiClient.js';
import { registerPrinterTools } from './tools/printers.js';
import { registerQueueTools } from './tools/queue.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerNotificationTools } from './tools/notifications.js';
import { registerStatusTools } from './tools/status.js';
import { registerAdminTools } from './tools/admin.js';

export const SERVER_NAME = 'printfarm-mcp';
export const SERVER_VERSION = '1.0.0';

export function createMcpServer({ apiBase, apiKey }) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools to monitor and control a 3D print farm (printers, cameras, print queue, ' +
        'analytics, maintenance, notifications) via the farm\'s /api/v1 API. Tools marked ' +
        'destructive (delete/reset, printfarm_admin_request) change state or can return secrets — ' +
        'confirm with the operator before running them.',
    },
  );

  const api = createApiClient({ apiBase, apiKey });

  registerPrinterTools(server, api);
  registerQueueTools(server, api);
  registerAnalyticsTools(server, api);
  registerMaintenanceTools(server, api);
  registerNotificationTools(server, api);
  registerStatusTools(server, api);
  registerAdminTools(server, api);

  return server;
}
