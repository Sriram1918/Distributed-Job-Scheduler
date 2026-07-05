import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken, getToken, type Organization } from '../api/client';

interface AuthState {
  user: { id: string; email: string } | null;
  organizations: Organization[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthState['user']>(null);
  const [organizations, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!getToken()) { setLoading(false); return; }
    try {
      const me = await api.get<{ user: { id: string; email: string }; organizations: Organization[] }>('/api/auth/me');
      setUser(me.user);
      setOrgs(me.organizations);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string }>('/api/auth/login', { email, password });
    setToken(res.token);
    await refresh();
  }

  async function register(email: string, password: string, name?: string) {
    const res = await api.post<{ token: string }>('/api/auth/register', { email, password, name });
    setToken(res.token);
    await refresh();
  }

  function logout() {
    setToken(null);
    setUser(null);
    setOrgs([]);
  }

  return (
    <AuthCtx.Provider value={{ user, organizations, loading, login, register, logout, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}
