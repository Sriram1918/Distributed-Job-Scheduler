import { api, type Worker } from '../api/client';
import { usePolling } from '../hooks';
import { Card, Loading, StatusPill, Empty, timeAgo, shortId } from '../components/ui';

export function WorkersPage() {
  const { data, loading } = usePolling<{ data: Worker[] }>(() => api.get('/api/workers'), 2500);

  if (loading && !data) return <Loading />;
  const workers = data?.data ?? [];
  const alive = workers.filter((w) => w.alive && w.status !== 'dead').length;

  return (
    <>
      <div className="toolbar">
        <h2 style={{ fontSize: 18 }}>Workers</h2>
        <span className="badge-count">{alive} online</span>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>Auto-refreshing · liveness derived from heartbeat</span>
      </div>

      {workers.length === 0 ? (
        <Card><Empty icon="🖥️" text="No workers registered. Start a worker service to see it appear here." /></Card>
      ) : (
        <Card noPad>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Worker</th><th>Host</th><th>Status</th><th>Liveness</th><th>Active jobs</th><th>Capacity</th><th>Last heartbeat</th></tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id}>
                    <td><strong>{w.name ?? shortId(w.id)}</strong><div className="mono muted" style={{ fontSize: 11 }}>{shortId(w.id)}</div></td>
                    <td className="muted">{w.hostname ?? '—'}</td>
                    <td><StatusPill status={w.status} /></td>
                    <td>{w.alive && w.status !== 'dead'
                      ? <span className="pill pill-green"><span className="dot" style={{ background: 'currentColor' }} />alive</span>
                      : <span className="pill pill-red"><span className="dot" style={{ background: 'currentColor' }} />stale</span>}</td>
                    <td>{w.active_jobs}</td>
                    <td className="muted">{w.concurrency}</td>
                    <td className="muted">{timeAgo(w.last_heartbeat_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
