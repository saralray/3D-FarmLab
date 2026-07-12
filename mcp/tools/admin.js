import { z } from 'zod';
import { asText, tool } from './util.js';

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
        'The path must start with /api/v1/.',
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
      return asText(await api.request(method || 'GET', p, { body }));
    },
  );
}
