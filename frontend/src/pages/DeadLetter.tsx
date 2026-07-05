import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useProject } from '../project';
import { usePolling } from '../hooks';
import { Card, Loading, Empty, timeAgo, shortId } from '../components/ui';

interface DlqEntry {
  id: string; job_id: string; task: string; queue_name: string;
  reason: string; attempts: number; failed_at: string;
}

export function DeadLetterPage() {
  const { current } = useProject();
  const pid = current?.id;
  const { data, loading, reload } = usePolling<{ data: DlqEntry[] }>(
    () => api.get(`/api/projects/${pid}/dead-letter`), 4000, [pid],
  );

  if (!pid) return <Card title="No project"><p className="muted">Create a project first.</p></Card>;
  if (loading && !data) return <Loading />;
  const entries = data?.data ?? [];

  async function requeue(jobId: string) {
    await api.post(`/api/jobs/${jobId}/retry`);
    reload();
  }

  return (
    <>
      <div className="toolbar">
        <h2 style={{ fontSize: 18 }}>Dead Letter Queue</h2>
        <span className="badge-count">{entries.length}</span>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>Jobs that exhausted all retries</span>
      </div>

      {entries.length === 0 ? (
        <Card><Empty icon="✅" text="Dead letter queue is empty — nothing has permanently failed." /></Card>
      ) : (
        <Card noPad>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Job</th><th>Task</th><th>Queue</th><th>Reason</th><th>Attempts</th><th>Failed</th><th></th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td><Link className="mono" to={`/jobs/${e.job_id}`}>{shortId(e.job_id)}</Link></td>
                    <td><strong>{e.task}</strong></td>
                    <td className="muted">{e.queue_name}</td>
                    <td style={{ color: 'var(--red)', maxWidth: 320 }}>{e.reason}</td>
                    <td>{e.attempts}</td>
                    <td className="muted">{timeAgo(e.failed_at)}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn btn-sm btn-primary" onClick={() => requeue(e.job_id)}>↻ Requeue</button></td>
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
