import { Spool } from '../types';
import { Progress } from './ui/progress';
import { formatMaxTwoDecimals } from '../lib/numberFormat';

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
            className="size-4 rounded-full border-2 border-card shadow-sm"
            style={{ backgroundColor: spool.color }}
            title={`${spool.material} - ${formatMaxTwoDecimals(spool.remaining)}%`}
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
                className="size-5 rounded-full border-2 border-border shadow-sm"
                style={{ backgroundColor: spool.color }}
              />
              <span className="text-sm font-medium text-foreground">
                Spool {index + 1}
              </span>
              <span className="text-xs text-muted-foreground">
                {spool.material}
              </span>
            </div>
            <div className="text-sm font-medium text-foreground">
              {formatMaxTwoDecimals(spool.remaining)}%
            </div>
          </div>
          <Progress value={spool.remaining} className="h-2" />
          <div className="text-xs text-muted-foreground mt-1">
            {formatMaxTwoDecimals(spool.weight)}g remaining
          </div>
        </div>
      ))}
    </div>
  );
}
