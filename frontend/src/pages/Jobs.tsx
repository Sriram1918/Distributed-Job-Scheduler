import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Job, type Queue } from '../api/client';
import { useProject } from '../project';
import { usePolling } from '../hooks';
import { Card, Loading, StatusPill, Empty, timeAgo, shortId } from '../components/ui';

const STATUSES = ['queued', 'scheduled', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'canceled'];

export function JobsPage() {
  const { current } = useProject();
  const pid = current?.id;
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const queueId = params.get('queueId') ?? '';
  const page = Number(params.get('page') ?? '1');

  const queues = usePolling<{ data: Queue[] }>(() => api.get(`/api/projects/${pid}/queues`), 15000, [pid]);

  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (queueId) qs.set('queueId', queueId);
  qs.set('page', String(page));
  qs.set('limit', '20');

  const { data, loading } = usePolling<{ data: Job[]; pagination: { total: number; page: number; limit: number } }>(
    () => api.get(`/api/projects/${pid}/jobs?${qs.toString()}`), 2500, [pid, status, queueId, page],
  );

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.set('page', '1');
    setParams(next);
  }
  function goPage(p: number) {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  }

  if (!pid) return <Card title="No project"><p className="muted">Create a project first.</p></Card>;

  const jobs = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return (
    <>
      <div className="toolbar">
        <h2 style={{ fontSize: 18 }}>Jobs</h2>
        <span className="badge-count">{total}</span>
        <div className="spacer" />
        <select value={queueId} onChange={(e) => setFilter('queueId', e.target.value)} style={{ width: 170 }}>
          <option value="">All queues</option>
          {(queues.data?.data ?? []).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setFilter('status', e.target.value)} style={{ width: 150 }}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
      </div>

      {loading && !data ? <Loading /> : jobs.length === 0 ? (
        <Card><Empty icon="⚙️" text="No jobs match these filters." /></Card>
      ) : (
        <Card noPad>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>ID</th><th>Task</th><th>Queue</th><th>Type</th><th>Status</th><th>Attempts</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td><Link className="mono" to={`/jobs/${j.id}`}>{shortId(j.id)}</Link></td>
                    <td><strong>{j.task}</strong>{j.last_error && <div className="muted" style={{ fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.last_error}</div>}</td>
                    <td className="muted">{j.queue_name}</td>
                    <td><span className="pill pill-gray">{j.type}</span></td>
                    <td><StatusPill status={j.status} /></td>
                    <td className="muted">{j.attempt_count}/{j.max_retries}</td>
                    <td className="muted">{timeAgo(j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="toolbar" style={{ marginTop: 14, justifyContent: 'center' }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => goPage(page - 1)}>← Prev</button>
          <span className="muted">Page {page} of {totalPages}</span>
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => goPage(page + 1)}>Next →</button>
        </div>
      )}
    </>
  );
}
