import { PRIORITY_RANK } from './db.js';
import { HttpError, badRequest, forbidden, notFound } from './errors.js';
import * as policy from './policy.js';

const ACTIVE = "i.status IN ('open','in_progress','blocked')";
const STALE_MS = 3 * 24 * 60 * 60 * 1000;

const ITEM_SELECT = `
  SELECT i.*, a.name AS assignee_name, c.name AS creator_name, t.name AS team_name
  FROM items i
  LEFT JOIN users a ON a.id = i.assignee_id
  JOIN users c ON c.id = i.creator_id
  JOIN teams t ON t.id = i.team_id`;

export const serializeItem = (r) => ({
  id: r.id,
  teamId: r.team_id,
  teamName: r.team_name,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name } : null,
  creator: { id: r.creator_id, name: r.creator_name },
  requiresApproval: !!r.requires_approval,
  approvalState: r.approval_state,
  dueAt: r.due_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastActivityAt: r.last_activity_at,
});

export const getItemRow = (db, id) => db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id);

function loadItem(db, id) {
  const row = getItemRow(db, Number(id));
  if (!row) throw notFound('Item');
  return row;
}

const logEvent = (db, itemId, actorId, type, data = {}, now = Date.now()) =>
  db.prepare('INSERT INTO item_events (item_id, actor_id, type, data, created_at) VALUES (?,?,?,?,?)')
    .run(itemId, actorId, type, JSON.stringify(data), now);

const enqueue = (db, topic, payload, dedupeKey, now = Date.now()) =>
  db.prepare(`INSERT OR IGNORE INTO outbox (topic, payload, dedupe_key, next_attempt_at, created_at) VALUES (?,?,?,?,?)`)
    .run(topic, JSON.stringify(payload), dedupeKey, now, now);

/** Fail with 409 + the current state so the client can reconcile instead of guessing. */
function conflict(db, id, code, message) {
  const current = serializeItem(loadItem(db, id));
  return new HttpError(409, code, message, { current });
}

