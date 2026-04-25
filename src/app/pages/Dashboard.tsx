import { useEffect, useState } from 'react';
import { mockPrinters } from '../data/mockData';
import { Printer } from '../types';
import { PrinterCard } from '../components/PrinterCard';
import { Activity, AlertCircle, CheckCircle, Pause, WifiOff } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Alert } from '../components/ui/alert';
import { useAuth } from '../contexts/AuthContext';
import { normalizePrinter } from '../lib/printerProfiles';
import { fetchPrinters, savePrinter } from '../lib/printersApi';

export function Dashboard() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [draggedPrinterId, setDraggedPrinterId] = useState<string | null>(null);
  const { user } = useAuth();
  const [printerFormError, setPrinterFormError] = useState('');
  const [printerFormSuccess, setPrinterFormSuccess] = useState('');

  const persistPrinterOrder = async (nextPrinters: Printer[]) => {
    await Promise.all(
      nextPrinters.map((printer, index) =>
        savePrinter({
          ...printer,
          sortOrder: index,
        })
      )
    );
  };

  useEffect(() => {
    let isCancelled = false;

    const refreshFromServer = async () => {
      try {
        const nextPrinters = (await fetchPrinters()).map(normalizePrinter);
        if (!isCancelled) {
          setPrinters(nextPrinters);
          setPrinterFormError('');
        }
      } catch {
        if (!isCancelled) {
          setPrinters((currentPrinters) =>
            currentPrinters.length > 0 ? currentPrinters : mockPrinters.map(normalizePrinter)
          );
          setPrinterFormError('Unable to load printer status from the server.');
        }
      }
    };

    refreshFromServer();
    const interval = window.setInterval(refreshFromServer, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const stats = {
    total: printers.length,
    online: printers.filter((p) => p.status !== 'offline').length,
    printing: printers.filter((p) => p.status === 'printing').length,
    error: printers.filter((p) => p.status === 'error').length,
    paused: printers.filter((p) => p.status === 'paused').length,
    offline: printers.filter((p) => p.status === 'offline').length,
  };

  const statCards = [
    { label: 'Online', value: stats.online, icon: CheckCircle, color: 'text-green-500', bgColor: 'bg-green-50 dark:bg-green-900/30' },
    { label: 'Printing', value: stats.printing, icon: Activity, color: 'text-blue-500', bgColor: 'bg-blue-50 dark:bg-blue-900/30' },
    { label: 'Paused', value: stats.paused, icon: Pause, color: 'text-yellow-500', bgColor: 'bg-yellow-50 dark:bg-yellow-900/30' },
    { label: 'Error', value: stats.error, icon: AlertCircle, color: 'text-red-500', bgColor: 'bg-red-50 dark:bg-red-900/30' },
    { label: 'Offline', value: stats.offline, icon: WifiOff, color: 'text-gray-500', bgColor: 'bg-gray-50 dark:bg-gray-800' },
  ];

  const handlePrinterDragStart = (printerId: string) => {
    if (user?.role !== 'admin') {
      return;
    }

    setDraggedPrinterId(printerId);
  };

  const handlePrinterDragOver = (targetPrinterId: string) => {
    if (user?.role !== 'admin' || !draggedPrinterId || draggedPrinterId === targetPrinterId) {
      return;
    }

    setPrinters((prev) => {
      const draggedIndex = prev.findIndex((printer) => printer.id === draggedPrinterId);
      const targetIndex = prev.findIndex((printer) => printer.id === targetPrinterId);

      if (draggedIndex === -1 || targetIndex === -1) {
        return prev;
      }

      const nextPrinters = [...prev];
      const [draggedPrinter] = nextPrinters.splice(draggedIndex, 1);
      nextPrinters.splice(targetIndex, 0, draggedPrinter);

      return nextPrinters.map((printer, index) => ({
        ...printer,
        sortOrder: index,
      }));
    });
  };

  const handlePrinterDragEnd = async () => {
    if (user?.role !== 'admin' || !draggedPrinterId) {
      return;
    }

    const nextPrinters = printers.map((printer, index) => ({
      ...printer,
      sortOrder: index,
    }));

    setDraggedPrinterId(null);

    try {
      await persistPrinterOrder(nextPrinters);
      setPrinterFormSuccess('Dashboard order updated.');
      setPrinterFormError('');
    } catch (error) {
      setPrinterFormError(error instanceof Error ? error.message : 'Unable to save dashboard order.');
      await loadPrinters();
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold mb-2 dark:text-white">CUD Stemlab PrintFarm</h1>
        <p className="text-gray-600 dark:text-gray-400">Monitor and manage all printers in real-time</p>
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
              canViewSensitiveInfo={user?.role !== 'viewer'}
              onDragStart={handlePrinterDragStart}
              onDragOver={handlePrinterDragOver}
              onDragEnd={handlePrinterDragEnd}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
