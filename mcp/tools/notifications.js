import { z } from 'zod';
import { asText, tool } from './util.js';
import { classifyAdminRequest } from '../adminPolicy.js';

// A Discord webhook URL is an exfiltration channel: a prompt-injected agent that
// can create one points the farm's notifications (job/printer data) at an
// attacker. So the notification WRITE tools honor the same MCP_ADMIN_MODE gate as
// the admin escape-hatch (notifications is in its restricted-write set) — blocked
// by default, allowed only under MCP_ADMIN_MODE=full. Listing stays open.
function guardNotificationWrite(method, path) {
  const decision = classifyAdminRequest(method, path);
  if (!decision.allowed) throw new Error(decision.reason);
}

export function registerNotificationTools(server, api) {
  tool(
    server,
    'list_notifications',
    {
      title: 'List Discord webhooks',
      description: 'List configured Discord notification webhooks.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('GET', '/api/v1/notifications')),
  );

  tool(
    server,
    'create_notification',
    {
      title: 'Create Discord webhook',
      description:
        'Create a Discord notification webhook. Provide the webhook object (e.g. name, url, enabled event flags). An id is generated if omitted. ' +
        'Blocked under MCP_ADMIN_MODE=restricted (the default) — a webhook URL is a data-exfiltration channel.',
      inputSchema: {
        webhook: z.record(z.any()).describe('Webhook config object'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ webhook }) => {
      guardNotificationWrite('POST', '/api/v1/notifications');
      return asText(await api.request('POST', '/api/v1/notifications', { body: webhook }));
    },
  );

  tool(
    server,
    'delete_notification',
    {
      title: 'Delete Discord webhook',
      description: 'Delete a Discord notification webhook by id.',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const path = `/api/v1/notifications/${encodeURIComponent(id)}`;
      guardNotificationWrite('DELETE', path);
      return asText(await api.request('DELETE', path));
    },
  );
}
