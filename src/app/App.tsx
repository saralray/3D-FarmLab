import { Component, type ReactNode } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes.tsx';
import { ThemeProvider } from './components/ThemeProvider';
import { BrandingApplier } from './components/BrandingApplier';
import { AuthProvider } from './contexts/AuthContext';
import { SidebarProvider } from './contexts/SidebarContext';
import { Toaster } from './components/ui/sonner';
import defaultLogo from './assets/printer-logo.svg';

// Catches errors that escape all route-level boundaries (broken providers,
// the router itself failing to mount, etc.). Uses no hooks or context since
// those may be what's broken.
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (!this.state.error) return this.props.children;

    const isChunkError =
      this.state.error.message.toLowerCase().includes('failed to fetch dynamically imported module') ||
      this.state.error.message.toLowerCase().includes('loading chunk');

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #f1f5f9 0%, #ffffff 50%, #e0f2fe 100%)',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          padding: '1rem',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 360, width: '100%' }}>
          <img
            src={defaultLogo}
            alt="PrintFarm logo"
            style={{ height: 72, width: 'auto', marginBottom: '1.5rem', filter: 'brightness(0)' }}
          />
          <div
            style={{
              background: '#fef3c7',
              borderRadius: '50%',
              width: 56,
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 1rem',
              fontSize: 28,
            }}
          >
            ⚠️
          </div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', color: '#0f172a' }}>
            {isChunkError ? 'New version available' : 'Something went wrong'}
          </h1>
          <p style={{ color: '#64748b', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            {isChunkError
              ? 'The app has been updated. Reload to get the latest version.'
              : 'An unexpected error occurred. Try reloading the page.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              display: 'block',
              width: '100%',
              padding: '0.625rem 1rem',
              background: '#0f172a',
              color: '#fff',
              border: 'none',
              borderRadius: '0.5rem',
              fontSize: '0.9rem',
              fontWeight: 500,
              cursor: 'pointer',
              marginBottom: '0.75rem',
            }}
          >
            Reload page
          </button>
          <button
            onClick={() => { window.location.href = '/'; }}
            style={{
              display: 'block',
              width: '100%',
              padding: '0.625rem 1rem',
              background: 'transparent',
              color: '#0f172a',
              border: '1px solid #cbd5e1',
              borderRadius: '0.5rem',
              fontSize: '0.9rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Go to dashboard
          </button>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <RootErrorBoundary>
      <ThemeProvider>
        <BrandingApplier />
        <AuthProvider>
          <SidebarProvider>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
          </SidebarProvider>
        </AuthProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  );
}
