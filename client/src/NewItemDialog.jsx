import { useEffect, useRef, useState } from 'react';
import { api, newKey } from './api.js';
import { PRIORITIES, useToast } from './ui.jsx';

export default function NewItemDialog({ teams, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ teamId: teams[0]?.id, title: '', description: '', priority: 'medium', dueDate: '', requiresApproval: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One key per dialog "intent": a double click or a retry after a flaky network re-sends the same key.
  const key = useRef(newKey());
  const first = useRef(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (k) => (e) => {
    key.current = newKey(); // content changed, so it is a different request
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  };

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = {
        teamId: Number(form.teamId), title: form.title, description: form.description, priority: form.priority,
        requiresApproval: form.requiresApproval,
        dueAt: form.dueDate ? new Date(`${form.dueDate}T23:59:59`).getTime() : null,
      };
      const { item } = await api('POST', '/items', { body, key: key.current });
      toast.success('Item created');
      onCreated(item);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog card stack" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-title">
        <h2 id="new-title">New work item</h2>
        <label>Title<input ref={first} value={form.title} onChange={set('title')} maxLength={200} required /></label>
        <label>What happened and what is needed?
          <textarea rows={4} value={form.description} onChange={set('description')} />
        </label>
        <div className="grid2">
          <label>Team
            <select value={form.teamId} onChange={set('teamId')}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
          <label>Priority
            <select value={form.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
          </label>
          <label>Due date<input type="date" value={form.dueDate} onChange={set('dueDate')} /></label>
          <label className="check"><input type="checkbox" checked={form.requiresApproval} onChange={set('requiresApproval')} /> Needs lead approval before work starts</label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !form.title.trim()}>{busy ? 'Creating…' : 'Create item'}</button>
        </div>
      </form>
    </div>
  );
}
