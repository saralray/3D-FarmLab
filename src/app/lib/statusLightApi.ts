// API helpers for the ESP32 per-printer status lights (see
// server/statusLightPresence.js and the /api/status-light routes in
// server/app.js). Mirrors the thin-fetch pattern of printersApi.ts.

export type LedPolarity = 'common_anode' | 'common_cathode';

export interface StatusLightProvisioningInfo {
  enabled: boolean;
  // Suggested default poll cadence and the status endpoint the device curls
  // (`{printerId}` placeholder). No secrets — the status read is public.
  pollIntervalMs?: number;
  statusPath?: string;
}

export interface StatusLightDevice {
  printerId: string;
  connected: boolean;
  lastSeen: string;
}

// The merged ESP32-C3 image the flash dialog writes at offset 0x0. Built from
// firmware/status-light/ (see its README) into public/firmware/, so Vite ships
// it in dist/ and it is served same-origin.
export const FIRMWARE_BIN_URL = '/firmware/status-light-esp32c3.bin';

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
  return response.json() as Promise<T>;
}

// Admin-only: the flash page's suggested poll settings.
export async function fetchStatusLightProvisioning(): Promise<StatusLightProvisioningInfo> {
  const response = await fetch('/api/status-light/provisioning', { cache: 'no-store' });
  return readJsonResponse<StatusLightProvisioningInfo>(response);
}

export async function fetchStatusLightDevices(): Promise<StatusLightDevice[]> {
  const response = await fetch('/api/status-light/devices', { cache: 'no-store' });
  const payload = await readJsonResponse<{ devices?: StatusLightDevice[] }>(response);
  return Array.isArray(payload.devices) ? payload.devices : [];
}

// The firmware image is optional repo content (it must be built with
// PlatformIO once); the card degrades to a notice when it is missing.
export async function checkFirmwareAvailable(): Promise<boolean> {
  try {
    const response = await fetch(FIRMWARE_BIN_URL, { method: 'HEAD', cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchFirmwareBinary(): Promise<ArrayBuffer> {
  const response = await fetch(FIRMWARE_BIN_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Firmware download failed with ${response.status}`);
  }
  return response.arrayBuffer();
}
