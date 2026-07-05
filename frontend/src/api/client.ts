// Thin typed fetch wrapper. The token is kept in localStorage and attached to
// every request. `VITE_API_URL` points at the backend; in dev it is empty and
// Vite proxies /api to :4000.

const BASE = import.meta.env.VITE_API_URL ?? '';

let token: string | null = localStorage.getItem('token');

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export function getToken(): string | null {
  return token;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
};

// ---- Domain types (mirror the API responses) ------------------------------
export interface Project { id: string; name: string; org_id: string; queue_count?: number; api_key?: string }
export interface Organization { id: string; name: string; role: string }
export interface Queue {
  id: string; name: string; priority: number; concurrency_limit: number; is_paused: boolean;
  retry_policy_id: string | null;
  queued?: number; running?: number; completed?: number; failed?: number; dead_letter?: number;
}
export interface Job {
  id: string; queue_id: string; queue_name?: string; type: string; task: string; status: string;
  priority: number; attempt_count: number; max_retries: number; available_at: string;
  last_error: string | null; created_at: string; updated_at: string;
}
export interface Execution {
  id: string; worker_id: string | null; attempt_number: number; status: string;
  started_at: string; finished_at: string | null; duration_ms: number | null; error: string | null;
}
export interface JobLog { id: number; execution_id: string | null; level: string; message: string; ts: string }
export interface Worker {
  id: string; name: string | null; hostname: string | null; status: string; concurrency: number;
  last_heartbeat_at: string; alive: boolean; active_jobs: number;
}
export interface Metrics {
  jobsByStatus: Record<string, number>;
  lastHour: { completed: number; failed: number };
  queues: number; deadLetter: number;
  workers: { alive: number; total: number };
}
export interface RetryPolicy {
  id: string; name: string; strategy: string; max_retries: number;
  base_delay_seconds: number; max_delay_seconds: number;
}
