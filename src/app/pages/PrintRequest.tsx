import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  CheckCircle2,
  UploadCloud,
  LayoutDashboard,
  Plus,
  Trash2,
} from 'lucide-react';
import { Logo } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { submitPrintRequest } from '../lib/queueApi';
import { useBrandingSettings } from '../lib/settingsApi';

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

export function PrintRequest() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [course, setCourse] = useState('');
  const [email, setEmail] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>(() => [makeEntry()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { backgroundDataUrl } = useBrandingSettings();

  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setStudentId('');
    setCourse('');
    setEmail('');
    setEntries([makeEntry()]);
  };

  const updateEntry = (id: number, patch: Partial<FileEntry>) =>
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const removeEntry = (id: number) =>
    setEntries((prev) => prev.filter((e) => e.id !== id));

  const addEntry = () => setEntries((prev) => [...prev, makeEntry()]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!firstName.trim() && !lastName.trim() && !studentId.trim()) {
      toast.error('Please enter your name or student ID.');
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
    <div className="relative isolate min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Branding background — identical to Root.tsx */}
      {backgroundDataUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-center opacity-70 dark:opacity-40"
          style={{ backgroundImage: `url(${backgroundDataUrl})` }}
        />
      )}

      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/60 bg-white/70 backdrop-blur-md dark:border-gray-800/60 dark:bg-gray-900/70">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <Logo baseHeight={32} />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="outline" size="sm" className="bg-white/80 dark:bg-gray-900/80">
              <Link to="/">
                <LayoutDashboard className="mr-2 size-4" />
                Dashboard
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="relative z-0 px-4 py-10">
        <div className="mx-auto w-full max-w-2xl">

          {/* Page heading */}
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-bold tracking-tight dark:text-white">
              ฟอร์มขอพิมพ์งาน 3D Print
            </h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Upload your model file — our staff will review and queue it for printing.
            </p>
          </div>

          {/* Card */}
          <div className="rounded-2xl border border-white/80 bg-white/80 shadow-xl backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-900/80">
            {submitted ? (
              <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
                <CheckCircle2 className="size-16 text-green-500" />
                <div>
                  <h2 className="text-xl font-semibold dark:text-white">Request received</h2>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    Your print request has been added to the queue.
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button type="button" onClick={() => setSubmitted(false)}>
                    Submit another request
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/">
                      <LayoutDashboard className="mr-2 size-4" />
                      Go to dashboard
                    </Link>
                  </Button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-6 p-8">
                {/* Personal info */}
                <section className="space-y-4">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                    Your info
                  </h2>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="firstName">First name</Label>
                      <Input
                        id="firstName"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="ชื่อ"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="lastName">Last name</Label>
                      <Input
                        id="lastName"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        placeholder="นามสกุล"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="studentId">Student ID</Label>
                      <Input
                        id="studentId"
                        value={studentId}
                        onChange={(e) => setStudentId(e.target.value)}
                        placeholder="รหัสนักศึกษา"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="course">Course / Class</Label>
                      <Input
                        id="course"
                        value={course}
                        onChange={(e) => setCourse(e.target.value)}
                        placeholder="วิชา / ชั้นเรียน"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email <span className="text-gray-400">(optional)</span></Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                    />
                  </div>
                </section>

                <hr className="border-gray-200 dark:border-gray-700" />

                {/* File entries */}
                <section className="space-y-4">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                    Model files
                  </h2>
                  <div className="space-y-3">
                    {entries.map((entry, index) => (
                      <div
                        key={entry.id}
                        className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-3 dark:border-gray-700 dark:bg-gray-800/50"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                            File {index + 1}
                          </span>
                          {entries.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeEntry(entry.id)}
                              className="rounded p-1 text-red-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                              aria-label="Remove file"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          )}
                        </div>
                        <div className="flex gap-3 items-start">
                          <div className="flex-1 space-y-1.5">
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
                              <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                <UploadCloud className="size-3.5 shrink-0" />
                                {entry.file.name}{' '}
                                <span className="text-gray-400">
                                  ({(entry.file.size / (1024 * 1024)).toFixed(2)} MB)
                                </span>
                              </p>
                            )}
                          </div>
                          <div className="w-24 space-y-1.5">
                            <Label htmlFor={`qty-${entry.id}`} className="text-xs">
                              Pieces
                            </Label>
                            <Input
                              id={`qty-${entry.id}`}
                              type="number"
                              min={1}
                              value={entry.quantity}
                              onChange={(e) =>
                                updateEntry(entry.id, { quantity: Number(e.target.value) })
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`notes-${entry.id}`} className="text-xs">
                            Notes
                          </Label>
                          <Textarea
                            id={`notes-${entry.id}`}
                            value={entry.notes}
                            onChange={(e) => updateEntry(entry.id, { notes: e.target.value })}
                            placeholder="Material, color, infill, or special instructions"
                            rows={2}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    Accepted: STL, 3MF, OBJ · Max 50 MB per file
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
                </section>

                <Button type="submit" className="w-full" size="lg" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit print request'}
                </Button>
              </form>
            )}
          </div>

          <p className="mt-6 text-center text-xs text-gray-400 dark:text-gray-600">
            Saral Assabumrungrat — 3D-FarmLab — &copy; 2026
          </p>
        </div>
      </main>
    </div>
  );
}
