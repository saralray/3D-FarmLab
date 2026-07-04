// Admin backup & restore (Settings → System). "Download backup" is a plain
// same-origin GET the browser handles itself (see BackupSettings.tsx); this
// module only covers the restore upload, which needs a fetch + response body.

export interface RestoredTable {
  name: string;
  rowCount: number;
}

interface RestoreResult {
  ok: boolean;
  tables?: RestoredTable[];
  error?: string;
}

async function readError(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error;
  } catch {
    return undefined;
  }
}

// Uploads a backup archive (the raw .zip bytes as the request body, not
// multipart — matching the /api/v1/queue/:id/file PUT pattern) and restores
// it. This is destructive server-side (every backed-up table is truncated and
// replaced) — the caller is responsible for confirming with the admin first.
export async function restoreBackup(file: File): Promise<RestoreResult> {
  try {
    const response = await fetch('/api/admin/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
    if (!response.ok) {
      return { ok: false, error: await readError(response) };
    }
    const payload = (await response.json()) as { tables?: RestoredTable[] };
    return { ok: true, tables: payload.tables };
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
}
