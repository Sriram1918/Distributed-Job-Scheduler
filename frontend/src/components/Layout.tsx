import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useProject } from '../project';

const NAV = [
  { to: '/', label: 'Overview', ico: '📊', end: true },
  { to: '/queues', label: 'Queues', ico: '🗂️' },
  { to: '/jobs', label: 'Jobs', ico: '⚙️' },
  { to: '/workers', label: 'Workers', ico: '🖥️' },
  { to: '/dead-letter', label: 'Dead Letter', ico: '☠️' },
];

export function Layout() {
  const { user, logout } = useAuth();
  const { projects, current, setCurrent } = useProject();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">JS</div>
          <div>
            <div className="brand-name">Orchestrator</div>
            <div className="brand-sub">Job Scheduler</div>
          </div>
        </div>
        <nav className="nav">
          <div className="nav-section">Monitor</div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <span className="ico">{n.ico}</span> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          Signed in as<br />
          <strong style={{ color: '#cdd5e6' }}>{user?.email}</strong>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{current?.name ?? 'No project'}</h1>
          <div className="spacer" />
          {projects.length > 0 && (
            <select
              value={current?.id ?? ''}
              onChange={(e) => {
                const p = projects.find((x) => x.id === e.target.value);
                if (p) setCurrent(p);
              }}
              style={{ width: 220 }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}
          <button className="btn btn-ghost" onClick={logout}>Logout</button>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
