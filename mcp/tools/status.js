import { z } from 'zod';
import { asText, tool } from './util.js';

export function registerStatusTools(server, api) {
  tool(
    server,
    'list_status_light_devices',
    {
      title: 'List status-light devices',
      description:
        'List ESP32 status-light devices and whether each is currently connected (polled recently).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('GET', '/api/v1/status-light/devices')),
  );

  tool(
    server,
    'get_printer_status',
    {
      title: 'Get printer status light state',
      description:
        'Get the coarse status a printer\'s status light shows: idle | printing | paused | error | offline.',
      inputSchema: { printerId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ printerId }) =>
      asText(await api.request('GET', `/api/v1/status-light/printers/${encodeURIComponent(printerId)}`)),
  );
}
