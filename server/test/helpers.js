import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { DEMO_PASSWORD, seed } from '../src/seed.js';

/** Starts a real HTTP server on a random port against a fresh database (users/teams only, no items). */
export async function startServer({ file = ':memory:' } = {}) {
  const db = openDb(file);
  seed(db, { items: 0 });
  const app = createApp(db);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};

  async function raw(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  async function as(name) {
    if (!tokens[name]) {
      const r = await raw('POST', '/api/auth/login', { body: { email: `${name}@example.com`, password: DEMO_PASSWORD } });
      if (r.status !== 200) throw new Error(`login failed for ${name}: ${JSON.stringify(r.body)}`);
      tokens[name] = r.body.token;
    }
    const token = tokens[name];
    return (method, path, body, headers) => raw(method, path, { token, body, headers });
  }

  const teamId = (name) => db.prepare('SELECT id FROM teams WHERE name = ?').get(name).id;
  const userId = (name) => db.prepare('SELECT id FROM users WHERE email = ?').get(`${name}@example.com`).id;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { db, url, raw, as, teamId, userId, close };
}

/** Builds the same user object the auth middleware would, for tests that call domain functions directly. */
export function userObj(db, name) {
  const u = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(`${name}@example.com`);
  const teams = Object.fromEntries(db.prepare('SELECT team_id, role FROM memberships WHERE user_id = ?').all(u.id).map((m) => [m.team_id, m.role]));
  return { ...u, teams };
}

let counter = 0;
export const key = () => `test-key-${Date.now()}-${++counter}-${Math.random().toString(36).slice(2)}`;

export async function makeItem(call, teamId, extra = {}) {
  const r = await call('POST', '/api/items', { teamId, title: 'Test item', description: 'desc', ...extra });
  if (r.status !== 201) throw new Error(`makeItem failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.item;
}
