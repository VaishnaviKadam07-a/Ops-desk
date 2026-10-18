import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { claimItem, createItem, transitionItem } from '../src/items.js';
import { processOutbox } from '../src/worker.js';
import { startServer, userObj } from './helpers.js';

describe('outbox worker', () => {
  let s;
  let bob; let alice;
  before(async () => {
    s = await startServer();
    bob = userObj(s.db, 'bob');
    alice = userObj(s.db, 'alice');
  });
  after(() => s.close());

  const notifCount = (userName) => s.db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ?').get(s.userId(userName)).n;

  test('the outbox row is written in the same transaction as the change (no change, no row)', () => {
    const item = createItem(s.db, bob, { teamId: s.teamId('Support'), title: 'Atomic' });
    const before = s.db.prepare('SELECT COUNT(*) n FROM outbox').get().n;
    // Claim by bob, then alice (a lead) tries a stale transition: it must fail AND leave no outbox row behind.
    claimItem(s.db, bob, item.id);
    const afterClaim = s.db.prepare('SELECT COUNT(*) n FROM outbox').get().n;
    assert.equal(afterClaim, before + 1);
    assert.throws(() => transitionItem(s.db, alice, item.id, 'in_progress', 1), (e) => e.status === 409);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, afterClaim);
  });

  test('delivers notifications, and running the same row twice does not duplicate them', () => {
    const item = createItem(s.db, alice, { teamId: s.teamId('Support'), title: 'Assign me' });
    claimItem(s.db, bob, item.id); // bob claims; the creator (alice) gets notified only for status/comments, not claim
    const row = s.db.prepare(`SELECT * FROM outbox WHERE topic = 'item.assigned' ORDER BY id DESC LIMIT 1`).get();

    // Use alice assigning bob so there is a non-actor recipient.
    s.db.prepare('UPDATE outbox SET status = ?, attempts = 0 WHERE id = ?').run('pending', row.id);
    const before = notifCount('bob');
    processOutbox(s.db);
    // actor == assignee for claim, so nobody is notified; now simulate a real assignment payload:
    s.db.prepare(`INSERT INTO outbox (topic, payload, dedupe_key, next_attempt_at, created_at) VALUES ('item.assigned', ?, 'dup-test', 0, 0)`)
      .run(JSON.stringify({ itemId: item.id, actorId: alice.id, assigneeId: bob.id }));
    processOutbox(s.db);
    assert.equal(notifCount('bob'), before + 1);

    // Simulate at-least-once redelivery of the same message.
    s.db.prepare(`UPDATE outbox SET status = 'pending' WHERE dedupe_key = 'dup-test'`).run();
    processOutbox(s.db);
    assert.equal(notifCount('bob'), before + 1, 'deduplicated by key');
  });

  test('a failing handler retries with backoff, then succeeds', () => {
    s.db.prepare(`INSERT INTO outbox (topic, payload, dedupe_key, next_attempt_at, created_at) VALUES ('item.comment', '{}', 'retry-1', 1000, 0)`).run();
    const boom = () => { throw new Error('smtp down'); };

    const r1 = processOutbox(s.db, { handler: boom, now: 1000 });
    assert.equal(r1.failed, 1);
    let row = s.db.prepare(`SELECT * FROM outbox WHERE dedupe_key = 'retry-1'`).get();
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'smtp down');
    assert.ok(row.next_attempt_at > 1000, 'backoff pushes the next attempt into the future');

    // Too early: not picked up.
    assert.equal(processOutbox(s.db, { handler: boom, now: 1001 }).failed, 0);

    // After the backoff, a healthy handler completes it.
    let ran = 0;
    const r2 = processOutbox(s.db, { handler: () => { ran++; }, now: row.next_attempt_at + 1 });
    assert.equal(r2.processed, 1);
    assert.equal(ran, 1);
    row = s.db.prepare(`SELECT * FROM outbox WHERE dedupe_key = 'retry-1'`).get();
    assert.equal(row.status, 'done');
  });

  test('repeated failures end up as visible dead letters instead of retrying forever', () => {
    s.db.prepare(`INSERT INTO outbox (topic, payload, dedupe_key, next_attempt_at, created_at) VALUES ('item.comment', '{}', 'dead-1', 0, 0)`).run();
    const boom = () => { throw new Error('nope'); };
    let now = 10_000_000;
    for (let i = 0; i < 6; i++) { processOutbox(s.db, { handler: boom, now, maxAttempts: 3 }); now += 10 * 60_000; }
    const row = s.db.prepare(`SELECT * FROM outbox WHERE dedupe_key = 'dead-1'`).get();
    assert.equal(row.status, 'dead');
    assert.equal(row.attempts, 3);
  });

  test('a row left "processing" by a crashed worker is picked up again after its lock expires', () => {
    s.db.prepare(`INSERT INTO outbox (topic, payload, dedupe_key, status, locked_until, attempts, next_attempt_at, created_at)
                  VALUES ('item.comment', '{}', 'crash-1', 'processing', 5000, 1, 0, 0)`).run();
    let ran = 0;
    assert.equal(processOutbox(s.db, { handler: () => { ran++; }, now: 4000 }).processed, 0, 'still locked');
    assert.equal(processOutbox(s.db, { handler: () => { ran++; }, now: 6000 }).processed, 1);
    assert.equal(ran, 1);
  });

  test('a handler that throws halfway leaves no partial effects', () => {
    s.db.prepare(`INSERT INTO outbox (topic, payload, dedupe_key, next_attempt_at, created_at) VALUES ('item.comment', '{}', 'partial-1', 0, 0)`).run();
    const before = s.db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
    processOutbox(s.db, {
      now: 20_000_000,
      handler: (db) => {
        db.prepare(`INSERT INTO notifications (user_id, message, dedupe_key, created_at) VALUES (?, 'half', 'half-1', 0)`).run(bob.id);
        throw new Error('crash after insert');
      },
    });
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM notifications').get().n, before);
  });

  test('end to end: a comment produces a notification for the assignee via the API', async () => {
    const carol = await s.as('carol');
    const bobApi = await s.as('bob');
    const item = (await carol('POST', '/api/items', { teamId: s.teamId('Support'), title: 'Notify flow' })).body.item;
    await bobApi('POST', `/api/items/${item.id}/claim`);
    await carol('POST', `/api/items/${item.id}/comments`, { body: 'any update?' });
    processOutbox(s.db, { now: Date.now() + 1 });
    const list = (await bobApi('GET', '/api/notifications')).body.notifications;
    assert.ok(list.some((n) => n.itemId === item.id && /Carol Mehta commented/.test(n.message)));
    const ov = (await bobApi('GET', '/api/overview')).body;
    assert.ok(ov.unreadNotifications >= 1);
  });
});
