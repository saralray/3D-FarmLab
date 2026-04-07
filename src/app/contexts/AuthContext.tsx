import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

interface User {
  id: string;
  name: string;
  username: string;
  role: UserRole;
}

interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<LoginResult>;
  createUser: (input: CreateUserInput) => Promise<CreateUserResult>;
  logout: () => void;
  isLoading: boolean;
  users: User[];
}

interface LoginResult {
  success: boolean;
  error?: string;
  lockedUntil?: number;
}

interface CreateUserInput {
  name: string;
  username: string;
  password: string;
  role: UserRole;
}

interface CreateUserResult {
  success: boolean;
  error?: string;
}

interface StoredSession {
  user: User;
  expiresAt: number;
}

interface FailedAttemptState {
  count: number;
  firstFailedAt: number;
  lockedUntil?: number;
}

interface StoredUserRecord extends User {
  passwordHash: string;
}

type UserRole = 'admin' | 'operator' | 'viewer';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_STORAGE_KEY = 'printfarm_session';
const ATTEMPT_STORAGE_KEY = 'printfarm_auth_attempts';
const USER_STORAGE_KEY = 'printfarm_users';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

const DEFAULT_USERS: StoredUserRecord[] = [
  {
    id: '1',
    username: 'admin',
    passwordHash: '247be42a8460b48531c8e35c3e494a0c86dd70b65b4f234ed4bc73474b76d994',
    name: 'Stemlab Admin',
    role: 'admin' as const,
  },
];

function sanitizeUser(record: StoredUserRecord): User {
  return {
    id: record.id,
    name: record.name,
    username: record.username,
    role: record.role,
  };
}

function readStoredUsers(): StoredUserRecord[] {
  const rawValue = localStorage.getItem(USER_STORAGE_KEY);
  if (!rawValue) {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_USERS));
    return DEFAULT_USERS;
  }

  try {
    const parsed = JSON.parse(rawValue) as StoredUserRecord[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Invalid stored users');
    }

    const validUsers = parsed.filter(
      (candidate) =>
        candidate &&
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.username === 'string' &&
        typeof candidate.passwordHash === 'string' &&
        ['admin', 'operator', 'viewer'].includes(candidate.role)
    );

    if (validUsers.length === 0) {
      throw new Error('No valid users');
    }

    return validUsers;
  } catch {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(DEFAULT_USERS));
    return DEFAULT_USERS;
  }
}

function writeStoredUsers(users: StoredUserRecord[]) {
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(users));
}

function readFailedAttempts(): FailedAttemptState | null {
  const rawValue = localStorage.getItem(ATTEMPT_STORAGE_KEY);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as FailedAttemptState;
    if (typeof parsed.count !== 'number' || typeof parsed.firstFailedAt !== 'number') {
      localStorage.removeItem(ATTEMPT_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(ATTEMPT_STORAGE_KEY);
    return null;
  }
}

function writeFailedAttempts(state: FailedAttemptState | null) {
  if (!state) {
    localStorage.removeItem(ATTEMPT_STORAGE_KEY);
    return;
  }

  localStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(state));
}

function readStoredSession(): StoredSession | null {
  const rawValue = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as StoredSession;
    if (!parsed.user || typeof parsed.expiresAt !== 'number') {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    if (parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function writeStoredSession(user: User | null) {
  if (!user) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  const session: StoredSession = {
    user,
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

async function hashPassword(password: string) {
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(password)
  );

  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedUsers = readStoredUsers();
    setUsers(storedUsers.map(sanitizeUser));

    const storedSession = readStoredSession();
    if (storedSession) {
      setUser(storedSession.user);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (!user) {
      return;
    }

    const interval = window.setInterval(() => {
      const storedSession = readStoredSession();
      if (!storedSession) {
        setUser(null);
      }
    }, 60 * 1000);

    return () => window.clearInterval(interval);
  }, [user]);

  const login = async (username: string, password: string): Promise<LoginResult> => {
    const normalizedUsername = username.trim().toLowerCase();
    const trimmedPassword = password.trim();
    const now = Date.now();
    const failedAttempts = readFailedAttempts();

    if (failedAttempts?.lockedUntil && failedAttempts.lockedUntil > now) {
      return {
        success: false,
        error: 'Too many failed attempts. Try again later.',
        lockedUntil: failedAttempts.lockedUntil,
      };
    }

    if (!normalizedUsername || !trimmedPassword) {
      return {
        success: false,
        error: 'Enter both username and password.',
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    const availableUsers = readStoredUsers();
    const passwordHash = await hashPassword(trimmedPassword);
    const foundUser = availableUsers.find(
      (candidate) =>
        candidate.username === normalizedUsername && candidate.passwordHash === passwordHash
    );

    if (foundUser) {
      const userData = {
        id: foundUser.id,
        name: foundUser.name,
        username: foundUser.username,
        role: foundUser.role,
      };
      setUser(userData);
      writeStoredSession(userData);
      writeFailedAttempts(null);
      return { success: true };
    }

    if (!failedAttempts || now - failedAttempts.firstFailedAt > FAILED_ATTEMPT_WINDOW_MS) {
      writeFailedAttempts({ count: 1, firstFailedAt: now });
      return {
        success: false,
        error: 'Invalid credentials.',
      };
    }

    const nextCount = failedAttempts.count + 1;
    if (nextCount >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = now + LOCKOUT_DURATION_MS;
      writeFailedAttempts({
        count: nextCount,
        firstFailedAt: failedAttempts.firstFailedAt,
        lockedUntil,
      });
      return {
        success: false,
        error: 'Too many failed attempts. Try again later.',
        lockedUntil,
      };
    }

    writeFailedAttempts({
      count: nextCount,
      firstFailedAt: failedAttempts.firstFailedAt,
    });

    return {
      success: false,
      error: 'Invalid credentials.',
    };
  };

  const createUser = async ({
    name,
    username,
    password,
    role,
  }: CreateUserInput): Promise<CreateUserResult> => {
    if (!user || user.role !== 'admin') {
      return {
        success: false,
        error: 'Only admins can add users.',
      };
    }

    const normalizedName = name.trim();
    const normalizedUsername = username.trim().toLowerCase();
    const trimmedPassword = password.trim();

    if (!normalizedName || !normalizedUsername || !trimmedPassword) {
      return {
        success: false,
        error: 'Name, username, and password are required.',
      };
    }

    if (trimmedPassword.length < 8) {
      return {
        success: false,
        error: 'Password must be at least 8 characters.',
      };
    }

    const availableUsers = readStoredUsers();
    if (availableUsers.some((candidate) => candidate.username === normalizedUsername)) {
      return {
        success: false,
        error: 'That username is already in use.',
      };
    }

    const passwordHash = await hashPassword(trimmedPassword);
    const nextUser: StoredUserRecord = {
      id: crypto.randomUUID(),
      name: normalizedName,
      username: normalizedUsername,
      passwordHash,
      role,
    };

    const nextUsers = [...availableUsers, nextUser];
    writeStoredUsers(nextUsers);
    setUsers(nextUsers.map(sanitizeUser));

    return { success: true };
  };

  const logout = () => {
    setUser(null);
    writeStoredSession(null);
  };

  return (
    <AuthContext.Provider value={{ user, users, login, createUser, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
