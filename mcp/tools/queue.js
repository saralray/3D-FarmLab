import { z } from 'zod';
import { asText, tool } from './util.js';

const qid = (id) => encodeURIComponent(id);

export function registerQueueTools(server, api) {
  tool(
    server,
    'list_queue',
    {
      title: 'List print queue',
      description:
        'List stored queue jobs (queued and history). Cheap DB read — no Google Sheet sync. Each job has id, filename, priority, submitter, printedStatus, and a download path when a file is stored.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('GET', '/api/v1/queue')),
  );

  tool(
    server,
    'upsert_queue_jobs',
    {
      title: 'Create or update queue jobs',
      description:
        'Upsert one or more queue jobs. Provide an array of job objects (each with an id). Returns the number added/updated.',
      inputSchema: {
        jobs: z.array(z.record(z.any())).describe('Array of job objects, each with an id'),
      },
      annotations: { openWorldHint: true },
    },
    async ({ jobs }) => asText(await api.request('POST', '/api/v1/queue', { body: { jobs } })),
  );

  tool(
    server,
    'mark_job_printed',
    {
      title: 'Mark job printed',
      description: 'Mark a queue job as printed (printed_status=1).',
      inputSchema: { id: z.string() },
      annotations: { openWorldHint: true },
    },
    async ({ id }) => asText(await api.request('POST', `/api/v1/queue/${qid(id)}/printed`)),
  );

  tool(
    server,
    'delete_job',
    {
      title: 'Delete queue job',
      description: 'Soft-delete a queue job by id (sets deleted_at).',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => asText(await api.request('DELETE', `/api/v1/queue/${qid(id)}`)),
  );

  tool(
    server,
    'reset_queue',
    {
      title: 'Reset queue',
      description:
        'Reset the queue: clears printed_status for all non-deleted jobs so they return to the queued state.',
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async () => asText(await api.request('POST', '/api/v1/queue/reset')),
  );

  tool(
    server,
    'get_job_file',
    {
      title: 'Get queue job file metadata',
      description:
        "Report a stored job model file's metadata (size, content type). Does not return the raw bytes — download them via GET /api/queue/<id>/file.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const { size, contentType } = await api.request('GET', `/api/v1/queue/${qid(id)}/file`, {
        raw: true,
      });
      return asText({
        id,
        sizeBytes: size,
        contentType,
        downloadPath: `/api/queue/${id}/file`,
      });
    },
  );
}
