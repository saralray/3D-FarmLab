import { Outlet } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Navigation } from '../components/Navigation';
import { useSidebar } from '../contexts/SidebarContext';

export function Root() {
  const { isCollapsed, toggleSidebar } = useSidebar();

  return (
    <div className="relative flex h-screen bg-gray-50 dark:bg-gray-950">
      <Navigation />
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{ left: isCollapsed ? 84 : 288 }}
        className="absolute top-24 z-30 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-md transition-[left,background-color,color] duration-300 ease-in-out hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        {isCollapsed ? (
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
        )}
      </button>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
