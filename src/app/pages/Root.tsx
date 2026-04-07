import { Outlet } from 'react-router';
import { Navigation } from '../components/Navigation';

export function Root() {
  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
      <Navigation />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}