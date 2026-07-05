import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from './ui/dialog';
import { ClipboardList, CheckCircle2, UploadCloud, Plus, Trash2 } from 'lucide-react';
import { submitPrintRequest } from '../lib/queueApi';

const ACCEPTED_FILE_TYPES = '.stl,.3mf,.obj';
const ACCEPTED_EXTENSIONS = ['.stl', '.3mf', '.obj'];

interface FileEntry {
  id: number;
  file: File | null;
  quantity: number;
  notes: string;
  inputKey: number;
}

let nextId = 1;
function makeEntry(): FileEntry {
  return { id: nextId++, file: null, quantity: 1, notes: '', inputKey: nextId++ };
}

interface PrintRequestDialogProps {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function PrintRequestDialog({ children, open: controlledOpen, onOpenChange: controlledOnOpenChange }: PrintRequestDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [course, setCourse] = useState('');
  const [email, setEmail] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>(() => [makeEntry()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const hasFile = entries.some((e) => e.file !== null);
  const canSubmit =
    firstName.trim() !== '' &&
    lastName.trim() !== '' &&
    studentId.trim() !== '' &&
    course.trim() !== '' &&
    hasFile;

  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setStudentId('');
    setCourse('');
    setEmail('');
    setEntries([makeEntry()]);
  };

  const handleOpenChange = (next: boolean) => {
    if (isControlled) {
      controlledOnOpenChange?.(next);
    } else {
      setInternalOpen(next);
    }
    if (!next) {
      setSubmitted(false);
      resetForm();
    }
  };

  const updateEntry = (id: number, patch: Partial<FileEntry>) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const removeEntry = (id: number) =>
    setEntries((prev) => prev.filter((e) => e.id !== id));

  const addEntry = () => setEntries((prev) => [...prev, makeEntry()]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!firstName.trim() || !lastName.trim() || !studentId.trim() || !course.trim()) {
      toast.error('Please fill in your first name, last name, student ID, and course/class.');
      return;
    }

    const validEntries = entries.filter((e) => e.file !== null);
    if (validEntries.length === 0) {
      toast.error('Please attach at least one model file to print.');
      return;
    }

    for (const entry of validEntries) {
      const ext = entry.file!.name.slice(entry.file!.name.lastIndexOf('.')).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        toast.error(`Unsupported file type for "${entry.file!.name}". Allowed: STL, 3MF, OBJ.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      await Promise.all(
        validEntries.map((entry) =>
          submitPrintRequest({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            studentId: studentId.trim(),
            course: course.trim(),
            email: email.trim(),
            quantity: Math.max(1, Number(entry.quantity) || 1),
            notes: entry.notes.trim(),
            file: entry.file!,
          }),
        ),
      );
      setSubmitted(true);
      toast.success(
        validEntries.length === 1
          ? 'Print request submitted!'
          : `${validEntries.length} print requests submitted!`,
      );

      if (email.trim()) {
        const subject =
          validEntries.length === 1
            ? `3D Print Request Received — ${validEntries[0].file!.name}`
            : `3D Print Request Received — ${validEntries.length} files`;
        const body = [
          `Hi ${[firstName.trim(), lastName.trim()].filter(Boolean).join(' ') || studentId.trim()},`,
          '',
          'We have received your 3D print request:',
          ...validEntries.map(
            (e) =>
              `  • ${e.file!.name} (${Math.max(1, Number(e.quantity) || 1)} piece${Math.max(1, Number(e.quantity) || 1) === 1 ? '' : 's'})`,
          ),
          '',
          'Our staff will review and queue your job.',
          '',
          '— STEM Lab Print Farm',
        ].join('\n');
        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email.trim())}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(gmailUrl, '_blank', 'noopener,noreferrer');
      }

      resetForm();
    } catch (error) {
      console.error('Failed to submit print request', error);
      toast.error(error instanceof Error ? error.message : 'Unable to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="size-5 text-sky-600 dark:text-sky-400" />
            ฟอร์มขอพิมพ์งาน 3D Print
          </DialogTitle>
          <DialogDescription>
            Submit a 3D print request — upload your model file and our staff will queue it.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircle2 className="size-12 text-green-500" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">Request received</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your print request has been added to the queue.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => setSubmitted(false)}>
                Submit another request
              </Button>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pr-firstName">First name <span className="text-red-500">*</span></Label>
                <Input
                  id="pr-firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="ชื่อ"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pr-lastName">Last name <span className="text-red-500">*</span></Label>
                <Input
                  id="pr-lastName"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="นามสกุล"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pr-studentId">Student ID <span className="text-red-500">*</span></Label>
                <Input
                  id="pr-studentId"
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  placeholder="รหัสนักศึกษา"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pr-course">Course / Class <span className="text-red-500">*</span></Label>
                <Input
                  id="pr-course"
                  value={course}
                  onChange={(e) => setCourse(e.target.value)}
                  placeholder="วิชา / ชั้นเรียน"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pr-email">Email (optional)</Label>
              <Input
                id="pr-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-2">
              <Label>Model files</Label>
              <div className="space-y-3">
                {entries.map((entry, index) => (
                  <div
                    key={entry.id}
                    className="rounded-lg border border-border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-muted-foreground">
                        File {index + 1}
                      </span>
                      {entries.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeEntry(entry.id)}
                          className="text-red-500 hover:text-red-700 dark:text-red-400"
                          aria-label="Remove file"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </div>
                    <div className="flex gap-2 items-start">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs">File</Label>
                        <Input
                          key={entry.inputKey}
                          type="file"
                          accept={ACCEPTED_FILE_TYPES}
                          onChange={(e) =>
                            updateEntry(entry.id, { file: e.target.files?.[0] ?? null })
                          }
                        />
                        {entry.file && (
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <UploadCloud className="size-3.5" />
                            {entry.file.name} ({(entry.file.size / (1024 * 1024)).toFixed(2)} MB)
                          </p>
                        )}
                      </div>
                      <div className="w-24 space-y-1">
                        <Label htmlFor={`pr-qty-${entry.id}`} className="text-xs">
                          Pieces
                        </Label>
                        <Input
                          id={`pr-qty-${entry.id}`}
                          type="number"
                          min={1}
                          value={entry.quantity}
                          onChange={(e) =>
                            updateEntry(entry.id, { quantity: Number(e.target.value) })
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`pr-notes-${entry.id}`} className="text-xs">
                        Notes
                      </Label>
                      <Textarea
                        id={`pr-notes-${entry.id}`}
                        value={entry.notes}
                        onChange={(e) => updateEntry(entry.id, { notes: e.target.value })}
                        placeholder="Material, color, infill, or special instructions"
                        rows={2}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Accepted: STL, 3MF, OBJ. Max 50 MB per file.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addEntry}
                className="w-full"
              >
                <Plus className="size-4 mr-2" />
                Add another file
              </Button>
            </div>

            <Button type="submit" className="w-full" disabled={submitting || !canSubmit}>
              {submitting ? 'Submitting...' : 'Submit print request'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
