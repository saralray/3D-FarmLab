import { useRouteError } from 'react-router';
import { AlertTriangle, RefreshCw, LayoutDashboard } from 'lucide-react';
import { Logo } from '../components/Logo';
import { Button } from '../components/ui/button';
import { useBrandingSettings } from '../lib/settingsApi';

function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes('failed to fetch dynamically imported module') ||
    lower.includes('dynamically imported module') ||
    lower.includes('loading chunk') ||
    lower.includes('loading css chunk')
  );
}

export function ErrorPage() {
  const error = useRouteError();
  const { backgroundDataUrl } = useBrandingSettings();
  const chunkError = isChunkLoadError(error);

  return (
    <div className="relative isolate min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-white to-sky-100 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 p-4">
      {backgroundDataUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-center opacity-30"
          style={{ backgroundImage: `url(${backgroundDataUrl})` }}
        />
      )}

      <div className="relative z-10 w-full max-w-sm space-y-8 text-center">
        <div className="flex justify-center">
          <Logo baseHeight={80} alt="PrintFarm logo" />
        </div>

        <div className="space-y-3">
          <div className="flex justify-center">
            <span className="inline-flex items-center justify-center rounded-full bg-amber-100 p-3 dark:bg-amber-900/30">
              <AlertTriangle className="size-8 text-amber-500 dark:text-amber-400" />
            </span>
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            {chunkError ? 'New version available' : 'Something went wrong'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {chunkError
              ? 'The app has been updated. Reload the page to get the latest version.'
              : 'An unexpected error occurred. Try reloading the page.'}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Button
            onClick={() => window.location.reload()}
            className="w-full gap-2"
          >
            <RefreshCw className="size-4" />
            Reload page
          </Button>
          <Button
            variant="outline"
            onClick={() => { window.location.href = '/'; }}
            className="w-full gap-2"
          >
            <LayoutDashboard className="size-4" />
            Go to dashboard
          </Button>
        </div>

        {import.meta.env.DEV && error instanceof Error && (
          <details className="rounded-lg border border-border bg-muted/50 p-3 text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium select-none">Error details</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all font-mono">
              {error.stack ?? error.message}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
