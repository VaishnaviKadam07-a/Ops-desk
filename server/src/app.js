import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { authenticate, login } from './auth.js';
import { HttpError, badRequest, notFound } from './errors.js';
import { idempotent } from './idempotency.js';
import * as items from './items.js';

const wrap = (fn) => (req, res, next) => {
  try { fn(req, res, next); } catch (err) { next(err); }
};

/** Mutation helper: transactional, replay-safe, and always answers with { status, body }. */
const mutate = (db, fn) => wrap((req, res) => {
  const out = idempotent(db, req, () => fn(req));
  if (out.replayed) res.set('Idempotent-Replay', 'true');
  res.status(out.status).json(out.body);
});

export function createApp(db, { clientDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  const auth = authenticate(db);

  // --- tiny login throttle (per email + ip) ---
  const attempts = new Map();
  const throttle = (req) => {
    const k = `${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
    const now = Date.now();
    const rec = (attempts.get(k) || []).filter((t) => now - t < 5 * 60_000);
    if (rec.length >= 10) throw new HttpError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in a few minutes.');
    rec.push(now); attempts.set(k, rec);
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', wrap((req, res) => {
    throttle(req);
    res.json(login(db, req.body?.email, req.body?.password));
  }));

  app.use('/api', auth);

  app.get('/api/me', wrap((req, res) => {
    const teams = db.prepare(
      `SELECT t.id, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.name`
    ).all(req.user.id);
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email }, teams });
  }));

  app.get('/api/teams/:id/members', wrap((req, res) => {
    const teamId = Number(req.params.id);
    if (!req.user.teams[teamId]) throw notFound('Team');
    res.json({
      members: db.prepare(
        `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.name`
      ).all(teamId),
    });
  }));

  app.get('/api/overview', wrap((req, res) => res.json(items.overview(db, req.user))));

  app.get('/api/items', wrap((req, res) => res.json(items.listItems(db, req.user, req.query))));

  app.post('/api/items', mutate(db, (req) => ({ status: 201, body: { item: items.createItem(db, req.user, req.body || {}) } })));

  app.get('/api/items/:id', wrap((req, res) => {
    // Cheap freshness check first so polling clients mostly get an empty 304.
    const head = db.prepare('SELECT team_id, version, last_activity_at FROM items WHERE id = ?').get(Number(req.params.id));
    if (!head || !req.user.teams[head.team_id]) throw notFound('Item');
    const etag = `"${head.version}-${head.last_activity_at}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache'); // always revalidate; a 304 is nearly free
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.json(items.getItemDetail(db, req.user, req.params.id));
  }));

  app.get('/api/items/:id/events', wrap((req, res) =>
    res.json(items.listEvents(db, req.user, req.params.id, req.query))));

  app.patch('/api/items/:id', mutate(db, (req) => ({
    status: 200,
    body: { item: items.editItem(db, req.user, req.params.id, req.body || {}, items.expectedVersion(req)) },
  })));

  app.post('/api/items/:id/claim', mutate(db, (req) => {
    const { item, changed } = items.claimItem(db, req.user, req.params.id);
    return { status: 200, body: { item, changed } };
  }));

  app.post('/api/items/:id/release', mutate(db, (req) => ({
    status: 200, body: { item: items.releaseItem(db, req.user, req.params.id, items.expectedVersion(req)) },
  })));

  app.post('/api/items/:id/assign', mutate(db, (req) => ({
    status: 200, body: { item: items.assignItem(db, req.user, req.params.id, req.body || {}, items.expectedVersion(req)) },
  })));

  app.post('/api/items/:id/transition', mutate(db, (req) => ({
    status: 200, body: { item: items.transitionItem(db, req.user, req.params.id, req.body?.to, items.expectedVersion(req)) },
  })));

  app.post('/api/items/:id/approval', mutate(db, (req) => ({
    status: 200,
    body: { item: items.decideApproval(db, req.user, req.params.id, req.body?.decision, req.body?.note, items.expectedVersion(req)) },
  })));

  app.post('/api/items/:id/comments', mutate(db, (req) => ({
    status: 201, body: { event: items.addComment(db, req.user, req.params.id, req.body?.body) },
  })));

  app.get('/api/notifications', wrap((req, res) => {
    const cursor = Number(req.query.cursor) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(
      `SELECT id, item_id, message, read_at, created_at FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 31`
    ).all(req.user.id, cursor);
    const page = rows.slice(0, 30);
    res.json({
      notifications: page.map((n) => ({ id: n.id, itemId: n.item_id, message: n.message, readAt: n.read_at, createdAt: n.created_at })),
      nextCursor: rows.length > 30 ? page[page.length - 1].id : null,
    });
  }));

  app.post('/api/notifications/read', wrap((req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    if (ids) {
      const stmt = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
      for (const id of ids) stmt.run(Date.now(), req.user.id, id);
    } else if (req.body?.all) {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.user.id);
    } else throw badRequest('Send { ids: [...] } or { all: true }');
    res.json({ ok: true });
  }));

  app.use('/api', (_req, _res, next) => next(notFound('Route')));

  // Serve the built client in production.
  if (clientDir && fs.existsSync(path.join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large' } });
    if (/database is locked|SQLITE_BUSY/i.test(String(err?.message))) {
      res.set('Retry-After', '1');
      return res.status(503).json({ error: { code: 'busy', message: 'Server is busy, please retry' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  return app;
}
