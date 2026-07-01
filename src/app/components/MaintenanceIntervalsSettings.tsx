import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { toast } from 'sonner';
import {
  fetchMaintenanceIntervals,
  saveMaintenanceIntervals,
  type MaintenanceInterval,
} from '../lib/maintenanceApi';

// Admin editor for the global default service intervals. These seed every new
// printer's schedule and backfill existing printers on the next worker pass.
// Rendered inside the Maintenance page's "Edit intervals" dialog.
export function MaintenanceIntervalsSettings({ onSaved }: { onSaved?: () => void } = {}) {
  const [intervals, setIntervals] = useState<MaintenanceInterval[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMaintenanceIntervals()
      .then((data) => {
        if (!cancelled) setIntervals(data);
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load maintenance intervals');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (index: number, patch: Partial<MaintenanceInterval>) => {
    setIntervals((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    setIntervals((prev) => prev.filter((_, i) => i !== index));
  };

  const addRow = () => {
    setIntervals((prev) => [...prev, { type: '', intervalHours: 100, description: '' }]);
  };

  const handleSave = async () => {
    const cleaned = intervals
      .map((row) => ({
        type: row.type.trim(),
        intervalHours: Number(row.intervalHours),
        description: row.description.trim(),
      }))
      .filter((row) => row.type && Number.isFinite(row.intervalHours) && row.intervalHours > 0);

    if (cleaned.length === 0) {
      toast.error('Add at least one valid interval (name + positive hours).');
      return;
    }

    setSaving(true);
    try {
      const saved = await saveMaintenanceIntervals(cleaned);
      setIntervals(saved);
      toast.success('Maintenance intervals saved');
      onSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save intervals');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Service tasks generated for every printer as it accumulates print hours. Changes seed new
        printers immediately and backfill existing printers within a few minutes.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          {intervals.map((row, index) => (
            <div key={index} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex-1 min-w-[8rem]">
                <Label className="text-xs">Task name</Label>
                <Input
                  value={row.type}
                  onChange={(event) => update(index, { type: event.target.value })}
                  placeholder="Lubrication"
                />
              </div>
              <div className="w-28">
                <Label className="text-xs">Every (hours)</Label>
                <Input
                  type="number"
                  min={1}
                  value={row.intervalHours}
                  onChange={(event) => update(index, { intervalHours: Number(event.target.value) })}
                />
              </div>
              <div className="flex-[2] min-w-[12rem]">
                <Label className="text-xs">Description</Label>
                <Input
                  value={row.description}
                  onChange={(event) => update(index, { description: event.target.value })}
                  placeholder="Lubricate rods / rails; check screws"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeRow(index)}
                aria-label="Remove interval"
              >
                <Trash2 className="size-4 text-red-500" />
              </Button>
            </div>
          ))}

          <div className="flex items-center justify-between">
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus className="size-4" />
              Add interval
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save intervals'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
