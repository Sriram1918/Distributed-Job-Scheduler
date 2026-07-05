import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Queue, type RetryPolicy } from '../api/client';
import { useProject } from '../project';
import { usePolling } from '../hooks';
import { Card, Loading, Modal, StatusPill, Empty } from '../components/ui';

export function QueuesPage() {
  const { current } = useProject();
  const pid = current?.id;
  const { data, loading, reload } = usePolling<{ data: Queue[] }>(
    () => api.get(`/api/projects/${pid}/queues`), 3000, [pid],
  );
  const policies = usePolling<{ data: RetryPolicy[] }>(
    () => api.get(`/api/projects/${pid}/retry-policies`), 15000, [pid],
  );

  const [modal, setModal] = useState<null | 'queue' | 'policy'>(null);
  const [submitFor, setSubmitFor] = useState<Queue | null>(null);

  if (!pid) return <Card title="No project"><p className="muted">Create a project first.</p></Card>;
  if (loading && !data) return <Loading />;
  const queues = data?.data ?? [];

  async function togglePause(q: Queue) {
    await api.post(`/api/queues/${q.id}/${q.is_paused ? 'resume' : 'pause'}`);
    reload();
  }

  return (
    <>
      <div className="toolbar">
        <h2 style={{ fontSize: 18 }}>Queues</h2>
        <span className="badge-count">{queues.length}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setModal('policy')}>＋ Retry policy</button>
        <button className="btn btn-primary" onClick={() => setModal('queue')}>＋ New queue</button>
      </div>

      {queues.length === 0 ? (
        <Card><Empty icon="🗂️" text="No queues yet. Create your first queue to start scheduling jobs." /></Card>
      ) : (
        <Card noPad>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Queue</th><th>State</th><th>Priority</th><th>Concurrency</th>
                  <th>Queued</th><th>Running</th><th>Completed</th><th>Failed</th><th>DLQ</th><th></th>
                </tr>
              </thead>
              <tbody>
                {queues.map((q) => (
                  <tr key={q.id}>
                    <td><strong>{q.name}</strong></td>
                    <td>{q.is_paused ? <StatusPill status="draining" /> : <StatusPill status="active" />}</td>
                    <td>{q.priority}</td>
                    <td>{q.concurrency_limit}</td>
                    <td>{q.queued ?? 0}</td>
                    <td>{q.running ?? 0}</td>
                    <td className="muted">{q.completed ?? 0}</td>
                    <td>{(q.failed ?? 0) > 0 ? <span style={{ color: 'var(--red)' }}>{q.failed}</span> : 0}</td>
                    <td>{(q.dead_letter ?? 0) > 0 ? <span style={{ color: 'var(--red)' }}>{q.dead_letter}</span> : 0}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => setSubmitFor(q)}>Submit job</button>{' '}
                      <button className="btn btn-sm" onClick={() => togglePause(q)}>{q.is_paused ? 'Resume' : 'Pause'}</button>{' '}
                      <Link className="btn btn-sm" to={`/jobs?queueId=${q.id}`}>Jobs</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {modal === 'queue' && (
        <CreateQueueModal projectId={pid} policies={policies.data?.data ?? []} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />
      )}
      {modal === 'policy' && (
        <CreatePolicyModal projectId={pid} onClose={() => setModal(null)} onDone={() => { setModal(null); policies.reload(); }} />
      )}
      {submitFor && (
        <SubmitJobModal queue={submitFor} onClose={() => setSubmitFor(null)} onDone={() => { setSubmitFor(null); reload(); }} />
      )}
    </>
  );
}

function CreateQueueModal({ projectId, policies, onClose, onDone }: {
  projectId: string; policies: RetryPolicy[]; onClose: () => void; onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(0);
  const [concurrency, setConcurrency] = useState(10);
  const [retryPolicyId, setRetryPolicyId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/projects/${projectId}/queues`, {
        name, priority: Number(priority), concurrencyLimit: Number(concurrency),
        retryPolicyId: retryPolicyId || null,
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }

  return (
    <Modal title="New queue" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !name}>Create</button>
      </>
    }>
      {err && <div className="error-banner">{err}</div>}
      <div className="field"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="emails" /></div>
      <div className="row">
        <div className="field"><label>Priority</label><input type="number" value={priority} onChange={(e) => setPriority(+e.target.value)} /></div>
        <div className="field"><label>Concurrency limit</label><input type="number" min={1} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} /></div>
      </div>
      <div className="field">
        <label>Retry policy</label>
        <select value={retryPolicyId} onChange={(e) => setRetryPolicyId(e.target.value)}>
          <option value="">Default (exponential ×3)</option>
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.strategy} ×{p.max_retries}</option>)}
        </select>
      </div>
    </Modal>
  );
}

function CreatePolicyModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState('exponential');
  const [maxRetries, setMaxRetries] = useState(3);
  const [baseDelay, setBaseDelay] = useState(10);
  const [maxDelay, setMaxDelay] = useState(3600);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/retry-policies`, {
        name, strategy, maxRetries: +maxRetries, baseDelaySeconds: +baseDelay, maxDelaySeconds: +maxDelay,
      });
      onDone();
    } finally { setBusy(false); }
  }

  return (
    <Modal title="New retry policy" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !name}>Create</button>
      </>
    }>
      <div className="field"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Exponential ×5" /></div>
      <div className="row">
        <div className="field">
          <label>Strategy</label>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="fixed">Fixed delay</option>
            <option value="linear">Linear backoff</option>
            <option value="exponential">Exponential backoff</option>
          </select>
        </div>
        <div className="field"><label>Max retries</label><input type="number" min={0} value={maxRetries} onChange={(e) => setMaxRetries(+e.target.value)} /></div>
      </div>
      <div className="row">
        <div className="field"><label>Base delay (s)</label><input type="number" min={0} value={baseDelay} onChange={(e) => setBaseDelay(+e.target.value)} /></div>
        <div className="field"><label>Max delay (s)</label><input type="number" min={1} value={maxDelay} onChange={(e) => setMaxDelay(+e.target.value)} /></div>
      </div>
    </Modal>
  );
}

