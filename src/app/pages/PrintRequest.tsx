import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { ClipboardList, CheckCircle2, UploadCloud, ArrowLeft } from 'lucide-react';
import { Logo } from '../components/Logo';
import { submitPrintRequest } from '../lib/queueApi';

// File types accepted by the print-request upload — kept in sync with
// QUEUE_ALLOWED_FILE_EXT on the server.
const ACCEPTED_FILE_TYPES = '.stl,.3mf,.obj,.step,.stp,.gcode,.gco,.g,.zip';

export function PrintRequest() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [studentId, setStudentId] = useState('');
  const [course, setCourse] = useState('');
  const [email, setEmail] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Bumped on reset to remount the (uncontrolled) file input so it clears.
  const [fileInputKey, setFileInputKey] = useState(0);

  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setStudentId('');
    setCourse('');
    setEmail('');
    setQuantity(1);
    setNotes('');
    setFile(null);
    setFileInputKey((key) => key + 1);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!firstName.trim() && !lastName.trim() && !studentId.trim()) {
      toast.error('Please enter your name or student ID.');
      return;
    }
    if (!file) {
      toast.error('Please attach a model file to print.');
      return;
    }

    setSubmitting(true);
    try {
      await submitPrintRequest({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        studentId: studentId.trim(),
        course: course.trim(),
        email: email.trim(),
        quantity: Math.max(1, Number(quantity) || 1),
        notes: notes.trim(),
        file,
      });
      setSubmitted(true);
      resetForm();
      toast.success('Print request submitted!');
    } catch (error) {
      console.error('Failed to submit print request', error);
      toast.error(error instanceof Error ? error.message : 'Unable to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-950">
      <Card className="w-full max-w-xl p-6 dark:bg-gray-900 dark:border-gray-800 sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo />
          <h1 className="mt-4 flex items-center gap-2 text-2xl font-bold dark:text-white">
            <ClipboardList className="size-6 text-sky-600 dark:text-sky-400" />
            ฟอร์มขอพิมพ์งาน 3D Print
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Submit a 3D print request — upload your model file and our staff will queue it.
          </p>
        </div>

        {submitted ? (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <CheckCircle2 className="size-14 text-green-500" />
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
                  <ArrowLeft className="mr-2 size-4" />
                  Back to dashboard
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="firstName">First name</Label>
                <Input
                  id="firstName"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  placeholder="ชื่อ"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lastName">Last name</Label>
                <Input
                  id="lastName"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
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
                  onChange={(event) => setStudentId(event.target.value)}
                  placeholder="รหัสนักศึกษา"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="course">Course / Class</Label>
                <Input
                  id="course"
                  value={course}
                  onChange={(event) => setCourse(event.target.value)}
                  placeholder="วิชา / ชั้นเรียน"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email (optional)</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quantity">Quantity</Label>
                <Input
                  id="quantity"
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(event) => setQuantity(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Material, color, infill, or any special instructions"
                rows={3}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="file">Model file</Label>
              <Input
                id="file"
                key={fileInputKey}
                type="file"
                accept={ACCEPTED_FILE_TYPES}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Accepted: STL, 3MF, OBJ, STEP, G-code, ZIP. Max 50 MB.
              </p>
              {file && (
                <p className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
                  <UploadCloud className="size-3.5" />
                  {file.name} ({(file.size / (1024 * 1024)).toFixed(2)} MB)
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Submitting...' : 'Submit print request'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
