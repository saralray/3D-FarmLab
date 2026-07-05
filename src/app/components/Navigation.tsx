import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { LayoutDashboard, List, BarChart3, LogOut, Settings, ClipboardList, ScrollText, Music, Wrench, Wifi, Boxes } from 'lucide-react';
import { PrintRequestDialog } from './PrintRequestDialog';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/button';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
import { isReadOnlyRole } from '../lib/usersApi';
import { useBrandingSettings } from '../lib/settingsApi';
import { Logo } from './Logo';
import { useSidebar } from '../contexts/SidebarContext';
import { startAudioRgbSync, stopAudioRgbSync, type AudioRgbSource } from '../lib/audioRgbSync';
import stemlabLogo from '../assets/printer-logo.svg';

export function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };
  const { isCollapsed, toggleSidebar, hasUnfinishedQueue, hasPendingMaintenance } = useSidebar();
  const [formOpen, setFormOpen] = useState(false);
  const [logoWave, setLogoWave] = useState(false);
  const [musicSync, setMusicSync] = useState(false);
  const [musicSource, setMusicSource] = useState<AudioRgbSource | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('rgb-wave-active', logoWave);
    if (!logoWave) {
      stopAudioRgbSync();
      setMusicSync(false);
    }
    return () => {
      document.documentElement.classList.remove('rgb-wave-active');
      stopAudioRgbSync();
    };
  }, [logoWave]);

  const toggleMusicSync = async () => {
    if (musicSync) {
      stopAudioRgbSync();
      setMusicSync(false);
      return;
    }
    try {
      const source = await startAudioRgbSync(() => setMusicSync(false));
      setMusicSource(source);
      setMusicSync(true);
    } catch {
      // Capture refused or unavailable — the steady wave keeps running.
    }
  };
  const { logoDataUrl, logoScale } = useBrandingSettings();
  const logoBaseHeight = isCollapsed ? 36 : 56;
  // The RGB-wave effect masks an animated gradient with the logo shape, so it
  // needs an image URL — use the uploaded logo or fall back to the bundled mark.
  const logoMaskUrl = logoDataUrl || stemlabLogo;

  // Maintenance is an operator/admin tool — hidden from the public viewer and from
  // read-only (viewer/student) sessions, matching the StaffRoute guard.
  const canSeeMaintenance = !PUBLIC_VIEWER_MODE && !!user && !isReadOnlyRole(user.role);
  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/queue', label: 'Queue', icon: List },
    { path: '/analytics', label: 'Analytics', icon: BarChart3 },
    ...(canSeeMaintenance ? [{ path: '/maintenance', label: 'Maintenance', icon: Wrench }] : []),
    ...(canSeeMaintenance ? [{ path: '/filament-station', label: 'Filament Station', icon: Boxes }] : []),
  ];
  const adminNavItems = !PUBLIC_VIEWER_MODE && user?.role === 'admin'
    ? [
        { path: '/logs', label: 'Activity Log', icon: ScrollText },
        { path: '/network', label: 'Network', icon: Wifi },
        { path: '/settings', label: 'Settings', icon: Settings },
      ]
    : [];
  const showUserProfile = user && user.role !== 'viewer';

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <nav
      className={`relative hidden h-screen h-[100dvh] flex-shrink-0 flex-col border-r border-border bg-card transition-[width] duration-300 ease-in-out lg:flex ${
        isCollapsed ? 'w-[84px]' : 'w-72'
      }`}
    >
      <div className="p-6 border-b border-border">
        <div className="space-y-3 overflow-hidden">
          <button
            type="button"
            onClick={() => setLogoWave((prev) => !prev)}
            aria-pressed={logoWave}
            aria-label="Toggle logo RGB wave effect"
            className={`block cursor-pointer ${logoWave ? 'logo-rgb-glow' : ''}`}
          >
            {logoWave ? (
              <div
                role="img"
                aria-label="CUD Stemlab PrintFarm logo"
                className="logo-rgb-wave aspect-square max-w-full"
                style={{
                  height: Math.round(logoBaseHeight * (logoScale || 1)),
                  WebkitMaskImage: `url(${logoMaskUrl})`,
                  maskImage: `url(${logoMaskUrl})`,
                  WebkitMaskRepeat: 'no-repeat',
                  maskRepeat: 'no-repeat',
                  WebkitMaskPosition: 'center',
                  maskPosition: 'center',
                  WebkitMaskSize: 'contain',
                  maskSize: 'contain',
                }}
              />
            ) : (
              <Logo baseHeight={logoBaseHeight} alt="CUD Stemlab PrintFarm logo" />
            )}
          </button>
          {logoWave && (
            <button
              type="button"
              onClick={toggleMusicSync}
              aria-pressed={musicSync}
              title={
                musicSync
                  ? `Music sync on (${musicSource === 'system' ? 'system audio' : 'microphone'}) — click to stop`
                  : 'Sync RGB to music: pick a screen/tab and tick "Share audio", or allow the microphone'
              }
              className={`flex w-full items-center rounded-lg px-2 py-1.5 text-xs transition-colors ${
                isCollapsed ? 'justify-center' : 'gap-2'
              } ${
                musicSync
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <Music className={`size-4 shrink-0 ${musicSync ? 'animate-pulse' : ''}`} />
              {!isCollapsed && (
                <span className="truncate">
                  {musicSync
                    ? `Synced: ${musicSource === 'system' ? 'system audio' : 'microphone'}`
                    : 'Sync to music'}
                </span>
              )}
            </button>
          )}
          {!isCollapsed && (
            <p className="text-xs text-muted-foreground">
              Manager v1.0
            </p>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-1">
          {[...navItems, ...adminNavItems].map((item) => {
            const showAlertDot =
              (item.path === '/queue' && hasUnfinishedQueue) ||
              (item.path === '/maintenance' && hasPendingMaintenance);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`relative flex items-center rounded-lg px-4 py-3 transition-colors ${
                  isActive(item.path)
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <item.icon className="size-5" />
                {!isCollapsed && <span className="ml-3 whitespace-nowrap">{item.label}</span>}
                {showAlertDot && (
                  <span
                    className="absolute right-3 top-1/2 size-2 -translate-y-1/2 rounded-full bg-red-500"
                    aria-hidden="true"
                  />
                )}
              </Link>
            );
          })}
          <a
            href="/request"
            onClick={(e) => {
              if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
                e.preventDefault();
                setFormOpen(true);
              }
            }}
            className="flex w-full items-center rounded-lg px-4 py-3 text-muted-foreground transition-colors hover:bg-muted"
          >
            <ClipboardList className="size-5" />
            {!isCollapsed && (
              <span className="ml-3 whitespace-nowrap">ฟอร์มขอพิมพ์งาน</span>
            )}
          </a>
          <PrintRequestDialog open={formOpen} onOpenChange={setFormOpen} />
        </div>
      </div>

      <div className="p-4 border-t border-border space-y-3">
        {showUserProfile && (
          <div className={`flex items-center rounded-lg bg-muted p-3 ${isCollapsed ? 'justify-center' : 'gap-3'}`}>
            <div className="flex size-10 items-center justify-center rounded-full bg-blue-500 font-semibold text-white">
              {user.name.charAt(0)}
            </div>
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {user.name}
                </div>
                <div className="text-xs capitalize text-muted-foreground">
                  {user.role}
                </div>
              </div>
            )}
          </div>
        )}
        
        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'}`}>
          {!isCollapsed && <span className="text-sm text-muted-foreground">Theme</span>}
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <NotificationBell />
          </div>
        </div>

        {user && !PUBLIC_VIEWER_MODE && user.role !== 'viewer' && (
          <Button
            variant="outline"
            className={isCollapsed ? 'w-full px-0' : 'w-full'}
            onClick={handleLogout}
          >
            <LogOut className="size-4 mr-2" />
            {!isCollapsed && 'Logout'}
          </Button>
        )}

        {!isCollapsed && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>{PUBLIC_VIEWER_MODE ? 'Access' : 'Developer'}</div>
            {PUBLIC_VIEWER_MODE ? (
              <div className="truncate">Public Viewer Mode</div>
            ) : (
              <div className="truncate">Saral Assabumrungrat CUD61</div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
