import { ReactNode, Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { Root } from './pages/Root';
import { ErrorPage } from './pages/ErrorPage';
import { AdminRoute, ProtectedRoute, StaffRoute } from './components/ProtectedRoute';

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
const Maintenance = lazy(() =>
  import('./pages/Maintenance').then((module) => ({ default: module.Maintenance }))
);
const Settings = lazy(() =>
  import('./pages/Settings').then((module) => ({ default: module.Settings }))
);
const Logs = lazy(() =>
  import('./pages/Logs').then((module) => ({ default: module.Logs }))
);
const Login = lazy(() =>
  import('./pages/Login').then((module) => ({ default: module.Login }))
);
const PrintRequest = lazy(() =>
  import('./pages/PrintRequest').then((module) => ({ default: module.PrintRequest }))
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
    errorElement: <ErrorPage />,
  },
  // Legacy entry point: the app used to live at /admin, and home-screen apps
  // installed before the move still launch that path. Redirect it to /login so
  // an old install opens the login page instead of a dead "page not found".
  {
    path: '/admin',
    element: <Navigate to="/login" replace />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/request',
    element: withSuspense(<PrintRequest />),
    errorElement: <ErrorPage />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <Root />
      </ProtectedRoute>
    ),
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: withSuspense(<Dashboard />) },
      { path: 'printer/:id', element: withSuspense(<PrinterDetail />) },
      { path: 'queue', element: withSuspense(<Queue />) },
      { path: 'analytics', element: withSuspense(<Analytics />) },
      {
        path: 'maintenance',
        element: withSuspense(
          <StaffRoute>
            <Maintenance />
          </StaffRoute>
        ),
      },
      {
        path: 'settings',
        element: withSuspense(
          <AdminRoute>
            <Settings />
          </AdminRoute>
        ),
      },
      {
        path: 'logs',
        element: withSuspense(
          <AdminRoute>
            <Logs />
          </AdminRoute>
        ),
      },
      { path: '*', element: withSuspense(<NotFound />) },
    ],
  },
]);