const TASKS = ['send_email', 'http_request', 'sleep', 'flaky', 'always_fail'];

function SubmitJobModal({ queue, onClose, onDone }: { queue: Queue; onClose: () => void; onDone: () => void }) {
  const [type, setType] = useState('immediate');
  const [task, setTask] = useState('send_email');
  const [payload, setPayload] = useState('{\n  "to": "user@example.com"\n}');
  const [priority, setPriority] = useState(0);
  const [delaySeconds, setDelay] = useState(30);
  const [runAt, setRunAt] = useState('');
  const [cronExpr, setCron] = useState('*/5 * * * *');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr(null);
    let parsed: unknown = {};
    try { parsed = payload.trim() ? JSON.parse(payload) : {}; }
    catch { setErr('Payload must be valid JSON'); setBusy(false); return; }
    try {
      const body: Record<string, unknown> = { type, task, payload: parsed, priority: +priority };
      if (type === 'delayed') body.delaySeconds = +delaySeconds;
      if (type === 'scheduled') body.runAt = new Date(runAt).toISOString();
      if (type === 'recurring') body.cronExpr = cronExpr;
      await api.post(`/api/queues/${queue.id}/jobs`, body);
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Submit job → ${queue.name}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy}>Submit</button>
      </>
    }>
      {err && <div className="error-banner">{err}</div>}
      <div className="row">
        <div className="field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="immediate">Immediate</option>
            <option value="delayed">Delayed</option>
            <option value="scheduled">Scheduled (at time)</option>
            <option value="recurring">Recurring (cron)</option>
          </select>
        </div>
        <div className="field">
          <label>Task</label>
          <select value={task} onChange={(e) => setTask(e.target.value)}>
            {TASKS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      {type === 'delayed' && (
        <div className="field"><label>Delay (seconds)</label><input type="number" value={delaySeconds} onChange={(e) => setDelay(+e.target.value)} /></div>
      )}
      {type === 'scheduled' && (
        <div className="field"><label>Run at</label><input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} /></div>
      )}
      {type === 'recurring' && (
        <div className="field"><label>Cron expression</label><input value={cronExpr} onChange={(e) => setCron(e.target.value)} placeholder="*/5 * * * *" /></div>
      )}
      <div className="field">
        <label>Priority</label><input type="number" value={priority} onChange={(e) => setPriority(+e.target.value)} />
      </div>
      <div className="field">
        <label>Payload (JSON)</label>
        <textarea rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} className="mono" />
      </div>
    </Modal>
  );
}
