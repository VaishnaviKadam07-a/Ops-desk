import { useCallback, useEffect, useState } from 'react';
import Dashboard from './Dashboard.jsx';
import ItemDetail from './ItemDetail.jsx';
import NewItemDialog from './NewItemDialog.jsx';
import Notifications from './Notifications.jsx';
import { ApiError, api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import { href, navigate, useRoute } from './router.js';
import { ToastProvider, useVisiblePolling } from './ui.jsx';

const DEMO = [
  ['alice', 'Alice', 'lead · Support, Engineering'],
  ['bob', 'Bob', 'member · Support'],
  ['dave', 'Dave', 'viewer · Support'],
  ['erin', 'Erin', 'lead · Engineering, Finance'],
  ['frank', 'Frank', 'member · Finance'],
];

function Login({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e, creds = { email, password }) {
    e?.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api('POST', '/auth/login', { body: creds });
      setToken(r.token);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <h1>Ops Desk</h1>
      <p className="muted">Coordinate operational work in one place.</p>
      <form onSubmit={submit} className="card stack">
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="card stack">
        <strong>Demo accounts</strong>
        <p className="muted small">Password for all: <code>password123</code></p>
        <div className="demo-grid">
          {DEMO.map(([id, name, role]) => (
            <button key={id} type="button" disabled={busy} onClick={() => submit(null, { email: `${id}@example.com`, password: 'password123' })}>
              <span>{name}</span><span className="muted small">{role}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

function Shell({ onLogout }) {
  const route = useRoute();
  const [me, setMe] = useState(null);
  const [overview, setOverview] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [fatal, setFatal] = useState('');

  const refreshOverview = useCallback(() => api('GET', '/overview').then(setOverview).catch(() => {}), []);
  useEffect(() => { api('GET', '/me').then(setMe).catch((e) => setFatal(e.message)); refreshOverview(); }, [refreshOverview]);
  useVisiblePolling(refreshOverview, 20000);

  if (fatal) return <main className="login"><p className="error">{fatal}</p><button onClick={onLogout}>Sign out</button></main>;
  if (!me) return <main className="login"><p className="muted">Loading…</p></main>;

  const canCreate = me.teams.some((t) => t.role !== 'viewer');
  const itemMatch = route.path.match(/^\/item\/(\d+)$/);

  return (
    <>
      <header className="topbar">
        <a className="brand" href={href('/')}>Ops Desk</a>
        <div className="grow" />
        {canCreate && <button className="primary" onClick={() => setShowNew(true)}>New item</button>}
        <Notifications unread={overview?.unreadNotifications || 0} onChange={refreshOverview} />
        <span className="me" title={me.teams.map((t) => `${t.name}: ${t.role}`).join('\n')}>{me.user.name}</span>
        <button onClick={onLogout}>Sign out</button>
      </header>
      <main className="page">
        {itemMatch
          ? <ItemDetail key={itemMatch[1]} id={itemMatch[1]} me={me.user} onChanged={refreshOverview} />
          : <Dashboard me={me} params={route.params} overview={overview} refreshOverview={refreshOverview} />}
      </main>
      {showNew && (
        <NewItemDialog
          teams={me.teams.filter((t) => t.role !== 'viewer')}
          onClose={() => setShowNew(false)}
          onCreated={(item) => { setShowNew(false); refreshOverview(); navigate(`/item/${item.id}`); }}
        />
      )}
    </>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => { setUnauthorizedHandler(() => setAuthed(false)); }, []);
  const logout = () => { setToken(null); setAuthed(false); window.location.hash = ''; };
  return (
    <ToastProvider>
      {authed ? <Shell onLogout={logout} /> : <Login onLoggedIn={() => setAuthed(true)} />}
    </ToastProvider>
  );
}
