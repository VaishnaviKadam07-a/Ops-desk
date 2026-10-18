import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { navigate } from './router.js';
import { timeAgo } from './ui.jsx';

export default function Notifications({ unread, onChange }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    api('GET', '/notifications').then((d) => setList(d.notifications)).catch(() => setList([]));
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function openItem(n) {
    setOpen(false);
    if (!n.readAt) api('POST', '/notifications/read', { body: { ids: [n.id] } }).then(onChange).catch(() => {});
    if (n.itemId) navigate(`/item/${n.itemId}`);
  }
  async function markAll() {
    await api('POST', '/notifications/read', { body: { all: true } }).catch(() => {});
    setList((l) => l && l.map((n) => ({ ...n, readAt: n.readAt || Date.now() })));
    onChange();
  }

  return (
    <div className="notif" ref={box}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        🔔{unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="panel card" role="region" aria-label="Notifications">
          <div className="row between"><strong>Notifications</strong><button className="link" onClick={markAll}>Mark all read</button></div>
          {list === null && <p className="muted">Loading…</p>}
          {list && list.length === 0 && <p className="muted">Nothing yet.</p>}
          <ul className="plain">
            {list?.map((n) => (
              <li key={n.id}>
                <button className={`notif-item ${n.readAt ? '' : 'unread'}`} onClick={() => openItem(n)}>
                  <span>{n.message}</span><span className="muted small">{timeAgo(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
