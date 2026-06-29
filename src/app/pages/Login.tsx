import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Navigate, Link } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { Eye, EyeOff, ClipboardList, KeyRound } from 'lucide-react';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
import { fetchAdminConfigured } from '../lib/adminCredentialApi';
import { fetchEnabledOAuthProviders, type EnabledOAuthProviders } from '../lib/oauthApi';
import { Logo } from '../components/Logo';

// Human-readable messages for the ?oauth_error codes the callback can redirect
// back with (see server/app.js /api/auth/:provider/callback).
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  not_configured: 'Single sign-on is not configured.',
  denied: 'Sign-in was cancelled or denied.',
  exchange_failed: 'Could not complete sign-in. Please try again.',
  unverified_email: 'Your account email is not verified.',
  domain_not_allowed: 'Your account is not allowed to sign in here.',
  saml_invalid: 'The SSO response could not be verified. Please try again.',
  saml_not_provisioned: 'Your account is not provisioned for access here.',
};

export function Login() {
  if (PUBLIC_VIEWER_MODE) {
    return <Navigate to="/" replace />;
  }

  const navigate = useNavigate();
  const location = useLocation();
  const { user, isLoading: isAuthLoading, login, loginAsViewer, setupAdminPassword } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isAdminPage = location.pathname === '/login';

  // null = still checking; true/false = whether an admin password has been set.
  // While null we hold off rendering either form to avoid a flicker.
  const [adminConfigured, setAdminConfigured] = useState<boolean | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [oauthProviders, setOauthProviders] = useState<EnabledOAuthProviders>({
    google: false,
    microsoft: false,
    adfs: false,
    saml: false,
  });

  const from = (location.state as any)?.from?.pathname || '/';

  useEffect(() => {
    if (!isAdminPage) {
      return;
    }
    let cancelled = false;
    fetchAdminConfigured().then((configured) => {
      if (!cancelled) {
        setAdminConfigured(configured);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isAdminPage]);

  // Only show an SSO button for a provider that is actually configured + enabled.
  useEffect(() => {
    let cancelled = false;
    fetchEnabledOAuthProviders().then((providers) => {
      if (!cancelled) {
        setOauthProviders(providers);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Surface the ?oauth_error the callback may have redirected back with, then
  // strip it from the URL so a reload doesn't show it again.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const errorCode = params.get('oauth_error');
    if (!errorCode) {
      return;
    }
    toast.error(OAUTH_ERROR_MESSAGES[errorCode] ?? 'Sign-in failed.');
    params.delete('oauth_error');
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ''}`, { replace: true });
  }, [location.search, location.pathname, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const result = await login(username, password, rememberMe);
      if (result.success) {
        navigate(from, { replace: true });
      } else {
        toast.error(result.error ?? 'Unable to sign in.');
      }
    } catch {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    try {
      const result = await setupAdminPassword(password);
      if (result.success) {
        toast.success('Admin password set.');
        navigate(from, { replace: true });
      } else {
        toast.error(result.error ?? 'Unable to set the admin password.');
        // Another tab/device may have set it first — re-check so we switch to
        // the login form instead of looping on a now-closed setup endpoint.
        setAdminConfigured(await fetchAdminConfigured());
      }
    } catch {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // A saved (remembered) login is restored during auth bootstrap. Once a real
  // user is signed in, don't show the login form again — send them on to the app
  // until they explicitly log out. Viewers stay on the login screen so they can
  // still sign in as admin.
  if (!isAuthLoading && user && user.role !== 'viewer') {
    return <Navigate to={from} replace />;
  }

  const showSetup = isAdminPage && adminConfigured === false;

  const handleViewerLogin = async () => {
    setIsLoading(true);

    try {
      const result = await loginAsViewer();
      if (result.success) {
        navigate(from, { replace: true });
      } else {
        toast.error(result.error ?? 'Unable to continue as viewer.');
      }
    } catch {
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-white to-sky-100 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-4">
            <Logo baseHeight={96} alt="CUD Stemlab PrintFarm logo" />
          </div>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {showSetup
              ? 'Set the admin password to finish setup'
              : isAdminPage
                ? 'Admin sign in'
                : 'Choose how to enter the print farm system'}
          </p>
        </div>

        <Card className="p-6 dark:bg-gray-800 dark:border-gray-700">
          <div className="space-y-4">
            {showSetup ? (
              <form onSubmit={handleSetup} className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  No admin password is set yet. Choose one now — it is stored on the
                  server, so this only happens once for the whole print farm.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="setup-password">New admin password</Label>
                  <div className="relative">
                    <Input
                      id="setup-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="setup-confirm">Confirm password</Label>
                  <Input
                    id="setup-confirm"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Re-enter the password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? 'Saving...' : 'Set admin password'}
                </Button>
              </form>
            ) : isAdminPage ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    placeholder="Enter your username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.trimStart())}
                    required
                    autoComplete="username"
                    spellCheck={false}
                    autoCapitalize="none"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="remember-me"
                    checked={rememberMe}
                    onCheckedChange={(checked) => setRememberMe(checked === true)}
                  />
                  <Label htmlFor="remember-me" className="cursor-pointer font-normal">
                    Keep me signed in
                  </Label>
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? 'Signing in...' : 'Login as Admin'}
                </Button>
              </form>
            ) : (
              <div className="space-y-4">
                <Button
                  type="button"
                  className="h-14 w-full text-base"
                  disabled={isLoading}
                  onClick={handleViewerLogin}
                >
                  {isLoading ? 'Opening...' : 'Printfarm Dashboard'}
                </Button>
              </div>
            )}

            {(oauthProviders.google || oauthProviders.microsoft || oauthProviders.adfs || oauthProviders.saml) &&
              !showSetup && (
              <>
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                  <span className="text-xs uppercase tracking-wide text-gray-400">or</span>
                  <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
                </div>
                {oauthProviders.saml && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-14 w-full gap-3 text-base"
                    disabled={isLoading}
                    onClick={() => {
                      window.location.href = '/api/auth/saml/start';
                    }}
                  >
                    <KeyRound className="size-5" />
                    Sign in with SSO
                  </Button>
                )}
                {oauthProviders.adfs && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-14 w-full gap-3 text-base"
                    disabled={isLoading}
                    onClick={() => {
                      window.location.href = '/api/auth/adfs/start';
                    }}
                  >
                    <KeyRound className="size-5" />
                    Sign in with STEMLab SSO
                  </Button>
                )}
                {oauthProviders.google && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-14 w-full gap-3 text-base"
                    disabled={isLoading}
                    onClick={() => {
                      window.location.href = '/api/auth/google/start';
                    }}
                  >
                    <svg className="size-5" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.45.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.77.43 3.45 1.18 4.95l3.66-2.84Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
                      />
                    </svg>
                    Sign in with Google
                  </Button>
                )}
                {oauthProviders.microsoft && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-14 w-full gap-3 text-base"
                    disabled={isLoading}
                    onClick={() => {
                      window.location.href = '/api/auth/microsoft/start';
                    }}
                  >
                    <svg className="size-5" viewBox="0 0 23 23" aria-hidden="true">
                      <path fill="#F25022" d="M1 1h10v10H1z" />
                      <path fill="#7FBA00" d="M12 1h10v10H12z" />
                      <path fill="#00A4EF" d="M1 12h10v10H1z" />
                      <path fill="#FFB900" d="M12 12h10v10H12z" />
                    </svg>
                    Sign in with Microsoft
                  </Button>
                )}
              </>
            )}

            <Button
              asChild
              variant="outline"
              className="h-14 w-full border-sky-200 bg-sky-100 text-base text-sky-800 hover:bg-sky-200 hover:text-sky-900 dark:border-sky-800 dark:bg-sky-900/80 dark:text-sky-100 dark:hover:bg-sky-900"
            >
              <Link to="/request">
                <ClipboardList className="mr-2 size-5" />
                ฟอร์มขอพิมพ์งาน
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
