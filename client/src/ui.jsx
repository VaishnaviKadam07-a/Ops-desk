import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, newKey } from './api.js';

// ---------- toasts ----------
const ToastCtx = createContext({ success() {}, error() {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((kind, message) => {
    const id = newKey();
    setToasts((t) => [...t, { id, kind, message }].slice(-4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const api_ = useRef({ success: (m) => push('success', m), error: (m) => push('error', m) });
  return (
    <ToastCtx.Provider value={api_.current}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- small bits ----------
export const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', blocked: 'Blocked', resolved: 'Resolved', closed: 'Closed' };
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const StatusBadge = ({ status }) => <span className={`badge status-${status}`}>{STATUS_LABEL[status] || status}</span>;
export const PriorityBadge = ({ priority }) => <span className={`badge prio-${priority}`}>{priority}</span>;

export function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
export const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const isOverdue = (item) => item.dueAt && item.dueAt < Date.now() && ['open', 'in_progress', 'blocked'].includes(item.status);

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Runs fn every `ms` while the tab is visible, and once immediately when it becomes visible again. */
export function useVisiblePolling(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') ref.current(); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [ms]);
}

/**
 * Optimistic claim with reconciliation.
 * 1) show "mine" immediately, 2) ask the server, 3) the server's answer always wins:
 *    - success: replace with the authoritative item
 *    - someone got there first (409): show the real owner and say so
 *    - anything else: roll back to what we had.
 */
export function useClaim(me, applyItem) {
  const toast = useToast();
  return useCallback(async (item) => {
    const key = newKey();
    applyItem({ ...item, assignee: { id: me.id, name: me.name }, _pending: true });
    try {
      const { item: fresh } = await api('POST', `/items/${item.id}/claim`, { key });
      applyItem(fresh);
      toast.success('Assigned to you');
    } catch (e) {
      if (e.code === 'already_claimed' && e.extra.current) { applyItem(e.extra.current); toast.error(e.message); }
      else { applyItem(item); toast.error(e.message || 'Could not claim this item'); }
    }
  }, [me, applyItem, toast]);
}
