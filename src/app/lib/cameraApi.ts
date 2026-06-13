// Live-view camera health, reported by the server's camera hub (one persistent
// ffmpeg per Bambu H2/X1 printer, fanned out to all viewers + a supervisor that
// restarts a stalled feed). Used by the webcam health badge on the detail page.
export interface CameraHealth {
  printerId: string;
  name?: string;
  status: 'idle' | 'starting' | 'running' | 'error';
  online: boolean;
  viewers: number;
  lastFrameAgeMs: number | null;
  frames: number;
  restarts: number;
  uptimeMs: number;
  lastError: string | null;
}

export async function fetchCameraHealth(printerId: string): Promise<CameraHealth> {
  const response = await fetch(
    `/api/printers/${encodeURIComponent(printerId)}/camera/health`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Camera health request failed with ${response.status}`);
  }
  return response.json() as Promise<CameraHealth>;
}
