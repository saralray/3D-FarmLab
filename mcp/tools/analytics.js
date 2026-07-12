import { z } from 'zod';
import { asText, query, tool } from './util.js';

export function registerAnalyticsTools(server, api) {
  tool(
    server,
    'get_analytics',
    {
      title: 'Get analytics',
      description: 'Daily analytics rollups. Defaults to the last 7 days; pass days to widen.',
      inputSchema: {
        days: z.number().int().positive().max(365).optional().describe('Number of days (default 7)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ days }) => asText(await api.request('GET', `/api/v1/analytics${query({ days })}`)),
  );

  tool(
    server,
    'reset_analytics',
    {
      title: 'Reset analytics',
      description: 'Reset the daily analytics rollups. Destructive — clears accumulated totals.',
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('POST', '/api/v1/analytics/reset')),
  );
}
