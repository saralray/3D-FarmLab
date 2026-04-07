import { Spool } from '../types';
import { Progress } from './ui/progress';

interface SpoolIndicatorProps {
  spools: Spool[];
  compact?: boolean;
}

export function SpoolIndicator({ spools, compact = false }: SpoolIndicatorProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {spools.map((spool) => (
          <div
            key={spool.id}
            className="size-4 rounded-full border-2 border-white dark:border-gray-800 shadow-sm"
            style={{ backgroundColor: spool.color }}
            title={`${spool.material} - ${spool.remaining}%`}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {spools.map((spool, index) => (
        <div key={spool.id}>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <div
                className="size-5 rounded-full border-2 border-gray-200 dark:border-gray-600 shadow-sm"
                style={{ backgroundColor: spool.color }}
              />
              <span className="text-sm font-medium dark:text-white">
                Spool {index + 1}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {spool.material}
              </span>
            </div>
            <div className="text-sm font-medium dark:text-white">
              {spool.remaining}%
            </div>
          </div>
          <Progress value={spool.remaining} className="h-2" />
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {spool.weight}g remaining
          </div>
        </div>
      ))}
    </div>
  );
}
