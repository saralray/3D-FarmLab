import { Printer } from '../types';

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
  const response = await fetch('/api/printers');
  return readJsonResponse<Printer[]>(response);
}

export async function savePrinter(printer: Printer) {
  const response = await fetch('/api/printers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(printer),
  });

  await readJsonResponse<void>(response);
}

export async function removePrinter(printerId: string) {
  const response = await fetch(`/api/printers/${encodeURIComponent(printerId)}`, {
    method: 'DELETE',
  });

  await readJsonResponse<void>(response);
}
