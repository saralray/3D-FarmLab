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
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';

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

/**
 * Touch-friendly bottom navigation shown on tablet/phone widths (below `lg`).
 * The desktop sidebar (`Navigation`) is hidden at the same breakpoint.
 */
export function BottomTabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  const adminNavItems =
    !PUBLIC_VIEWER_MODE && user?.role === 'admin'
      ? [
          { path: '/logs', label: 'Activity Log', icon: ScrollText },
          { path: '/settings', label: 'Settings', icon: Settings },
        ]
      : [];

  const moreIsActive = adminNavItems.some((item) => isActive(item.path));
  const showUserProfile = user && user.role !== 'viewer';

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const tabClass = (active: boolean) =>
    `flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors ${
      active
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
    }`;

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-gray-700 dark:bg-gray-900 lg:hidden"
        aria-label="Primary"
      >
        {primaryTabs.map((tab) => (
          <Link key={tab.path} to={tab.path} className={tabClass(isActive(tab.path))}>
            <tab.icon className="size-6" />
            <span>{tab.label}</span>
          </Link>
        ))}
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
              <div className="flex items-center gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
                <div className="flex size-10 items-center justify-center rounded-full bg-blue-500 font-semibold text-white">
                  {user.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium dark:text-white">{user.name}</div>
                  <div className="text-xs capitalize text-gray-500 dark:text-gray-400">
                    {user.role}
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1">
              {adminNavItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMoreOpen(false)}
                  className={`flex items-center rounded-lg px-4 py-3 transition-colors ${
                    isActive(item.path)
                      ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'
                  }`}
                >
                  <item.icon className="size-5" />
                  <span className="ml-3 whitespace-nowrap">{item.label}</span>
                </Link>
              ))}
              <Link
                to="/request"
                onClick={() => setMoreOpen(false)}
                className="flex w-full items-center rounded-lg px-4 py-3 text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <ClipboardList className="size-5" />
                <span className="ml-3 whitespace-nowrap">ฟอร์มขอพิมพ์งาน</span>
              </Link>
            </div>

            <div className="flex items-center justify-between border-t border-gray-200 pt-4 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-400">Theme</span>
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
