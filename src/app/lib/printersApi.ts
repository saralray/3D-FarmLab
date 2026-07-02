import { Printer } from '../types';
import { logAuditEvent } from './auditApi';

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore invalid JSON error bodies.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function fetchPrinters(): Promise<Printer[]> {
  const response = await fetch('/api/printers', {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  return readJsonResponse<Printer[]>(response);
}

// Used by PrintersContext's recurring poll (not the one-shot reads above): the
// server answers with a 304 and no body when the fleet state hasn't changed
// since the last poll's ETag (see sendJsonWithEtag in server/app.js) — the
// common case for a farm that's mostly idle between polls. `printers: null`
// signals "unchanged, keep what you have."
export async function fetchPrintersIfChanged(
  etag: string | null,
): Promise<{ printers: Printer[] | null; etag: string | null }> {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (etag) {
    headers['If-None-Match'] = etag;
  }
  const response = await fetch('/api/printers', { cache: 'no-store', headers });
  if (response.status === 304) {
    return { printers: null, etag };
  }
  const printers = await readJsonResponse<Printer[]>(response);
  return { printers, etag: response.headers.get('ETag') };
}

export async function fetchPrinter(printerId: string): Promise<Printer | null> {
  const response = await fetch(`/api/printers/${encodeURIComponent(printerId)}`, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  if (response.status === 404) {
    return null;
  }

  return readJsonResponse<Printer>(response);
}

// `silent` skips the audit entry for bulk writes (e.g. dashboard reorder, which
// saves every printer at once); the caller logs a single summarizing event.
export async function savePrinter(printer: Printer, options: { silent?: boolean } = {}) {
  const response = await fetch('/api/printers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(printer),
  });

  await readJsonResponse<void>(response);
  if (!options.silent) {
    logAuditEvent('printer.save', printer.name, { id: printer.id, profile: printer.profile });
  }
}

export async function removePrinter(printerId: string) {
  const response = await fetch(`/api/printers/${encodeURIComponent(printerId)}`, {
    method: 'DELETE',
  });

  await readJsonResponse<void>(response);
  logAuditEvent('printer.delete', printerId);
}
