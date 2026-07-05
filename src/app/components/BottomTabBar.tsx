import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  LayoutDashboard,
  List,
  BarChart3,
  MoreHorizontal,
  LogOut,
  Settings,
  ClipboardList,
  ScrollText,
  Wrench,
  Boxes,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { PrintRequestDialog } from './PrintRequestDialog';
import { useAuth } from '../contexts/AuthContext';
import { useSidebar } from '../contexts/SidebarContext';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
import { isReadOnlyRole } from '../lib/usersApi';

interface TabConfig {
  path: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const primaryTabs: TabConfig[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/queue', label: 'Queue', icon: List },
  { path: '/analytics', label: 'Analytics', icon: BarChart3 },
];

// Operator/admin-only tab, appended for staff sessions (see StaffRoute).
const maintenanceTab: TabConfig = { path: '/maintenance', label: 'Maintenance', icon: Wrench };

/**
 * Touch-friendly bottom navigation shown on tablet/phone widths (below `lg`).
 * The desktop sidebar (`Navigation`) is hidden at the same breakpoint.
 */
export function BottomTabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { hasUnfinishedQueue, hasPendingMaintenance } = useSidebar();
  const [moreOpen, setMoreOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const canSeeMaintenance = !PUBLIC_VIEWER_MODE && !!user && !isReadOnlyRole(user.role);
  const visibleTabs = canSeeMaintenance ? [...primaryTabs, maintenanceTab] : primaryTabs;

  // Staff-only (operator/admin), same gate as Maintenance — surfaced in the
  // "More" sheet rather than a primary tab so the bottom bar doesn't get
  // crowded. This is the only way to reach it from a phone, which matters
  // here since Filament Station's NFC scan/write is meant to be used on one.
  const staffNavItems = canSeeMaintenance ? [{ path: '/filament-station', label: 'Filament Station', icon: Boxes }] : [];

  const adminNavItems =
    !PUBLIC_VIEWER_MODE && user?.role === 'admin'
      ? [
          { path: '/logs', label: 'Activity Log', icon: ScrollText },
          { path: '/settings', label: 'Settings', icon: Settings },
        ]
      : [];

  const moreIsActive = [...staffNavItems, ...adminNavItems].some((item) => isActive(item.path));
  const showUserProfile = user && user.role !== 'viewer';

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const tabClass = (active: boolean) =>
    `flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors ${
      active
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label="Primary"
      >
        {visibleTabs.map((tab) => {
          const showAlertDot =
            (tab.path === '/queue' && hasUnfinishedQueue) ||
            (tab.path === '/maintenance' && hasPendingMaintenance);
          return (
            <Link key={tab.path} to={tab.path} className={tabClass(isActive(tab.path))}>
              <span className="relative">
                <tab.icon className="size-6" />
                {showAlertDot && (
                  <span
                    className="absolute -right-1 -top-1 size-2 rounded-full bg-red-500"
                    aria-hidden="true"
                  />
                )}
              </span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={tabClass(moreIsActive || moreOpen)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
        >
          <MoreHorizontal className="size-6" />
          <span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl pb-[max(env(safe-area-inset-bottom),1rem)] lg:hidden"
        >
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>

          <div className="space-y-4 px-4">
            {showUserProfile && (
              <div className="flex items-center gap-3 rounded-lg bg-muted p-3">
                <div className="flex size-10 items-center justify-center rounded-full bg-blue-500 font-semibold text-white">
                  {user.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{user.name}</div>
                  <div className="text-xs capitalize text-muted-foreground">
                    {user.role}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1">
              {[...staffNavItems, ...adminNavItems].map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMoreOpen(false)}
                  className={`flex items-center rounded-lg px-4 py-3 transition-colors ${
                    isActive(item.path)
                      ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <item.icon className="size-5" />
                  <span className="ml-3 whitespace-nowrap">{item.label}</span>
                </Link>
              ))}
              <a
                href="/request"
                onClick={(e) => {
                  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
                    e.preventDefault();
                    setMoreOpen(false);
                    setFormOpen(true);
                  }
                }}
                className="flex w-full items-center rounded-lg px-4 py-3 text-muted-foreground transition-colors hover:bg-muted"
              >
                <ClipboardList className="size-5" />
                <span className="ml-3 whitespace-nowrap">ฟอร์มขอพิมพ์งาน</span>
              </a>
              <PrintRequestDialog open={formOpen} onOpenChange={setFormOpen} />
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <span className="text-sm text-muted-foreground">Theme</span>
              <div className="flex items-center gap-1">
                <ThemeToggle />
                <NotificationBell />
              </div>
            </div>

            {user && !PUBLIC_VIEWER_MODE && user.role !== 'viewer' && (
              <Button variant="outline" className="w-full" onClick={handleLogout}>
                <LogOut className="mr-2 size-4" />
                Logout
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
