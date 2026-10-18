import crypto from 'node:crypto';
import { tx } from './db.js';
import { HttpError } from './errors.js';

const fingerprint = (req) =>
  crypto.createHash('sha256').update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`).digest('hex');

/**
 * Runs `fn` (which must return { status, body }) exactly once per (user, Idempotency-Key).
 *
 * The key row is written in the SAME transaction as the business change, so either both exist or neither.
 * A retry with the same key replays the stored response; the same key with a different request is rejected.
 * Without a header the handler still runs transactionally, just without replay protection.
 * Only successful results are stored, so a failed attempt can safely be retried.
 */
export function idempotent(db, req, fn) {
  const key = req.get('Idempotency-Key');
  if (key && (key.length < 8 || key.length > 128)) {
    throw new HttpError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-128 characters');
  }
  return tx(db, () => {
    if (!key) return fn();
    const fp = fingerprint(req);
    const prior = db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?').get(req.user.id, key);
    if (prior) {
      if (prior.fingerprint !== fp) {
        throw new HttpError(422, 'idempotency_key_reuse', 'This Idempotency-Key was already used for a different request');
      }
      return { status: prior.status, body: JSON.parse(prior.response), replayed: true };
    }
    const result = fn();
    db.prepare('INSERT INTO idempotency_keys (user_id, key, fingerprint, status, response, created_at) VALUES (?,?,?,?,?,?)')
      .run(req.user.id, key, fp, result.status, JSON.stringify(result.body), Date.now());
    return result;
  });
}
