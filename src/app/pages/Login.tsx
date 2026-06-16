import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Navigate, Link } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { Eye, EyeOff, ClipboardList } from 'lucide-react';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
import { fetchAdminConfigured } from '../lib/adminCredentialApi';
import { Logo } from '../components/Logo';

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
  const isAdminPage = location.pathname === '/admin';

  // null = still checking; true/false = whether an admin password has been set.
  // While null we hold off rendering either form to avoid a flicker.
  const [adminConfigured, setAdminConfigured] = useState<boolean | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');

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
