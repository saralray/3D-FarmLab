import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { LayoutDashboard, List, BarChart3, LogOut, Settings, ClipboardList, ScrollText, Music } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/button';
import { PUBLIC_VIEWER_MODE } from '../lib/runtimeConfig';
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
  const { isCollapsed, toggleSidebar } = useSidebar();
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

  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/queue', label: 'Queue', icon: List },
    { path: '/analytics', label: 'Analytics', icon: BarChart3 },
  ];
  const adminNavItems = !PUBLIC_VIEWER_MODE && user?.role === 'admin'
    ? [
        { path: '/logs', label: 'Activity Log', icon: ScrollText },
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
      className={`relative hidden h-screen h-[100dvh] flex-shrink-0 flex-col border-r border-gray-200 bg-white transition-[width] duration-300 ease-in-out lg:flex dark:border-gray-700 dark:bg-gray-900 ${
        isCollapsed ? 'w-[84px]' : 'w-72'
      }`}
    >
      <div className="p-6 border-b border-gray-200 dark:border-gray-700">
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
                  : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'
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
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Manager v1.0
            </p>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-1">
          {[...navItems, ...adminNavItems].map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center rounded-lg px-4 py-3 transition-colors ${
                isActive(item.path)
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <item.icon className="size-5" />
              {!isCollapsed && <span className="ml-3 whitespace-nowrap">{item.label}</span>}
            </Link>
          ))}
          <Link
            to="/request"
            className="flex w-full items-center rounded-lg px-4 py-3 text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <ClipboardList className="size-5" />
            {!isCollapsed && (
              <span className="ml-3 whitespace-nowrap">ฟอร์มขอพิมพ์งาน</span>
            )}
          </Link>
        </div>
      </div>

      <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
        {showUserProfile && (
          <div className={`flex items-center rounded-lg bg-gray-50 p-3 dark:bg-gray-800 ${isCollapsed ? 'justify-center' : 'gap-3'}`}>
            <div className="flex size-10 items-center justify-center rounded-full bg-blue-500 font-semibold text-white">
              {user.name.charAt(0)}
            </div>
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium dark:text-white">
                  {user.name}
                </div>
                <div className="text-xs capitalize text-gray-500 dark:text-gray-400">
                  {user.role}
                </div>
              </div>
            )}
          </div>
        )}
        
        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'}`}>
          {!isCollapsed && <span className="text-sm text-gray-600 dark:text-gray-400">Theme</span>}
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
          <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
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
