import { Outlet } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Navigation } from '../components/Navigation';
import { BottomTabBar } from '../components/BottomTabBar';
import { PrinterStatusNotifier } from '../components/PrinterStatusNotifier';
import { MaintenanceNotifier } from '../components/MaintenanceNotifier';
import { useSidebar } from '../contexts/SidebarContext';
import { PrintersProvider } from '../contexts/PrintersContext';
import { PrinterEventsProvider } from '../contexts/PrinterEventsContext';
import { useBrandingSettings } from '../lib/settingsApi';

export function Root() {
  const { isCollapsed, toggleSidebar } = useSidebar();
  const { backgroundDataUrl } = useBrandingSettings();

  return (
    <PrintersProvider>
    <PrinterEventsProvider>
    <div className="relative isolate flex h-screen bg-background">
      {backgroundDataUrl && (
        // Faded layer behind the content (-z-10 under `isolate`) so the custom
        // image shows through the theme background rather than at full strength.
        // Opacity is theme-aware: the image blends against a near-white page in
        // light mode (so it needs to sit stronger to stay legible) versus a
        // near-black page in dark mode, where 40% already reads clearly.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-center opacity-70 dark:opacity-40"
          style={{ backgroundImage: `url(${backgroundDataUrl})` }}
        />
      )}
      <Navigation />
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{ left: isCollapsed ? 84 : 288 }}
        className="absolute top-24 z-30 hidden h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-[left,background-color,color] duration-300 ease-in-out hover:bg-muted lg:flex"
      >
        {isCollapsed ? (
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
        )}
      </button>
      <main className="flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+4rem)] lg:pb-0">
        <Outlet />
      </main>
      <BottomTabBar />
      <PrinterStatusNotifier />
      <MaintenanceNotifier />
    </div>
    </PrinterEventsProvider>
    </PrintersProvider>
  );
}
