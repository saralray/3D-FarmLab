import { QueueData } from '../types';

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

export async function fetchQueueJobs(): Promise<QueueData> {
  const response = await fetch('/api/queue', {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  return readJsonResponse<QueueData>(response);
}

export async function markQueueJobAsPrinted(jobId: string) {
  const response = await fetch(`/api/queue/${encodeURIComponent(jobId)}/printed`, {
    method: 'POST',
  });

  await readJsonResponse<void>(response);
}

export async function resetQueueJobStatuses() {
  const response = await fetch('/api/queue/reset', {
    method: 'POST',
  });

  await readJsonResponse<void>(response);
}
