import { z } from 'zod';
import { asText, tool } from './util.js';

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
        'Create a Discord notification webhook. Provide the webhook object (e.g. name, url, enabled event flags). An id is generated if omitted.',
      inputSchema: {
        webhook: z.record(z.any()).describe('Webhook config object'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ webhook }) => asText(await api.request('POST', '/api/v1/notifications', { body: webhook })),
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
    async ({ id }) => asText(await api.request('DELETE', `/api/v1/notifications/${encodeURIComponent(id)}`)),
  );
}
