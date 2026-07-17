import { z } from 'zod';
import { asText, tool } from './util.js';
import { classifyAdminRequest } from '../adminPolicy.js';

// Escape-hatch for the rarer /api/v1 admin surfaces that don't warrant a
// dedicated tool: slicer-keys, users, admin-credential, manager-requests,
// settings, audit-logs, queue export/import, filament-station. Restricted to
// paths under /api/v1/ so it can't be pointed at arbitrary hosts/paths.
export function registerAdminTools(server, api) {
  tool(
    server,
    'printfarm_admin_request',
    {
      title: 'Print farm admin request (raw /api/v1)',
      description:
        'Make a raw request to any /api/v1 endpoint. Use for admin surfaces without a dedicated tool: ' +
        'slicer-keys (mint/revoke API keys), users (staff accounts), admin-credential, manager-requests, ' +
        'settings/<key> (branding, integrations, layouts), audit-logs, queue export/import, filament-station. ' +
        'WARNING: this can return plaintext secrets (POST /api/v1/slicer-keys and ' +
        '/api/v1/manager-requests/:id/approve return a one-time API key) and can reset the admin password ' +
        '(PUT /api/v1/admin-credential) or delete accounts — confirm with a human before destructive calls. ' +
        'The path must start with /api/v1/. ' +
        'By default (MCP_ADMIN_MODE=restricted) WRITES to slicer-keys, users, admin-credential, ' +
        'manager-requests, settings, and notifications are refused as privilege-escalation / ' +
        'exfiltration surfaces; reads are allowed.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
        path: z
          .string()
          .describe('Full path under the data API, e.g. "/api/v1/users" or "/api/v1/settings/branding"'),
        body: z.record(z.any()).optional().describe('JSON body for POST/PUT'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ method, path, body }) => {
      const p = String(path || '');
      if (!p.startsWith('/api/v1/') && p !== '/api/v1') {
        throw new Error(`path must start with /api/v1/ (got "${p}")`);
      }
      // Defense-in-depth least-privilege gate (S-5): block the crown-jewel
      // escalation writes unless the operator opted into MCP_ADMIN_MODE=full.
      const decision = classifyAdminRequest(method || 'GET', p);
      if (!decision.allowed) {
        throw new Error(decision.reason);
      }
      return asText(await api.request(method || 'GET', p, { body }));
    },
  );
}
