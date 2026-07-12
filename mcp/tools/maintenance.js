import { z } from 'zod';
import { asText, query, tool } from './util.js';

export function registerMaintenanceTools(server, api) {
  tool(
    server,
    'list_maintenance',
    {
      title: 'List maintenance events',
      description:
        'List maintenance events, optionally filtered by printer, status (pending|completed), or maintenance type.',
      inputSchema: {
        printer: z.string().optional().describe('Filter by printer id'),
        status: z.enum(['pending', 'completed']).optional(),
        type: z.string().optional().describe('Filter by maintenance type'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ printer, status, type }) =>
      asText(await api.request('GET', `/api/v1/maintenance${query({ printer, status, type })}`)),
  );

  tool(
    server,
    'maintenance_summary',
    {
      title: 'Maintenance fleet summary',
      description:
        'Fleet-wide maintenance aggregates: printers requiring maintenance, overdue task count, average health, total fleet hours.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('GET', '/api/v1/maintenance/summary')),
  );

  tool(
    server,
    'get_printer_maintenance',
    {
      title: 'Printer maintenance detail',
      description:
        'Per-printer maintenance summary: health score/status, total & nozzle hours, pending tasks (with overdue flag), completed tasks, next service.',
      inputSchema: { printerId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ printerId }) =>
      asText(await api.request('GET', `/api/v1/maintenance/printer/${encodeURIComponent(printerId)}`)),
  );

  tool(
    server,
    'complete_maintenance',
    {
      title: 'Complete maintenance task',
      description: 'Mark a pending maintenance event complete, optionally recording notes.',
      inputSchema: {
        eventId: z.string(),
        notes: z.string().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ eventId, notes }) =>
      asText(
        await api.request('POST', `/api/v1/maintenance/${encodeURIComponent(eventId)}/complete`, {
          body: { notes },
        }),
      ),
  );
}
