import { useEffect, useState } from 'react';
import { mockPrinters } from '../data/mockData';
import { Printer } from '../types';
import { PrinterCard } from '../components/PrinterCard';
import { Activity, AlertCircle, CheckCircle, Pause, Plus, WifiOff } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Alert } from '../components/ui/alert';
import { useAuth } from '../contexts/AuthContext';

const PRINTER_STORAGE_KEY = 'printfarm_printers';
const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function readStoredPrinters(): Printer[] {
  const rawValue = localStorage.getItem(PRINTER_STORAGE_KEY);
  if (!rawValue) {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(mockPrinters));
    return mockPrinters;
  }

  try {
    const parsed = JSON.parse(rawValue) as Printer[];
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid printers');
    }
    return parsed;
  } catch {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(mockPrinters));
    return mockPrinters;
  }
}

export function Dashboard() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const { user, users, createUser } = useAuth();
  const [printerName, setPrinterName] = useState('');
  const [printerModel, setPrinterModel] = useState('');
  const [printerIpAddress, setPrinterIpAddress] = useState('');
  const [printerLocation, setPrinterLocation] = useState('');
  const [printerStatus, setPrinterStatus] = useState<'idle' | 'offline' | 'paused' | 'error'>('idle');
  const [printerFormError, setPrinterFormError] = useState('');
  const [printerFormSuccess, setPrinterFormSuccess] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('operator');
  const [userFormError, setUserFormError] = useState('');
  const [userFormSuccess, setUserFormSuccess] = useState('');
  const [isCreatingUser, setIsCreatingUser] = useState(false);

  useEffect(() => {
    setPrinters(readStoredPrinters());
  }, []);

  useEffect(() => {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(printers));
  }, [printers]);

  // Simulate real-time updates
  useEffect(() => {
    if (printers.length === 0) {
      return;
    }

    const interval = setInterval(() => {
      setPrinters((prev) =>
        prev.map((printer) => {
          if (printer.status === 'printing' && printer.currentJob) {
            const newProgress = Math.min(printer.progress + Math.random() * 2, 100);
            const timeReduction = Math.floor(Math.random() * 3);
            
            return {
              ...printer,
              progress: Math.round(newProgress),
              currentJob: {
                ...printer.currentJob,
                progress: Math.round(newProgress),
                timeRemaining: Math.max(0, printer.currentJob.timeRemaining - timeReduction),
              },
            };
          }
          return printer;
        })
      );
    }, 3000);

    return () => clearInterval(interval);
  }, [printers.length]);

  const stats = {
    total: printers.length,
    printing: printers.filter((p) => p.status === 'printing').length,
    idle: printers.filter((p) => p.status === 'idle').length,
    error: printers.filter((p) => p.status === 'error').length,
    paused: printers.filter((p) => p.status === 'paused').length,
    offline: printers.filter((p) => p.status === 'offline').length,
  };

  const statCards = [
    { label: 'Printing', value: stats.printing, icon: Activity, color: 'text-blue-500', bgColor: 'bg-blue-50 dark:bg-blue-900/30' },
    { label: 'Idle', value: stats.idle, icon: CheckCircle, color: 'text-green-500', bgColor: 'bg-green-50 dark:bg-green-900/30' },
    { label: 'Paused', value: stats.paused, icon: Pause, color: 'text-yellow-500', bgColor: 'bg-yellow-50 dark:bg-yellow-900/30' },
    { label: 'Error', value: stats.error, icon: AlertCircle, color: 'text-red-500', bgColor: 'bg-red-50 dark:bg-red-900/30' },
    { label: 'Offline', value: stats.offline, icon: WifiOff, color: 'text-gray-500', bgColor: 'bg-gray-50 dark:bg-gray-800' },
  ];

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setUserFormError('');
    setUserFormSuccess('');
    setIsCreatingUser(true);

    try {
      const result = await createUser({ name, username, password, role });
      if (!result.success) {
        setUserFormError(result.error ?? 'Unable to create user.');
        return;
      }

      setName('');
      setUsername('');
      setPassword('');
      setRole('operator');
      setUserFormSuccess('User added successfully.');
    } finally {
      setIsCreatingUser(false);
    }
  };

  const handleCreatePrinter = (event: React.FormEvent) => {
    event.preventDefault();
    setPrinterFormError('');
    setPrinterFormSuccess('');

    if (user?.role !== 'admin') {
      setPrinterFormError('Only admins can add printers.');
      return;
    }

    const normalizedName = printerName.trim();
    const normalizedModel = printerModel.trim();
    const normalizedIpAddress = printerIpAddress.trim();
    const normalizedLocation = printerLocation.trim();

    if (!normalizedName || !normalizedModel || !normalizedIpAddress || !normalizedLocation) {
      setPrinterFormError('Name, model, IP address, and location are required.');
      return;
    }

    if (!IPV4_PATTERN.test(normalizedIpAddress)) {
      setPrinterFormError('Enter a valid IPv4 address.');
      return;
    }

    if (printers.some((printer) => printer.ipAddress === normalizedIpAddress)) {
      setPrinterFormError('That IP address is already assigned to another printer.');
      return;
    }

    const nextPrinter: Printer = {
      id: crypto.randomUUID(),
      name: normalizedName,
      model: normalizedModel,
      ipAddress: normalizedIpAddress,
      status: printerStatus,
      temperature: {
        nozzle: printerStatus === 'offline' ? 0 : 25,
        bed: printerStatus === 'offline' ? 0 : 24,
      },
      progress: 0,
      location: normalizedLocation,
      lastMaintenance: new Date().toISOString().slice(0, 10),
      totalPrintTime: 0,
      successRate: 100,
    };

    setPrinters((prev) => [nextPrinter, ...prev]);
    setPrinterName('');
    setPrinterModel('');
    setPrinterIpAddress('');
    setPrinterLocation('');
    setPrinterStatus('idle');
    setPrinterFormSuccess('Printer added successfully.');
  };

  const handleRemovePrinter = (printerId: string) => {
    if (user?.role !== 'admin') {
      return;
    }

    setPrinters((prev) => prev.filter((printer) => printer.id !== printerId));
    setPrinterFormSuccess('Printer removed successfully.');
    setPrinterFormError('');
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2 dark:text-white">Print Farm Dashboard</h1>
        <p className="text-gray-600 dark:text-gray-400">Monitor and manage all printers in real-time</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.label} className={`p-4 ${stat.bgColor} border-0`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-gray-600 dark:text-gray-400">{stat.label}</div>
                <div className="text-2xl font-bold mt-1 dark:text-white">{stat.value}</div>
              </div>
              <stat.icon className={`size-8 ${stat.color}`} />
            </div>
          </Card>
        ))}
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-4 dark:text-white">All Printers ({stats.total})</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {printers.map((printer) => (
            <PrinterCard
              key={printer.id}
              printer={printer}
              canManage={user?.role === 'admin'}
              onRemove={handleRemovePrinter}
            />
          ))}
        </div>
      </div>

      {user?.role === 'admin' && (
        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <div className="flex items-center gap-2">
                <Plus className="size-5 text-blue-500" />
                <h2 className="text-xl font-semibold dark:text-white">Manage Printers</h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Add new printers to the farm and remove retired machines. These changes are limited to admins.
              </p>
            </div>

            <form onSubmit={handleCreatePrinter} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="printer-name">Printer Name</Label>
                  <Input
                    id="printer-name"
                    value={printerName}
                    onChange={(event) => setPrinterName(event.target.value)}
                    placeholder="Bambu Lab A1 Mini"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="printer-model">Model</Label>
                  <Input
                    id="printer-model"
                    value={printerModel}
                    onChange={(event) => setPrinterModel(event.target.value)}
                    placeholder="Bambu Lab A1 Mini"
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="printer-ip-address">Printer IP</Label>
                  <Input
                    id="printer-ip-address"
                    value={printerIpAddress}
                    onChange={(event) => setPrinterIpAddress(event.target.value.trim())}
                    placeholder="192.168.1.120"
                    inputMode="numeric"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="printer-location">Location</Label>
                  <Input
                    id="printer-location"
                    value={printerLocation}
                    onChange={(event) => setPrinterLocation(event.target.value)}
                    placeholder="Rack D - Slot 1"
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Initial Status</Label>
                  <Select
                    value={printerStatus}
                    onValueChange={(value) =>
                      setPrinterStatus(value as 'idle' | 'offline' | 'paused' | 'error')
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select printer status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="idle">Idle</SelectItem>
                      <SelectItem value="offline">Offline</SelectItem>
                      <SelectItem value="paused">Paused</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {printerFormError && (
                <Alert variant="destructive" className="py-2">
                  {printerFormError}
                </Alert>
              )}

              {printerFormSuccess && (
                <Alert className="py-2">
                  {printerFormSuccess}
                </Alert>
              )}

              <Button type="submit">Add Printer</Button>
            </form>
          </Card>

          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <h2 className="text-xl font-semibold dark:text-white">Add User</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Admins can add operator and viewer accounts without exposing credentials on the login screen.
              </p>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-user-name">Full Name</Label>
                  <Input
                    id="new-user-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Jane Operator"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="new-user-username">Username</Label>
                  <Input
                    id="new-user-username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.trimStart())}
                    placeholder="jane"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-user-password">Temporary Password</Label>
                  <Input
                    id="new-user-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label>User Role</Label>
                  <Select
                    value={role}
                    onValueChange={(value) => setRole(value as 'admin' | 'operator' | 'viewer')}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="operator">Operator</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {userFormError && (
                <Alert variant="destructive" className="py-2">
                  {userFormError}
                </Alert>
              )}

              {userFormSuccess && (
                <Alert className="py-2">
                  {userFormSuccess}
                </Alert>
              )}

              <Button type="submit" disabled={isCreatingUser}>
                {isCreatingUser ? 'Adding user...' : 'Add User'}
              </Button>
            </form>
          </Card>

          <Card className="p-6 dark:bg-gray-900 dark:border-gray-800">
            <div className="mb-5">
              <h2 className="text-xl font-semibold dark:text-white">User Directory</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Current app users and their roles.
              </p>
            </div>

            <div className="space-y-3">
              {users.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-950"
                >
                  <div>
                    <div className="font-medium dark:text-white">{account.name}</div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      @{account.username}
                    </div>
                  </div>
                  <div className="text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                    {account.role}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
