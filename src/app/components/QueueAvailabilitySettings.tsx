import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import {
  fetchQueueAvailabilitySettings,
  saveQueueAvailabilitySettings,
  type QueueAvailabilitySettings as QueueAvailabilitySettingsValue,
} from '../lib/settingsApi';

const DAY_LABELS: { value: number; label: string }[] = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const DEFAULT_SETTINGS: QueueAvailabilitySettingsValue = {
  enabled: false,
  timezone: 'Asia/Bangkok',
  days: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  closedMessage: 'The print queue is currently closed. Please check back during open hours.',
};

// Admin-only "Queue Availability" card (Settings → System). Lets staff
// restrict the public /request form to a configurable time window instead of
// accepting submissions around the clock.
export function QueueAvailabilitySettings() {
  const [settings, setSettings] = useState<QueueAvailabilitySettingsValue>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetchQueueAvailabilitySettings()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch(() => {
        // Keep the bundled defaults on failure.
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const toggleDay = (day: number) => {
    setSettings((prev) => ({
      ...prev,
      days: prev.days.includes(day)
        ? prev.days.filter((d) => d !== day)
        : [...prev.days, day].sort(),
    }));
  };

  const handleSave = async () => {
    if (settings.days.length === 0) {
      toast.error('Select at least one day.');
      return;
    }
    if (settings.endTime <= settings.startTime) {
      toast.error('End time must be after start time.');
      return;
    }
    if (!settings.closedMessage.trim()) {
      toast.error('Closed message cannot be empty.');
      return;
    }

    setSaving(true);
    try {
      const saved = await saveQueueAvailabilitySettings(settings);
      setSettings(saved);
      toast.success('Queue availability settings saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium">Queue Availability</h3>
          <p className="text-sm text-muted-foreground">
            Restrict the public print-request form (<code>/request</code>) to a
            configurable time window. Outside it, students see a "queue closed"
            notice instead of the form.
          </p>
        </div>
        <Switch
          id="queue-availability-toggle"
          checked={settings.enabled}
          onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, enabled: checked }))}
          disabled={loading || saving}
        />
      </div>

      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label>Days open</Label>
          <div className="flex flex-wrap gap-2">
            {DAY_LABELS.map(({ value, label }) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={settings.days.includes(value) ? 'default' : 'outline'}
                onClick={() => toggleDay(value)}
                disabled={loading || saving}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="queue-availability-start">Start time</Label>
            <Input
              id="queue-availability-start"
              type="time"
              value={settings.startTime}
              onChange={(e) => setSettings((prev) => ({ ...prev, startTime: e.target.value }))}
              disabled={loading || saving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="queue-availability-end">End time</Label>
            <Input
              id="queue-availability-end"
              type="time"
              value={settings.endTime}
              onChange={(e) => setSettings((prev) => ({ ...prev, endTime: e.target.value }))}
              disabled={loading || saving}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="queue-availability-timezone">Timezone</Label>
          <Input
            id="queue-availability-timezone"
            value={settings.timezone}
            onChange={(e) => setSettings((prev) => ({ ...prev, timezone: e.target.value }))}
            placeholder="Asia/Bangkok"
            disabled={loading || saving}
          />
          <p className="text-xs text-muted-foreground">
            IANA timezone name, e.g. <code>Asia/Bangkok</code>.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="queue-availability-message">Closed message</Label>
          <Textarea
            id="queue-availability-message"
            value={settings.closedMessage}
            onChange={(e) => setSettings((prev) => ({ ...prev, closedMessage: e.target.value }))}
            rows={2}
            disabled={loading || saving}
          />
        </div>

        <Button onClick={() => void handleSave()} disabled={loading || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}
