import type { ReactNode } from 'react';

/** Map a job/worker status to a colored pill. */
const STATUS_STYLE: Record<string, { cls: string; label?: string }> = {
  queued: { cls: 'pill-blue' },
  scheduled: { cls: 'pill-purple' },
  claimed: { cls: 'pill-amber' },
  running: { cls: 'pill-amber' },
  completed: { cls: 'pill-green' },
  succeeded: { cls: 'pill-green' },
  failed: { cls: 'pill-red' },
  dead_letter: { cls: 'pill-red', label: 'dead letter' },
  canceled: { cls: 'pill-gray' },
  active: { cls: 'pill-green' },
  idle: { cls: 'pill-gray' },
  draining: { cls: 'pill-amber' },
  dead: { cls: 'pill-red' },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { cls: 'pill-gray' };
  return (
    <span className={`pill ${s.cls}`}>
      <span className="dot" style={{ background: 'currentColor' }} />
      {s.label ?? status.replace('_', ' ')}
    </span>
  );
}

export function Card({ title, actions, children, noPad }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; noPad?: boolean;
}) {
  return (
    <div className="card">
      {title && (
        <div className="card-head">
          <h3>{title}</h3>
          <div className="spacer" style={{ flex: 1 }} />
          {actions}
        </div>
      )}
      <div className={noPad ? '' : 'card-body'}>{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub, color }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; color?: string;
}) {
  return (
    <div className="stat">
      <div className="label">
        {color && <span className="dot" style={{ background: color }} />}
        {label}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading"><span className="spin" /> {text}</div>;
}

export function Empty({ icon = '📭', text }: { icon?: string; text: string }) {
  return <div className="empty"><div className="big">{icon}</div>{text}</div>;
}

export function Modal({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---- formatting helpers ----
export function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 0) return `in ${fmt(-s)}`;
  if (s < 5) return 'just now';
  return `${fmt(s)} ago`;
}
function fmt(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export function shortId(id: string): string {
  return id.slice(0, 8);
}