export function expectedVersion(req) {
  const raw = req.get('If-Match') ?? req.body?.version;
  const v = Number(String(raw ?? '').replace(/"/g, ''));
  if (!Number.isInteger(v) || v < 1) {
    throw new HttpError(428, 'version_required', 'Send the item version you were looking at (If-Match header or body.version)');
  }
  return v;
}

// ---------- validation ----------
function cleanTitle(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 200) throw badRequest('title is required (max 200 characters)');
  return s;
}
function cleanDescription(v) {
  const s = String(v ?? '');
  if (s.length > 10000) throw badRequest('description is too long (max 10000 characters)');
  return s;
}
function cleanPriority(v) {
  if (!(v in PRIORITY_RANK)) throw badRequest(`priority must be one of ${Object.keys(PRIORITY_RANK).join(', ')}`);
  return v;
}
function cleanDue(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw badRequest('dueAt must be a timestamp or ISO date');
  return ms;
}

// ---------- commands ----------
export function createItem(db, user, body, now = Date.now()) {
  const teamId = Number(body.teamId);
  const role = policy.roleIn(user, teamId);
  if (!role) throw notFound('Team');
  if (role === 'viewer') throw forbidden('Viewers cannot create items');
  const priority = cleanPriority(body.priority ?? 'medium');
  const requiresApproval = body.requiresApproval ? 1 : 0;
  const info = db.prepare(
    `INSERT INTO items (team_id, title, description, priority, priority_rank, creator_id, requires_approval,
                        approval_state, due_at, created_at, updated_at, last_activity_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(teamId, cleanTitle(body.title), cleanDescription(body.description), priority, PRIORITY_RANK[priority],
        user.id, requiresApproval, requiresApproval ? 'pending' : 'none', cleanDue(body.dueAt), now, now, now);
  const id = Number(info.lastInsertRowid);
  logEvent(db, id, user.id, 'created', { priority, requiresApproval: !!requiresApproval }, now);
  if (requiresApproval) enqueue(db, 'item.approval_requested', { itemId: id, actorId: user.id }, `approval_requested:${id}`, now);
  return serializeItem(loadItem(db, id));
}

/**
 * Applies a field change guarded by the version the caller saw.
 * Returns the fresh row, or throws 409 with the current state if someone else changed it first.
 */
function guardedUpdate(db, id, version, sets, params, now) {
  const info = db.prepare(
    `UPDATE items SET ${sets.join(', ')}, version = version + 1, updated_at = ?, last_activity_at = ?
     WHERE id = ? AND version = ?`
  ).run(...params, now, now, id, version);
  if (info.changes === 0) throw conflict(db, id, 'version_conflict', 'This item was changed by someone else. Review the latest version and try again.');
  return loadItem(db, id);
}

export function editItem(db, user, id, body, version, now = Date.now()) {
  const item = loadItem(db, id);
  policy.require(user, 'edit', item);
  const sets = [];
  const params = [];
  const changes = {};
  if (body.title !== undefined) {
    const t = cleanTitle(body.title);
    if (t !== item.title) { sets.push('title = ?'); params.push(t); changes.title = { from: item.title, to: t }; }
  }
  if (body.description !== undefined) {
    const d = cleanDescription(body.description);
    if (d !== item.description) { sets.push('description = ?'); params.push(d); changes.description = { from: item.description.slice(0, 300), to: d.slice(0, 300) }; }
  }
  if (body.priority !== undefined) {
    const p = cleanPriority(body.priority);
    if (p !== item.priority) { sets.push('priority = ?', 'priority_rank = ?'); params.push(p, PRIORITY_RANK[p]); changes.priority = { from: item.priority, to: p }; }
  }
  if (body.dueAt !== undefined) {
    const d = cleanDue(body.dueAt);
    if (d !== item.due_at) { sets.push('due_at = ?'); params.push(d); changes.dueAt = { from: item.due_at, to: d }; }
  }
  if (!sets.length) {
    if (item.version !== version) throw conflict(db, id, 'version_conflict', 'This item was changed by someone else.');
    return serializeItem(item); // no-op edit
  }
  const row = guardedUpdate(db, item.id, version, sets, params, now);
  logEvent(db, item.id, user.id, changes.priority && Object.keys(changes).length === 1 ? 'priority_changed' : 'edited', changes, now);
  return serializeItem(row);
}

/**
 * Claim is intent-based, not version-based: "make me the owner IF nobody owns it".
 * The WHERE clause is the lock, so of N simultaneous claims exactly one UPDATE matches.
 */
export function claimItem(db, user, id, now = Date.now()) {
  const item = loadItem(db, id);
  policy.requireRead(user, item);
  if (item.assignee_id === user.id) return { item: serializeItem(item), changed: false }; // retry-safe
  if (!['member', 'lead'].includes(policy.roleIn(user, item.team_id))) throw forbidden('Not allowed to claim this item');
  if (['resolved', 'closed'].includes(item.status)) throw new HttpError(422, 'not_claimable', `A ${item.status} item cannot be claimed`);
  const info = db.prepare(
    `UPDATE items SET assignee_id = ?, version = version + 1, updated_at = ?, last_activity_at = ?
     WHERE id = ? AND assignee_id IS NULL AND status NOT IN ('resolved','closed')`
  ).run(user.id, now, now, item.id);
  if (info.changes === 0) {
    const cur = loadItem(db, id);
    throw conflict(db, id, 'already_claimed', `${cur.assignee_name || 'Someone else'} already took this item`);
  }
  const row = loadItem(db, id);
  logEvent(db, item.id, user.id, 'assigned', { to: user.id, toName: user.name, via: 'claim' }, now);
  enqueue(db, 'item.assigned', { itemId: item.id, actorId: user.id, assigneeId: user.id }, `assigned:${item.id}:${row.version}`, now);
  return { item: serializeItem(row), changed: true };
}

export function releaseItem(db, user, id, version, now = Date.now()) {
  const item = loadItem(db, id);
  policy.require(user, 'release', item);
  if (item.assignee_id == null) throw new HttpError(422, 'not_assigned', 'Item has no assignee');
  if (item.status === 'in_progress') throw new HttpError(422, 'in_progress', 'Move the item back to open (or blocked) before releasing it');
  const row = guardedUpdate(db, item.id, version, ['assignee_id = NULL'], [], now);
  logEvent(db, item.id, user.id, 'released', { from: item.assignee_id, fromName: item.assignee_name }, now);
  return serializeItem(row);
}

export function assignItem(db, user, id, body, version, now = Date.now()) {
  const item = loadItem(db, id);
  policy.require(user, 'assign', item);
  const assigneeId = Number(body.assigneeId);
  const target = db.prepare(
    `SELECT u.id, u.name, m.role FROM users u JOIN memberships m ON m.user_id = u.id AND m.team_id = ? WHERE u.id = ?`
  ).get(item.team_id, assigneeId);
  if (!target || target.role === 'viewer') throw badRequest('Assignee must be a member or lead of the item\'s team');
  if (['resolved', 'closed'].includes(item.status)) throw new HttpError(422, 'not_assignable', `A ${item.status} item cannot be reassigned`);
  if (item.assignee_id === assigneeId) {
    if (item.version !== version) throw conflict(db, id, 'version_conflict', 'This item was changed by someone else.');
    return serializeItem(item);
  }
  const row = guardedUpdate(db, item.id, version, ['assignee_id = ?'], [assigneeId], now);
  logEvent(db, item.id, user.id, 'assigned', { from: item.assignee_id, fromName: item.assignee_name, to: target.id, toName: target.name, via: 'assign' }, now);
  enqueue(db, 'item.assigned', { itemId: item.id, actorId: user.id, assigneeId }, `assigned:${item.id}:${row.version}`, now);
  return serializeItem(row);
}

export function transitionItem(db, user, id, to, version, now = Date.now()) {
  const item = loadItem(db, id);
  policy.require(user, 'transition', item);
  policy.checkTransition(user, item, String(to));
  const row = guardedUpdate(db, item.id, version, ['status = ?'], [to], now);
  logEvent(db, item.id, user.id, 'status_changed', { from: item.status, to }, now);
  enqueue(db, 'item.status_changed', { itemId: item.id, actorId: user.id, from: item.status, to }, `status:${item.id}:${row.version}`, now);
  return serializeItem(row);
}

export function decideApproval(db, user, id, decision, note, version, now = Date.now()) {
  const item = loadItem(db, id);
  policy.requireRead(user, item);
  if (!['approve', 'reject'].includes(decision)) throw badRequest("decision must be 'approve' or 'reject'");
  if (item.approval_state !== 'pending') throw new HttpError(422, 'no_pending_approval', 'This item has no pending approval');
  if (!policy.can(user, 'approve', item)) {
    throw forbidden(item.creator_id === user.id ? 'You cannot approve your own request' : 'Only a team lead can decide approvals');
  }
  const approved = decision === 'approve';
  // Rejecting closes the item; approving unlocks in_progress.
  const sets = ['approval_state = ?'];
  const params = [approved ? 'approved' : 'rejected'];
  if (!approved) { sets.push("status = 'closed'"); }
  const row = guardedUpdate(db, item.id, version, sets, params, now);
  logEvent(db, item.id, user.id, 'approval_decided', { decision, note: String(note || '').slice(0, 1000) }, now);
  enqueue(db, 'item.approval_decided', { itemId: item.id, actorId: user.id, decision }, `approval_decided:${item.id}:${row.version}`, now);
  return serializeItem(row);
}

/** Comments do not bump `version`: discussing an item must not invalidate someone else's edit form. */
export function addComment(db, user, id, text, now = Date.now()) {
  const item = loadItem(db, id);
  policy.require(user, 'comment', item);
  const body = String(text ?? '').trim();
  if (!body || body.length > 5000) throw badRequest('comment is required (max 5000 characters)');
  db.prepare('UPDATE items SET last_activity_at = ? WHERE id = ?').run(now, item.id);
  const info = logEvent(db, item.id, user.id, 'comment', { body }, now);
  const eventId = Number(info.lastInsertRowid);
  enqueue(db, 'item.comment', { itemId: item.id, actorId: user.id, eventId }, `comment:${eventId}`, now);
  return getEvent(db, eventId);
}

// ---------- reads ----------
const serializeEvent = (e) => ({
  id: e.id, itemId: e.item_id, type: e.type, data: JSON.parse(e.data), createdAt: e.created_at,
  actor: e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
});
const EVENT_SELECT = 'SELECT e.*, u.name AS actor_name FROM item_events e LEFT JOIN users u ON u.id = e.actor_id';
const getEvent = (db, id) => serializeEvent(db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id));

export function listEvents(db, user, itemId, { cursor, limit = 50 } = {}) {
  const item = loadItem(db, itemId);
  policy.requireRead(user, item);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = cursor
    ? db.prepare(`${EVENT_SELECT} WHERE e.item_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT ?`).all(item.id, Number(cursor), lim + 1)
    : db.prepare(`${EVENT_SELECT} WHERE e.item_id = ? ORDER BY e.id DESC LIMIT ?`).all(item.id, lim + 1);
  const page = rows.slice(0, lim);
  return { events: page.map(serializeEvent), nextCursor: rows.length > lim ? page[page.length - 1].id : null };
}

export function getItemDetail(db, user, id) {
  const row = loadItem(db, id);
  policy.requireRead(user, row);
  const can = Object.fromEntries(['comment', 'claim', 'edit', 'release', 'assign', 'transition', 'approve']
    .map((a) => [a, policy.can(user, a, row)]));
  const transitions = (policy.TRANSITIONS[row.status] || []).map((to) => {
    if (!can.transition) return { to, ok: false, reason: 'Only the assignee or a team lead can change status' };
    try { policy.checkTransition(user, row, to); return { to, ok: true }; }
    catch (e) { return { to, ok: false, reason: e.message }; }
  });
  const { events, nextCursor } = listEvents(db, user, id, { limit: 50 });
  const assignable = can.assign
    ? db.prepare(`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.team_id = ? AND m.role IN ('member','lead') ORDER BY u.name`).all(row.team_id)
    : [];
  return { item: serializeItem(row), can, transitions, assignable, events, nextEventCursor: nextCursor };
}

// ---------- list / search / overview ----------
const ph = (arr) => arr.map(() => '?').join(',');

function viewPredicate(user, view, now) {
  const leadTeams = Object.entries(user.teams).filter(([, r]) => r === 'lead').map(([t]) => Number(t));
  const mine = { sql: `(i.assignee_id = ? AND ${ACTIVE})`, params: [user.id] };
  const approval = leadTeams.length
    ? { sql: `(i.approval_state = 'pending' AND i.status != 'closed' AND i.creator_id != ? AND i.team_id IN (${ph(leadTeams)}))`, params: [user.id, ...leadTeams] }
    : { sql: '(0)', params: [] };
  const hotUnassigned = { sql: `(i.assignee_id IS NULL AND i.status = 'open' AND i.priority_rank >= 3)`, params: [] };
  switch (view) {
    case 'mine': return mine;
    case 'approval': return approval;
    case 'unassigned': return { sql: `(i.assignee_id IS NULL AND i.status = 'open')`, params: [] };
    case 'overdue': return { sql: `(i.due_at IS NOT NULL AND i.due_at < ? AND ${ACTIVE})`, params: [now] };
    case 'stale': return { sql: `(${ACTIVE} AND i.last_activity_at < ?)`, params: [now - STALE_MS] };
    case 'attention':
      return { sql: `(${mine.sql} OR ${approval.sql} OR ${hotUnassigned.sql})`, params: [...mine.params, ...approval.params] };
    case undefined: case null: case '': case 'all': return null;
    default: throw badRequest(`unknown view '${view}'`);
  }
}

/** Turns user input into a safe FTS5 query: every token quoted, last token treated as a prefix. */
export function toFtsQuery(q) {
  const tokens = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ');
}

const encodeCursor = (arr) => Buffer.from(JSON.stringify(arr)).toString('base64url');
function decodeCursor(c, n) {
  try {
    const arr = JSON.parse(Buffer.from(String(c), 'base64url').toString());
    if (Array.isArray(arr) && arr.length === n && arr.every(Number.isFinite)) return arr;
  } catch { /* fall through */ }
  throw badRequest('invalid cursor');
}

export function listItems(db, user, q = {}, now = Date.now()) {
  const teamIds = Object.keys(user.teams).map(Number);
  if (!teamIds.length) return { items: [], nextCursor: null };
  const where = [];
  const params = [];

  if (q.team) {
    const t = Number(q.team);
    if (!teamIds.includes(t)) throw notFound('Team');
    where.push('i.team_id = ?'); params.push(t);
  } else {
    where.push(`i.team_id IN (${ph(teamIds)})`); params.push(...teamIds);
  }
  const inList = (col, raw, allowed) => {
    const vals = String(raw).split(',').filter(Boolean);
    if (vals.some((v) => !allowed.includes(v))) throw badRequest(`invalid ${col} filter`);
    where.push(`i.${col} IN (${ph(vals)})`); params.push(...vals);
  };
  if (q.status) inList('status', q.status, ['open', 'in_progress', 'blocked', 'resolved', 'closed']);
  if (q.priority) inList('priority', q.priority, Object.keys(PRIORITY_RANK));
  if (q.assignee === 'me') { where.push('i.assignee_id = ?'); params.push(user.id); }
  else if (q.assignee === 'unassigned') where.push('i.assignee_id IS NULL');
  else if (q.assignee) { where.push('i.assignee_id = ?'); params.push(Number(q.assignee)); }

  const view = viewPredicate(user, q.view, now);
  if (view) { where.push(view.sql); params.push(...view.params); }

  const fts = toFtsQuery(q.q);
  if (q.q && !fts) return { items: [], nextCursor: null };
  if (fts) { where.push('i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)'); params.push(fts); }

  const byPriority = q.sort === 'priority';
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
  if (q.cursor) {
    if (byPriority) { const [r, a, id] = decodeCursor(q.cursor, 3); where.push('(i.priority_rank, i.last_activity_at, i.id) < (?,?,?)'); params.push(r, a, id); }
    else { const [a, id] = decodeCursor(q.cursor, 2); where.push('(i.last_activity_at, i.id) < (?,?)'); params.push(a, id); }
  }
  const order = byPriority ? 'i.priority_rank DESC, i.last_activity_at DESC, i.id DESC' : 'i.last_activity_at DESC, i.id DESC';
  // Page first, join names after: otherwise the planner can drive the join from `teams` and sort every
  // row of the team before applying LIMIT (23 ms vs 0.1 ms on 30k items).
  const rows = db.prepare(
    `SELECT i.*, a.name AS assignee_name, c.name AS creator_name, t.name AS team_name
     FROM (SELECT i.* FROM items i WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?) i
     LEFT JOIN users a ON a.id = i.assignee_id
     JOIN users c ON c.id = i.creator_id
     JOIN teams t ON t.id = i.team_id
     ORDER BY ${order}`
  ).all(...params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(serializeItem),
    nextCursor: rows.length > limit && last
      ? encodeCursor(byPriority ? [last.priority_rank, last.last_activity_at, last.id] : [last.last_activity_at, last.id])
      : null,
  };
}

export function overview(db, user, now = Date.now()) {
  const teamIds = Object.keys(user.teams).map(Number);
  const out = {};
  for (const view of ['attention', 'mine', 'approval', 'unassigned', 'overdue', 'stale']) {
    if (!teamIds.length) { out[view] = 0; continue; }
    const p = viewPredicate(user, view, now);
    out[view] = db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE i.team_id IN (${ph(teamIds)}) AND ${p.sql}`)
      .get(...teamIds, ...p.params).n;
  }
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).n;
  return { counts: out, unreadNotifications: unread };
}
