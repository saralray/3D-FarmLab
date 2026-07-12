import { z } from 'zod';
import { asText, tool } from './util.js';

const pid = (id) => encodeURIComponent(id);

export function registerPrinterTools(server, api) {
  tool(
    server,
    'list_printers',
    {
      title: 'List printers',
      description:
        'List every printer with live telemetry (status idle/printing/paused/error/offline, temperatures, progress, current job, loaded AMS spools) and connection fields. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('GET', '/api/v1/printers')),
  );

  tool(
    server,
    'get_printer',
    {
      title: 'Get printer',
      description: 'Get a single printer by id, with live telemetry overlaid.',
      inputSchema: { id: z.string().describe('Printer id') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => asText(await api.request('GET', `/api/v1/printers/${pid(id)}`)),
  );

  tool(
    server,
    'upsert_printer',
    {
      title: 'Create or update printer',
      description:
        'Create or update a printer record. The printer object must include an id. Accepts connection fields (name, model, profile, url, ipAddress, apiKeyHeader, serial).',
      inputSchema: {
        printer: z
          .record(z.any())
          .describe('Printer object; must include an "id" field'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ printer }) => asText(await api.request('POST', '/api/v1/printers', { body: printer })),
  );

  tool(
    server,
    'delete_printer',
    {
      title: 'Delete printer',
      description: 'Permanently delete a printer record by id.',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => asText(await api.request('DELETE', `/api/v1/printers/${pid(id)}`)),
  );

  tool(
    server,
    'printer_command',
    {
      title: 'Send Bambu command',
      description:
        'Send a control command to a Bambu printer over MQTT. Common commands: pause, resume, cancel, light_on, light_off, set_temperature, set_fan, gcode, load_filament, unload_filament. Command-specific fields go in params, e.g. { heater:"nozzle", target:210 } or { gcode:"G28" }.',
      inputSchema: {
        id: z.string(),
        command: z
          .string()
          .describe('e.g. pause | resume | cancel | light_on | set_temperature | gcode'),
        params: z
          .record(z.any())
          .optional()
          .describe('Command-specific fields merged into the request body'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ id, command, params }) =>
      asText(
        await api.request('POST', `/api/v1/printers/${pid(id)}/command`, {
          body: { command, ...(params || {}) },
        }),
      ),
  );

  tool(
    server,
    'printer_proxy',
    {
      title: 'Printer hardware passthrough',
      description:
        "Raw HTTP passthrough to a printer's hardware API (e.g. Moonraker on a Snapmaker U1). Use for non-Bambu control parity: pause/resume/cancel via printer/print/<cmd>, gcode scripts, temps, fans, LED. Non-GET calls are audited.",
      inputSchema: {
        id: z.string(),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
        path: z
          .string()
          .describe('Path under the printer API, e.g. "printer/print/pause" or "printer/objects/query"'),
        body: z.record(z.any()).optional().describe('JSON body for non-GET calls'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ id, method, path, body }) => {
      const sub = String(path || '').replace(/^\/+/, '');
      return asText(
        await api.request(method || 'GET', `/api/v1/printers/${pid(id)}/proxy/${sub}`, { body }),
      );
    },
  );

  tool(
    server,
    'get_camera_snapshot',
    {
      title: 'Camera snapshot',
      description:
        'Fetch a single still JPEG frame from a printer camera and return it as an image.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const { buffer, contentType } = await api.request(
        'GET',
        `/api/v1/printers/${pid(id)}/camera/snapshot`,
        { raw: true },
      );
      return {
        content: [
          {
            type: 'image',
            data: buffer.toString('base64'),
            mimeType: (contentType || 'image/jpeg').split(';')[0],
          },
        ],
      };
    },
  );

  tool(
    server,
    'get_camera_health',
    {
      title: 'Camera health',
      description:
        'Camera feed health for a printer (status, online, viewers, last frame age, restarts, last error).',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => asText(await api.request('GET', `/api/v1/printers/${pid(id)}/camera/health`)),
  );
}
