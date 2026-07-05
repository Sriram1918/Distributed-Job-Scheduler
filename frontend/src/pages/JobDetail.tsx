import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, type Execution, type Job, type JobLog } from '../api/client';
import { usePolling } from '../hooks';
import { Card, Loading, StatusPill, timeAgo, shortId } from '../components/ui';

interface JobDetail { job: Job & { result?: unknown; payload?: unknown }; executions: Execution[]; logs: JobLog[] }

export function JobDetailPage() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const { data, loading, reload } = usePolling<JobDetail>(() => api.get(`/api/jobs/${jobId}`), 2500, [jobId]);

  if (loading && !data) return <Loading />;
  if (!data) return <Card title="Not found"><p className="muted">Job not found.</p></Card>;
  const { job, executions, logs } = data;
  const canRetry = ['failed', 'dead_letter'].includes(job.status);
  const canCancel = ['queued', 'scheduled'].includes(job.status);

  async function retry() { await api.post(`/api/jobs/${jobId}/retry`); reload(); }
  async function cancel() { await api.post(`/api/jobs/${jobId}/cancel`); reload(); }

  return (
    <>
      <div className="toolbar">
        <Link to="/jobs" className="btn btn-sm btn-ghost">← Jobs</Link>
        <h2 style={{ fontSize: 18 }}>{job.task}</h2>
        <StatusPill status={job.status} />
        <div className="spacer" />
        {canRetry && <button className="btn btn-primary btn-sm" onClick={retry}>↻ Retry</button>}
        {canCancel && <button className="btn btn-sm" onClick={cancel}>Cancel</button>}
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card title="Details">
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 13 }}>
            <dt className="muted">ID</dt><dd className="mono" style={{ margin: 0 }}>{shortId(job.id)}</dd>
            <dt className="muted">Queue</dt><dd style={{ margin: 0 }}>{job.queue_name}</dd>
            <dt className="muted">Type</dt><dd style={{ margin: 0 }}>{job.type}</dd>
            <dt className="muted">Priority</dt><dd style={{ margin: 0 }}>{job.priority}</dd>
            <dt className="muted">Attempts</dt><dd style={{ margin: 0 }}>{job.attempt_count} / {job.max_retries}</dd>
            <dt className="muted">Created</dt><dd style={{ margin: 0 }}>{timeAgo(job.created_at)}</dd>
          </dl>
        </Card>
        <Card title="Payload">
          <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
            {JSON.stringify(job.payload ?? {}, null, 2)}
          </pre>
        </Card>
        <Card title="Result / Error">
          {job.last_error ? <div className="error-banner" style={{ marginBottom: 0 }}>{job.last_error}</div>
            : <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{JSON.stringify(job.result ?? null, null, 2)}</pre>}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title={`Executions (${executions.length})`} noPad>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Status</th><th>Worker</th><th>Duration</th><th>Started</th></tr></thead>
              <tbody>
                {executions.length === 0 ? (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No attempts yet</td></tr>
                ) : executions.map((e) => (
                  <tr key={e.id}>
                    <td>{e.attempt_number}</td>
                    <td><StatusPill status={e.status} /></td>
                    <td className="mono muted">{e.worker_id ? shortId(e.worker_id) : '—'}</td>
                    <td className="muted">{e.duration_ms != null ? `${e.duration_ms}ms` : '—'}</td>
                    <td className="muted">{timeAgo(e.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title={`Logs (${logs.length})`} noPad>
          <div style={{ maxHeight: 320, overflow: 'auto', padding: '8px 0' }}>
            {logs.length === 0 ? <p className="muted" style={{ textAlign: 'center', padding: 24 }}>No logs</p> :
              logs.map((l) => (
                <div key={l.id} className="mono" style={{ fontSize: 12, padding: '4px 16px', display: 'flex', gap: 10 }}>
                  <span className="muted" style={{ flexShrink: 0 }}>{new Date(l.ts).toLocaleTimeString()}</span>
                  <span className={`pill pill-${l.level === 'error' ? 'red' : l.level === 'warn' ? 'amber' : 'gray'}`} style={{ flexShrink: 0 }}>{l.level}</span>
                  <span>{l.message}</span>
                </div>
              ))}
          </div>
        </Card>
      </div>
    </>
  );
}
