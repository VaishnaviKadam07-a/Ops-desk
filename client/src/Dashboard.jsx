import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { href, replaceRoute } from './router.js';
import { PRIORITIES, PriorityBadge, STATUS_LABEL, StatusBadge, fmtDate, isOverdue, timeAgo, useClaim, useDebounced, useVisiblePolling } from './ui.jsx';

const VIEWS = [
  ['attention', 'Needs my attention', 'Assigned to me, awaiting my approval, or unassigned and high priority'],
  ['mine', 'Assigned to me', 'Active items I own'],
  ['approval', 'Awaiting my approval', 'Requests from others that need a lead decision'],
  ['unassigned', 'Unassigned', 'Open items nobody owns yet'],
  ['overdue', 'Overdue', 'Past their due date and still active'],
  ['stale', 'Gone quiet', 'Active but no activity for 3+ days'],
];

function Row({ item, me, canClaim, onClaim }) {
  return (
    <li className={`row-item ${item._pending ? 'pending' : ''}`}>
      <div className="main">
        <a className="title" href={href(`/item/${item.id}`)}>{item.title}</a>
        <div className="meta">
          <span>{item.teamName}</span>
          <span>updated {timeAgo(item.lastActivityAt)}</span>
          {item.dueAt && <span className={isOverdue(item) ? 'overdue' : ''}>due {fmtDate(item.dueAt)}</span>}
          {item.approvalState === 'pending' && <span className="badge approval">needs approval</span>}
        </div>
      </div>
      <div className="side">
        <PriorityBadge priority={item.priority} />
        <StatusBadge status={item.status} />
        <span className="assignee">
          {item.assignee
            ? (item.assignee.id === me.id ? 'You' : item.assignee.name)
            : canClaim && !['resolved', 'closed'].includes(item.status)
              ? <button className="small" onClick={() => onClaim(item)}>Claim</button>
              : <span className="muted">Unassigned</span>}
          {item._pending && <span className="muted small"> claiming…</span>}
        </span>
      </div>
    </li>
  );
}

export default function Dashboard({ me, params, overview, refreshOverview }) {
  const view = params.view ?? 'attention';
  const [searchText, setSearchText] = useState(params.q || '');
  // The URL is the source of truth: if it changes from outside (card click, back button), the box follows.
  useEffect(() => { setSearchText(params.q || ''); }, [params.q]);
  const q = useDebounced(searchText, 300);
  const filters = useMemo(() => ({
    view: view === 'all' ? '' : view, q, team: params.team || '', status: params.status || '',
    priority: params.priority || '', sort: params.sort || '',
  }), [view, q, params.team, params.status, params.priority, params.sort]);

  const [state, setState] = useState({ items: [], next: null, loading: true, error: '' });
  const [loadingMore, setLoadingMore] = useState(false);
  const pages = useRef(1);
  const qsRef = useRef('');

  const qs = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString(), [filters]);
  qsRef.current = qs;

  const fetchFirst = useCallback(async ({ silent = false, signal } = {}) => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const d = await api('GET', `/items?${qs}&limit=25`, { signal });
      if (qsRef.current !== qs) return;
      pages.current = 1;
      setState({ items: d.items, next: d.nextCursor, loading: false, error: '' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!silent) setState((s) => ({ ...s, loading: false, error: e.message }));
    }
  }, [qs]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchFirst({ signal: ctrl.signal });
    return () => ctrl.abort(); // a newer filter supersedes this request; stale responses are dropped
  }, [fetchFirst]);

  // Keep the first page fresh in the background, but never disturb someone who has scrolled further.
  useVisiblePolling(() => { if (pages.current === 1) fetchFirst({ silent: true }); }, 30000);

  async function loadMore() {
    if (!state.next || loadingMore) return;
    const startedWith = qs;
    setLoadingMore(true);
    try {
      const d = await api('GET', `/items?${qs}&limit=25&cursor=${state.next}`);
      if (qsRef.current !== startedWith) return;
      pages.current += 1;
      setState((s) => {
        const seen = new Set(s.items.map((i) => i.id));
        return { ...s, items: [...s.items, ...d.items.filter((i) => !seen.has(i.id))], next: d.nextCursor };
      });
    } catch (e) {
      setState((s) => ({ ...s, error: e.message }));
    } finally { setLoadingMore(false); }
  }

  const applyItem = useCallback((updated) => {
    setState((s) => ({ ...s, items: s.items.map((i) => (i.id === updated.id ? updated : i)) }));
    if (!updated._pending) refreshOverview();
  }, [refreshOverview]);
  const claim = useClaim(me.user, applyItem);
  const roles = Object.fromEntries(me.teams.map((t) => [t.id, t.role]));

  const setParam = (k, v) => replaceRoute('/', { ...params, [k]: v });
  const isLead = me.teams.some((t) => t.role === 'lead');
  const cards = VIEWS.filter(([id]) => id !== 'approval' || isLead);

  return (
    <>
      <section className="cards" aria-label="Overview">
        {cards.map(([id, label, hint]) => (
          <a key={id} href={href('/', { view: id })} title={hint} className={`stat card ${view === id ? 'active' : ''} ${id === 'attention' ? 'hero' : ''}`}>
            <span className="num">{overview ? overview.counts[id] : '–'}</span>
            <span className="lbl">{label}</span>
          </a>
        ))}
      </section>

      <section className="filters" aria-label="Filters">
        <input type="search" aria-label="Search items" placeholder="Search title or description…" value={searchText}
          onChange={(e) => { setSearchText(e.target.value); replaceRoute('/', { ...params, q: e.target.value }); }} />
        <select aria-label="View" value={view} onChange={(e) => setParam('view', e.target.value)}>
          <option value="all">All items</option>
          {VIEWS.filter(([id]) => id !== 'approval' || isLead).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <select aria-label="Team" value={params.team || ''} onChange={(e) => setParam('team', e.target.value)}>
          <option value="">All my teams</option>
          {me.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select aria-label="Status" value={params.status || ''} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select aria-label="Priority" value={params.priority || ''} onChange={(e) => setParam('priority', e.target.value)}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select aria-label="Sort" value={params.sort || ''} onChange={(e) => setParam('sort', e.target.value)}>
          <option value="">Latest activity</option>
          <option value="priority">Highest priority</option>
        </select>
        <button onClick={() => { fetchFirst(); refreshOverview(); }}>Refresh</button>
      </section>

      {state.error && (
        <div className="banner error" role="alert">{state.error} <button className="link" onClick={() => fetchFirst()}>Retry</button></div>
      )}

      <ul className="list card plain" aria-busy={state.loading}>
        {state.loading && state.items.length === 0 && <li className="empty muted">Loading…</li>}
        {!state.loading && !state.error && state.items.length === 0 && (
          <li className="empty muted">{view === 'attention' && !q ? 'Nothing needs your attention right now. 🎉' : 'No items match these filters.'}</li>
        )}
        {state.items.map((item) => (
          <Row key={item.id} item={item} me={me.user} canClaim={['member', 'lead'].includes(roles[item.teamId])} onClaim={claim} />
        ))}
      </ul>

      {state.next && (
        <div className="row center">
          <button onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </>
  );
}
