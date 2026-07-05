import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('password123');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">JS</div>
          <div><strong>Orchestrator</strong><div className="brand-sub" style={{ color: 'var(--text-dim)' }}>Distributed Job Scheduler</div></div>
        </div>
        <div className="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</div>
        <div className="auth-sub">
          {mode === 'login' ? 'Sign in to manage your queues and jobs.' : 'Sign up and we\'ll set up your first organization.'}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={submit}>
          {mode === 'register' && (
            <div className="field">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
            </div>
          )}
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            {busy ? <span className="spin" /> : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="auth-switch">
          {mode === 'login' ? (
            <>New here? <a onClick={() => setMode('register')} style={{ cursor: 'pointer' }}>Create an account</a></>
          ) : (
            <>Already have an account? <a onClick={() => setMode('login')} style={{ cursor: 'pointer' }}>Sign in</a></>
          )}
        </div>
      </div>
    </div>
  );
}
