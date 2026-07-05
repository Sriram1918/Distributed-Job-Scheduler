import { api, type Metrics } from '../api/client';
import { useProject } from '../project';
import { usePolling } from '../hooks';
import { Card, Loading, Stat } from '../components/ui';

interface ThroughputPoint { minute: string; completed: number; failed: number }

const STATUS_META: { key: string; label: string; color: string }[] = [
  { key: 'queued', label: 'Queued', color: 'var(--blue)' },
  { key: 'scheduled', label: 'Scheduled', color: 'var(--purple)' },
  { key: 'running', label: 'Running', color: 'var(--amber)' },
  { key: 'completed', label: 'Completed', color: 'var(--green)' },
  { key: 'failed', label: 'Failed', color: 'var(--red)' },
  { key: 'dead_letter', label: 'Dead Letter', color: 'var(--red)' },
];

export function OverviewPage() {
  const { current } = useProject();
  const pid = current?.id;

  const metrics = usePolling<Metrics>(
    () => api.get(`/api/projects/${pid}/metrics`),
    3000,
    [pid],
  );
  const throughput = usePolling<{ data: ThroughputPoint[] }>(
    () => api.get(`/api/projects/${pid}/metrics/throughput`),
    5000,
    [pid],
  );

  if (!pid) return <Card title="No project"><p className="muted">Create a project to get started.</p></Card>;
  if (metrics.loading && !metrics.data) return <Loading />;
  const m = metrics.data;
  if (!m) return <Loading />;

  const totalJobs = Object.values(m.jobsByStatus).reduce((a, b) => a + b, 0);
  const running = (m.jobsByStatus.running ?? 0) + (m.jobsByStatus.claimed ?? 0);
  const points = throughput.data?.data ?? [];
  const maxBar = Math.max(1, ...points.map((p) => p.completed + p.failed));

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Total jobs" value={totalJobs.toLocaleString()} sub={`${m.queues} queues`} />
        <Stat label="Running now" value={running} color="var(--amber)" sub="claimed + running" />
        <Stat
          label="Workers online"
          value={`${m.workers.alive} / ${m.workers.total}`}
          color={m.workers.alive > 0 ? 'var(--green)' : 'var(--red)'}
          sub="alive / registered"
        />
        <Stat
          label="Dead letter"
          value={m.deadLetter}
          color={m.deadLetter > 0 ? 'var(--red)' : 'var(--gray)'}
          sub="need attention"
        />
      </div>

      <div className="grid grid-2">
        <Card title="Jobs by status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {STATUS_META.map((s) => {
              const count = m.jobsByStatus[s.key] ?? 0;
              const pct = totalJobs ? Math.round((count / totalJobs) * 100) : 0;
              return (
                <div key={s.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                    <span><span className="dot" style={{ background: s.color, marginRight: 8 }} />{s.label}</span>
                    <strong>{count}</strong>
                  </div>
                  <div style={{ height: 6, background: 'var(--gray-soft)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: s.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Throughput — last hour" actions={
          <span className="muted" style={{ fontSize: 12 }}>
            ✓ {m.lastHour.completed} &nbsp; ✕ {m.lastHour.failed}
          </span>
        }>
          {points.length === 0 ? (
            <p className="muted" style={{ padding: '20px 0', textAlign: 'center' }}>No executions in the last hour yet.</p>
          ) : (
            <>
              <div className="bars">
                {points.map((p, i) => {
                  const h = ((p.completed + p.failed) / maxBar) * 100;
                  const failH = (p.failed / Math.max(1, p.completed + p.failed)) * h;
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }} title={`${new Date(p.minute).toLocaleTimeString()} — ${p.completed} ok, ${p.failed} failed`}>
                      <div className="bar fail" style={{ height: `${failH}%` }} />
                      <div className="bar" style={{ height: `${h - failH}%` }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11 }} className="muted">
                <span>60 min ago</span><span>now</span>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
