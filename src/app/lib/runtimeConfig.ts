export const PUBLIC_VIEWER_MODE = import.meta.env.VITE_PUBLIC_VIEWER_MODE === 'true';
export const GOOGLE_FORM_URL =
  import.meta.env.VITE_GOOGLE_FORM_URL ||
  'https://docs.google.com/forms/d/e/1FAIpQLSdRR27bQDytT0xJNa2z6YSqksiclxtgoKxbaY-uANlAZGgeag/viewform?usp=dialog';

export const PUBLIC_VIEWER_USER = {
  id: 'public-viewer',
  name: 'Viewer',
  username: 'viewer',
  role: 'viewer' as const,
};
