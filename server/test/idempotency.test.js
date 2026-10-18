import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { key, makeItem, startServer } from './helpers.js';

describe('idempotent retries', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('repeating a create with the same key returns the same item and creates one row', async () => {
    const bob = await s.as('bob');
    const k = key();
    const body = { teamId: s.teamId('Support'), title: 'Double click me' };
    const first = await bob('POST', '/api/items', body, { 'Idempotency-Key': k });
    const second = await bob('POST', '/api/items', body, { 'Idempotency-Key': k });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.item.id, first.body.item.id);
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM items WHERE title = 'Double click me'`).get().n, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM item_events WHERE item_id = ?').get(first.body.item.id).n, 1);
  });

  test('ten simultaneous identical requests create exactly one item', async () => {
    const bob = await s.as('bob');
    const k = key();
    const body = { teamId: s.teamId('Support'), title: 'Burst create' };
    const res = await Promise.all(Array.from({ length: 10 }, () => bob('POST', '/api/items', body, { 'Idempotency-Key': k })));
    assert.ok(res.every((r) => r.status === 201));
    assert.equal(new Set(res.map((r) => r.body.item.id)).size, 1);
    assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM items WHERE title = 'Burst create'`).get().n, 1);
  });

  test('reusing a key for a different request is rejected, not silently replayed', async () => {
    const bob = await s.as('bob');
    const k = key();
    await bob('POST', '/api/items', { teamId: s.teamId('Support'), title: 'A' }, { 'Idempotency-Key': k });
    const other = await bob('POST', '/api/items', { teamId: s.teamId('Support'), title: 'B' }, { 'Idempotency-Key': k });
    assert.equal(other.status, 422);
    assert.equal(other.body.error.code, 'idempotency_key_reuse');
  });

  test('keys are scoped per user', async () => {
    const bob = await s.as('bob');
    const carol = await s.as('carol');
    const k = key();
    const a = await bob('POST', '/api/items', { teamId: s.teamId('Support'), title: 'Same key' }, { 'Idempotency-Key': k });
    const b = await carol('POST', '/api/items', { teamId: s.teamId('Support'), title: 'Same key' }, { 'Idempotency-Key': k });
    assert.notEqual(a.body.item.id, b.body.item.id);
  });

  test('a failed request leaves no key behind, so a retry is evaluated fresh', async () => {
    const bob = await s.as('bob');
    const k = key();
    const bad = await bob('POST', '/api/items', { teamId: s.teamId('Support'), title: '' }, { 'Idempotency-Key': k });
    assert.equal(bad.status, 400);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM idempotency_keys WHERE key = ?').get(k).n, 0);
    // Same key, same request, now valid: it is processed rather than replaying the old error.
    const retry = await bob('POST', '/api/items', { teamId: s.teamId('Support'), title: '' }, { 'Idempotency-Key': k });
    assert.equal(retry.status, 400);
    assert.equal(retry.headers.get('idempotent-replay'), null, 'errors are never replayed from cache');
  });

  test('a repeated comment submission with the same key posts once', async () => {
    const bob = await s.as('bob');
    const item = await makeItem(bob, s.teamId('Support'));
    const k = key();
    await bob('POST', `/api/items/${item.id}/comments`, { body: 'hello' }, { 'Idempotency-Key': k });
    await bob('POST', `/api/items/${item.id}/comments`, { body: 'hello' }, { 'Idempotency-Key': k });
    assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM item_events WHERE item_id = ? AND type = 'comment'`).get(item.id).n, 1);
  });
});
