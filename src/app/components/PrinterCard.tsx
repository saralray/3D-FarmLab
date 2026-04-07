import { Printer } from '../types';
import { useNavigate } from 'react-router';
import { Activity, AlertCircle, CheckCircle, Pause, Trash2, WifiOff } from 'lucide-react';
import { Card } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { SpoolIndicator } from './SpoolIndicator';
import { Button } from './ui/button';

interface PrinterCardProps {
  printer: Printer;
  canManage?: boolean;
  onRemove?: (printerId: string) => void;
}

export function PrinterCard({ printer, canManage = false, onRemove }: PrinterCardProps) {
  const navigate = useNavigate();

  const getStatusIcon = () => {
    switch (printer.status) {
      case 'printing':
        return <Activity className="size-4" />;
      case 'idle':
        return <CheckCircle className="size-4" />;
      case 'error':
        return <AlertCircle className="size-4" />;
      case 'offline':
        return <WifiOff className="size-4" />;
      case 'paused':
        return <Pause className="size-4" />;
    }
  };

  const getStatusColor = () => {
    switch (printer.status) {
      case 'printing':
        return 'bg-blue-500';
      case 'idle':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      case 'offline':
        return 'bg-gray-500';
      case 'paused':
        return 'bg-yellow-500';
    }
  };

  const getStatusBadgeVariant = (): "default" | "secondary" | "destructive" | "outline" => {
    switch (printer.status) {
      case 'error':
        return 'destructive';
      case 'idle':
        return 'outline';
      default:
        return 'secondary';
    }
  };

  return (
    <Card
      className="p-4 cursor-pointer hover:shadow-lg transition-shadow dark:bg-gray-800 dark:border-gray-700"
      onClick={() => navigate(`/printer/${printer.id}`)}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold mb-1 dark:text-white">{printer.name}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">{printer.model}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">{printer.ipAddress}</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && onRemove && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(printer.id);
              }}
              aria-label={`Remove ${printer.name}`}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          {printer.spools && <SpoolIndicator spools={printer.spools} compact />}
          <Badge variant={getStatusBadgeVariant()} className="flex items-center gap-1">
            {getStatusIcon()}
            {printer.status}
          </Badge>
        </div>
      </div>

      {printer.status === 'printing' || printer.status === 'paused' ? (
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-400 truncate flex-1 mr-2">
                {printer.currentJob?.filename}
              </span>
              <span className="font-medium dark:text-white">{printer.progress}%</span>
            </div>
            <Progress value={printer.progress} className="h-2" />
          </div>

          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <div className="text-gray-500 dark:text-gray-400">Nozzle</div>
              <div className="font-medium dark:text-white">{printer.temperature.nozzle}°C</div>
            </div>
            <div>
              <div className="text-gray-500 dark:text-gray-400">Bed</div>
              <div className="font-medium dark:text-white">{printer.temperature.bed}°C</div>
            </div>
            <div>
              <div className="text-gray-500 dark:text-gray-400">ETA</div>
              <div className="font-medium dark:text-white">{printer.currentJob?.timeRemaining}m</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="py-2">
          <div className={`w-full h-2 rounded-full ${getStatusColor()} opacity-20 mb-3`} />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-gray-500 dark:text-gray-400">Location</div>
              <div className="font-medium text-sm dark:text-white">{printer.location}</div>
            </div>
            <div>
              <div className="text-gray-500 dark:text-gray-400">Success Rate</div>
              <div className="font-medium dark:text-white">{printer.successRate}%</div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
