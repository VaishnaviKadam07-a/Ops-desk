import { useCallback, useEffect, useRef, useState } from 'react';
import { api, newKey } from './api.js';
import { href } from './router.js';
import { PRIORITIES, PriorityBadge, STATUS_LABEL, StatusBadge, fmtDate, isOverdue, timeAgo, useClaim, useToast, useVisiblePolling } from './ui.jsx';

const toDateInput = (ms) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
const fromDateInput = (v) => (v ? new Date(`${v}T23:59:59`).getTime() : null);
const toDraft = (item) => ({ title: item.title, description: item.description, priority: item.priority, dueDate: toDateInput(item.dueAt) });

/** Only the fields the person actually touched. This is what makes a "keep mine" merge safe. */
function diffDraft(base, draft) {
  const out = {};
  if (draft.title !== base.title) out.title = draft.title;
  if (draft.description !== base.description) out.description = draft.description;
  if (draft.priority !== base.priority) out.priority = draft.priority;
  if (draft.dueDate !== toDateInput(base.dueAt)) out.dueAt = fromDateInput(draft.dueDate);
  return out;
}

function describe(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'created': return `created this item (${d.priority} priority${d.requiresApproval ? ', needs approval' : ''})`;
    case 'status_changed': return `moved it from ${STATUS_LABEL[d.from] || d.from} to ${STATUS_LABEL[d.to] || d.to}`;
    case 'assigned': return d.via === 'claim' ? 'took this item' : `assigned it to ${d.toName}${d.fromName ? ` (was ${d.fromName})` : ''}`;
    case 'released': return `released it${d.fromName ? ` (was ${d.fromName})` : ''}`;
    case 'priority_changed': return `changed priority from ${d.priority?.from} to ${d.priority?.to}`;
    case 'edited': return `edited ${Object.keys(d).map((k) => (k === 'dueAt' ? 'due date' : k)).join(', ')}`;
    case 'approval_decided': return `${d.decision === 'approve' ? 'approved' : 'rejected'} the request${d.note ? `: “${d.note}”` : ''}`;
    default: return e.type;
  }
}

function Timeline({ events, onOlder, hasMore }) {
  return (
    <ol className="timeline plain">
      {events.map((e) => (
        <li key={e.id} className={`${e.type === 'comment' ? 'comment' : 'event'} ${e._state || ''}`}>
          <div className="who"><strong>{e.actor?.name || 'System'}</strong> {e.type !== 'comment' && describe(e)} <span className="muted small">{e._state === 'sending' ? 'sending…' : timeAgo(e.createdAt)}</span></div>
          {e.type === 'comment' && <p className="body">{e.data.body}</p>}
          {e._state === 'failed' && <p className="error small">Not sent. {e._retry && <button className="link" onClick={e._retry}>Retry</button>}</p>}
        </li>
      ))}
      {hasMore && <li><button className="link" onClick={onOlder}>Show older activity</button></li>}
    </ol>
  );
}

