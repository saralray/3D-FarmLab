import { Link, useLocation } from 'react-router';
import { LayoutDashboard, List, BarChart3, Printer, LogOut, Settings } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/button';

export function Navigation() {
  const location = useLocation();
  const { user, logout } = useAuth();

  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/queue', label: 'Queue', icon: List },
    { path: '/analytics', label: 'Analytics', icon: BarChart3 },
  ];
  const adminNavItems = user?.role === 'admin'
    ? [{ path: '/settings', label: 'Settings', icon: Settings }]
    : [];

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <nav className="bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 w-64 h-screen flex flex-col">
      <div className="p-6 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Printer className="size-8 text-blue-500" />
          <div>
            <h1 className="font-bold text-xl dark:text-white">PrintFarm</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">Manager v1.0</p>
          </div>
        </div>
      </div>

      <div className="flex-1 p-4">
        <div className="space-y-1">
          {[...navItems, ...adminNavItems].map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                isActive(item.path)
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <item.icon className="size-5" />
              {item.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
        {user && (
          <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <div className="size-10 bg-blue-500 rounded-full flex items-center justify-center text-white font-semibold">
              {user.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium dark:text-white truncate">
                {user.name}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 capitalize">
                {user.role}
              </div>
            </div>
          </div>
        )}
        
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">Theme</span>
          <ThemeToggle />
        </div>

        {user && (
          <Button
            variant="outline"
            className="w-full"
            onClick={logout}
          >
            <LogOut className="size-4 mr-2" />
            Logout
          </Button>
        )}

        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>Developer</div>
          <div className="truncate">Saral Assabumrungrat CUD61</div>
        </div>
      </div>
    </nav>
  );
}
