import { ReactNode, Suspense, lazy } from 'react';
import { createBrowserRouter } from 'react-router';
import { Root } from './pages/Root';
import { ProtectedRoute } from './components/ProtectedRoute';

const Dashboard = lazy(() =>
  import('./pages/Dashboard').then((module) => ({ default: module.Dashboard }))
);
const PrinterDetail = lazy(() =>
  import('./pages/PrinterDetail').then((module) => ({ default: module.PrinterDetail }))
);
const Queue = lazy(() =>
  import('./pages/Queue').then((module) => ({ default: module.Queue }))
);
const Analytics = lazy(() =>
  import('./pages/Analytics').then((module) => ({ default: module.Analytics }))
);
const Login = lazy(() =>
  import('./pages/Login').then((module) => ({ default: module.Login }))
);
const NotFound = lazy(() =>
  import('./pages/NotFound').then((module) => ({ default: module.NotFound }))
);

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 text-gray-600 dark:bg-gray-950 dark:text-gray-400">
      Loading...
    </div>
  );
}

function withSuspense(component: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{component}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: withSuspense(<Login />),
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <Root />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: withSuspense(<Dashboard />) },
      { path: 'printer/:id', element: withSuspense(<PrinterDetail />) },
      { path: 'queue', element: withSuspense(<Queue />) },
      { path: 'analytics', element: withSuspense(<Analytics />) },
      { path: '*', element: withSuspense(<NotFound />) },
    ],
  },
]);
