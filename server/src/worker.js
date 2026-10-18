import { tx } from './db.js';

/**
 * Outbox worker: delivers secondary effects (notifications) after the primary action committed.
 *
 * Guarantees:
 *  - at-least-once: a row stays 'pending'/'processing' until its effects are committed;
 *  - safe duplicates: effects use deduplication keys, so running a row twice produces one notification;
 *  - crash recovery: rows stuck in 'processing' past their lock are picked up again;
 *  - failures retry with exponential backoff, then park as 'dead' (visible, never silently lost).
 */
export function processOutbox(db, opts = {}) {
  const { handler = defaultHandler, now = Date.now(), batch = 20, maxAttempts = 5, lockMs = 30_000 } = opts;

  const claimed = tx(db, () => {
    const rows = db.prepare(
      `SELECT * FROM outbox
       WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND locked_until < ?)
       ORDER BY id LIMIT ?`
    ).all(now, now, batch);
    const lock = db.prepare(`UPDATE outbox SET status = 'processing', locked_until = ?, attempts = attempts + 1 WHERE id = ?`);
    for (const r of rows) lock.run(now + lockMs, r.id);
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });

  const result = { processed: 0, failed: 0, dead: 0 };
  for (const row of claimed) {
    try {
      // Effects and the 'done' mark commit together.
      tx(db, () => {
        handler(db, row, now);
        db.prepare(`UPDATE outbox SET status = 'done', locked_until = NULL, last_error = NULL WHERE id = ?`).run(row.id);
      });
      result.processed++;
    } catch (err) {
      const dead = row.attempts >= maxAttempts;
      const backoff = Math.min(2 ** row.attempts * 1000, 5 * 60_000);
      db.prepare(
        `UPDATE outbox SET status = ?, locked_until = NULL, next_attempt_at = ?, last_error = ? WHERE id = ?`
      ).run(dead ? 'dead' : 'pending', now + backoff, String(err?.message || err).slice(0, 500), row.id);
      dead ? result.dead++ : result.failed++;
    }
  }
  return result;
}

function notify(db, row, userId, itemId, message, now) {
  db.prepare(
    `INSERT OR IGNORE INTO notifications (user_id, item_id, message, dedupe_key, created_at) VALUES (?,?,?,?,?)`
  ).run(userId, itemId, message, `${row.dedupe_key}:${userId}`, now);
}

export function defaultHandler(db, row, now) {
  const p = JSON.parse(row.payload);
  const item = db.prepare('SELECT id, title, team_id, creator_id, assignee_id FROM items WHERE id = ?').get(p.itemId);
  if (!item) return; // item vanished; nothing to notify about
  const actor = p.actorId ? db.prepare('SELECT name FROM users WHERE id = ?').get(p.actorId) : null;
  const who = actor?.name || 'Someone';
  const title = item.title.length > 80 ? `${item.title.slice(0, 77)}...` : item.title;
  const skipActor = (id) => id && id !== p.actorId;

  switch (row.topic) {
    case 'item.assigned':
      if (skipActor(p.assigneeId)) notify(db, row, p.assigneeId, item.id, `${who} assigned you "${title}"`, now);
      break;
    case 'item.approval_requested': {
      const leads = db.prepare(`SELECT user_id FROM memberships WHERE team_id = ? AND role = 'lead'`).all(item.team_id);
      for (const l of leads) if (skipActor(l.user_id)) notify(db, row, l.user_id, item.id, `Approval needed: "${title}"`, now);
      break;
    }
    case 'item.approval_decided':
      if (skipActor(item.creator_id)) notify(db, row, item.creator_id, item.id, `${who} ${p.decision === 'approve' ? 'approved' : 'rejected'} "${title}"`, now);
      break;
    case 'item.comment':
      for (const id of new Set([item.creator_id, item.assignee_id])) {
        if (skipActor(id)) notify(db, row, id, item.id, `${who} commented on "${title}"`, now);
      }
      break;
    case 'item.status_changed':
      if (skipActor(item.creator_id)) notify(db, row, item.creator_id, item.id, `"${title}" moved to ${p.to.replace('_', ' ')}`, now);
      break;
    default:
      throw new Error(`Unknown outbox topic: ${row.topic}`);
  }
}

export function startWorker(db, intervalMs = 2000, log = console) {
  const timer = setInterval(() => {
    try {
      const r = processOutbox(db);
      if (r.failed || r.dead) log.warn?.('[worker]', r);
    } catch (err) {
      log.error?.('[worker] loop error', err);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
