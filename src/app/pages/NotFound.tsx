import { useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { AlertCircle } from 'lucide-react';

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <AlertCircle className="size-16 text-gray-400 mx-auto mb-4" />
        <h1 className="text-3xl font-bold mb-2 dark:text-white">404 - Page Not Found</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">The page you're looking for doesn't exist.</p>
        <Button onClick={() => navigate('/')}>
          Back to Dashboard
        </Button>
      </div>
    </div>
  );
}