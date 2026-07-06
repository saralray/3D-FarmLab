import { QueueData } from '../types';
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

export interface QueueAvailabilityStatus {
  open: boolean;
  message?: string;
}

// Public read-only check of the admin-configured submission window (Settings
// → System → Queue Availability). Used by the /request page to show a closed
// notice before the form is even shown.
export async function fetchQueueAvailability(): Promise<QueueAvailabilityStatus> {
  const response = await fetch('/api/queue/availability', { cache: 'no-store' });
  return readJsonResponse<QueueAvailabilityStatus>(response);
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

export interface PrintRequestPayload {
  firstName: string;
  lastName: string;
  studentId: string;
  course: string;
  email: string;
  quantity: number;
  notes: string;
  file: File;
}

// Submit the in-app print-request form. The model file is uploaded as
// multipart/form-data and stored in the database server-side.
export async function submitPrintRequest(
  payload: PrintRequestPayload,
): Promise<{ id: string }> {
  const formData = new FormData();
  formData.append('firstName', payload.firstName);
  formData.append('lastName', payload.lastName);
  formData.append('studentId', payload.studentId);
  formData.append('course', payload.course);
  formData.append('email', payload.email);
  formData.append('quantity', String(payload.quantity));
  formData.append('notes', payload.notes);
  formData.append('file', payload.file);

  const response = await fetch('/api/queue/submit', {
    method: 'POST',
    body: formData,
  });

  return readJsonResponse<{ id: string }>(response);
}

export async function markQueueJobAsPrinted(jobId: string) {
  const response = await fetch(`/api/queue/${encodeURIComponent(jobId)}/printed`, {
    method: 'POST',
  });

  await readJsonResponse<void>(response);
  logAuditEvent('queue.mark_printed', jobId);
}

export async function deleteQueueJob(jobId: string) {
  const response = await fetch(`/api/queue/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });

  await readJsonResponse<void>(response);
  logAuditEvent('queue.delete', jobId);
}
