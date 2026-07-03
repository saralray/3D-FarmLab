import { logAuditEvent } from './auditApi';

// Admin-settable LAN address the H2-series Bambu printers use to fetch a
// staged print file back from slicer-proxy over HTTP (Settings → Slicer
// Upload). Backed by the app_settings key `printer_callback_url`; read
// directly by slicer-proxy — see buildTmpFileUrl in slicer-proxy/index.js.
export interface PrinterCallbackUrlSetting {
  url: string;
}

async function parseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

export async function fetchPrinterCallbackUrl(): Promise<PrinterCallbackUrlSetting> {
  const response = await fetch('/api/settings/printer-callback-url', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<PrinterCallbackUrlSetting>;
}

export async function savePrinterCallbackUrl(url: string): Promise<PrinterCallbackUrlSetting> {
  const response = await fetch('/api/settings/printer-callback-url', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  logAuditEvent('settings.printer-callback-url', undefined, { url });
  return response.json() as Promise<PrinterCallbackUrlSetting>;
}