export default function ItemDetail({ id, me, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [older, setOlder] = useState({ events: [], next: null, used: false });
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState(null);       // { base: item, values }
  const [conflict, setConflict] = useState(null); // { current }
  const [comment, setComment] = useState({ text: '', key: null, sending: false, error: '' });
  const [approvalNote, setApprovalNote] = useState('');
  const busyRef = useRef(false);

  const load = useCallback(async ({ force = false } = {}) => {
    try {
      const d = await api('GET', `/items/${id}`);
      if (busyRef.current && !force) return; // don't clobber an in-flight optimistic update
      setData(d); setError('');
    } catch (e) { setError(e.status === 404 ? 'This item does not exist or you do not have access to it.' : e.message); }
  }, [id]);

  useEffect(() => { load({ force: true }); }, [load]);
  useVisiblePolling(() => load(), 8000);

  const applyItem = useCallback((item) => setData((d) => (d ? { ...d, item } : d)), []);
  const claimItem = useClaim(me, applyItem);
  // After the server has decided, reload so the activity list shows the new entry right away.
  const claim = async (item) => { await claimItem(item); await load({ force: true }); onChanged?.(); };

  async function run(label, fn) {
    busyRef.current = true; setBusy(label);
    try {
      const r = await fn();
      await load({ force: true }); onChanged?.();
      return r;
    } catch (e) {
      if (e.status === 409) { toast.error(`${e.message}${e.code === 'version_conflict' ? ' The latest version has been loaded.' : ''}`); }
      else toast.error(e.message);
      await load({ force: true });
      return null;
    } finally { busyRef.current = false; setBusy(''); }
  }

  if (error) return <div className="card"><p className="error">{error}</p><a href={href('/')}>← Back to overview</a></div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { item, can, transitions, assignable } = data;
  const version = item.version;
  const mine = item.assignee?.id === me.id;

  const act = (path, body, label) => run(label, () => api('POST', `/items/${id}/${path}`, { body: { ...body, version }, key: newKey() }));

  // ----- editing with stale-write protection -----
  const startEdit = () => { setConflict(null); setDraft({ base: item, values: toDraft(item) }); };
  const externalChange = draft && item.version !== draft.base.version;

  async function saveEdit(onTop = false) {
    const target = onTop && conflict ? conflict.current : draft.base;
    const changes = diffDraft(draft.base, draft.values);
    if (!Object.keys(changes).length) { setDraft(null); setConflict(null); return; }
    busyRef.current = true; setBusy('save');
    try {
      await api('PATCH', `/items/${id}`, { body: { ...changes, version: target.version }, key: newKey() });
      toast.success('Saved');
      setDraft(null); setConflict(null);
      await load({ force: true }); onChanged?.();
    } catch (e) {
      if (e.code === 'version_conflict' && e.extra.current) setConflict({ current: e.extra.current });
      else toast.error(e.message);
    } finally { busyRef.current = false; setBusy(''); }
  }

  // ----- comments: same key until the text changes, so a retry can never double-post -----
  async function postComment() {
    const text = comment.text.trim();
    if (!text || comment.sending) return;
    const key = comment.key || newKey();
    setComment((c) => ({ ...c, key, sending: true, error: '' }));
    try {
      await api('POST', `/items/${id}/comments`, { body: { body: text }, key });
      setComment({ text: '', key: null, sending: false, error: '' });
      await load({ force: true }); onChanged?.();
    } catch (e) {
      setComment((c) => ({ ...c, sending: false, error: `${e.message} Your text is kept, so you can press Post again safely.` }));
    }
  }

  async function loadOlder() {
    const cursor = older.used ? older.next : data.nextEventCursor;
    const d = await api('GET', `/items/${id}/events?cursor=${cursor}&limit=50`);
    setOlder((o) => ({ events: [...o.events, ...d.events], next: d.nextCursor, used: true }));
  }
  const shown = [...data.events, ...older.events.filter((e) => !data.events.some((x) => x.id === e.id))];
  const hasMore = older.used ? !!older.next : !!data.nextEventCursor;

  const conflictFields = conflict && draft
    ? ['title', 'description', 'priority', 'dueAt'].filter((f) => conflict.current[f] !== draft.base[f])
    : [];

  return (
    <article className="detail">
      <p><a href={href('/')}>← Overview</a></p>

      {item._pending && <div className="banner info">Claiming…</div>}

      <header className="card stack">
        <div className="row between wrap">
          <h1>{item.title}</h1>
          <div className="row">{!draft && can.edit && <button onClick={startEdit}>Edit</button>}</div>
        </div>
        <div className="row wrap gap">
          <StatusBadge status={item.status} /><PriorityBadge priority={item.priority} />
          <span className="muted">{item.teamName}</span>
          {item.requiresApproval && <span className={`badge approval ${item.approvalState}`}>approval {item.approvalState}</span>}
          {item.dueAt && <span className={isOverdue(item) ? 'overdue' : 'muted'}>due {fmtDate(item.dueAt)}</span>}
        </div>
        <p className="desc">{item.description || <span className="muted">No description.</span>}</p>
        <p className="muted small">Created by {item.creator.name} {timeAgo(item.createdAt)} · last activity {timeAgo(item.lastActivityAt)}</p>
      </header>

      {draft && (
        <section className="card stack" aria-label="Edit item">
          <h2>Edit</h2>
          {externalChange && !conflict && (
            <div className="banner warn" role="alert">Someone changed this item while you were editing. You can keep editing; if your save conflicts you will be able to review the differences.</div>
          )}
          {conflict && (
            <div className="banner warn" role="alert">
              <strong>This item changed since you started editing.</strong>
              <ul>
                {conflictFields.length === 0 && <li>Only status/assignee changed; your edits do not overlap.</li>}
                {conflictFields.map((f) => (
                  <li key={f}><strong>{f === 'dueAt' ? 'Due date' : f}</strong>: now “{String(f === 'dueAt' ? (conflict.current.dueAt ? fmtDate(conflict.current.dueAt) : 'none') : conflict.current[f]).slice(0, 120)}”</li>
                ))}
              </ul>
              <div className="row gap">
                <button className="primary" onClick={() => saveEdit(true)} disabled={!!busy}>Keep my changes on top of the latest</button>
                <button onClick={() => { setDraft(null); setConflict(null); }}>Discard mine</button>
              </div>
              <p className="muted small">“Keep my changes” re-applies only the fields you edited; everything else stays as the other person left it.</p>
            </div>
          )}
          <label>Title<input value={draft.values.title} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, values: { ...d.values, title: e.target.value } }))} /></label>
          <label>Description<textarea rows={5} value={draft.values.description} onChange={(e) => setDraft((d) => ({ ...d, values: { ...d.values, description: e.target.value } }))} /></label>
          <div className="grid2">
            <label>Priority
              <select value={draft.values.priority} onChange={(e) => setDraft((d) => ({ ...d, values: { ...d.values, priority: e.target.value } }))}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
            </label>
            <label>Due date<input type="date" value={draft.values.dueDate} onChange={(e) => setDraft((d) => ({ ...d, values: { ...d.values, dueDate: e.target.value } }))} /></label>
          </div>
          {!conflict && (
            <div className="row end">
              <button onClick={() => setDraft(null)}>Cancel</button>
              <button className="primary" onClick={() => saveEdit(false)} disabled={busy === 'save' || !draft.values.title.trim()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            </div>
          )}
        </section>
      )}

      <section className="card stack" aria-label="Ownership and status">
        <div className="row between wrap gap">
          <div>
            <span className="muted small">Owner</span>
            <div className="owner">{item.assignee ? (mine ? 'You' : item.assignee.name) : <span className="muted">Nobody yet</span>}</div>
          </div>
          <div className="row wrap gap">
            {!item.assignee && can.claim && <button className="primary" onClick={() => claim(item)} disabled={!!busy || item._pending}>Claim this</button>}
            {item.assignee && can.release && <button onClick={() => act('release', {}, 'release')} disabled={!!busy}>Release</button>}
            {can.assign && (
              <span className="row gap">
                <select aria-label="Assign to" defaultValue="" onChange={(e) => { if (e.target.value) { act('assign', { assigneeId: Number(e.target.value) }, 'assign'); e.target.value = ''; } }} disabled={!!busy}>
                  <option value="">Assign to…</option>
                  {assignable.filter((u) => u.id !== item.assignee?.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </span>
            )}
          </div>
        </div>

        {transitions.length > 0 && (
          <div>
            <span className="muted small">Move to</span>
            <div className="row wrap gap">
              {transitions.map((t) => (
                <button key={t.to} disabled={!t.ok || !!busy} title={t.ok ? '' : t.reason} onClick={() => act('transition', { to: t.to }, 'transition')}>
                  {STATUS_LABEL[t.to]}
                </button>
              ))}
            </div>
            {transitions.some((t) => !t.ok) && <p className="muted small">Greyed-out steps explain why on hover or focus.</p>}
          </div>
        )}

        {item.approvalState === 'pending' && (
          <div className="banner info">
            <strong>Waiting for approval.</strong>
            {can.approve ? (
              <div className="stack">
                <input aria-label="Note (optional)" placeholder="Note (optional)" value={approvalNote} onChange={(e) => setApprovalNote(e.target.value)} />
                <div className="row gap">
                  <button className="primary" disabled={!!busy} onClick={() => act('approval', { decision: 'approve', note: approvalNote }, 'approval')}>Approve</button>
                  <button disabled={!!busy} onClick={() => act('approval', { decision: 'reject', note: approvalNote }, 'approval')}>Reject and close</button>
                </div>
              </div>
            ) : <span className="muted"> A team lead other than the requester must decide.</span>}
          </div>
        )}
      </section>

      <section className="card stack" aria-label="Activity">
        <h2>Activity</h2>
        {can.comment ? (
          <div className="stack">
            <label className="sr-only" htmlFor="comment">Add a comment</label>
            <textarea id="comment" rows={3} placeholder="Add a comment…" value={comment.text}
              onChange={(e) => setComment({ text: e.target.value, key: null, sending: false, error: '' })} />
            {comment.error && <p className="error small" role="alert">{comment.error}</p>}
            <div className="row end"><button className="primary" onClick={postComment} disabled={comment.sending || !comment.text.trim()}>{comment.sending ? 'Posting…' : 'Post'}</button></div>
          </div>
        ) : <p className="muted small">You have read-only access to this item.</p>}
        <Timeline events={shown} onOlder={loadOlder} hasMore={hasMore} />
      </section>
    </article>
  );
}
