import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeItem, startServer } from './helpers.js';

describe('concurrent claims', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('of many simultaneous claims by two users, exactly one user wins', async () => {
    const bob = await s.as('bob');
    const carol = await s.as('carol');
    const item = await makeItem(bob, s.teamId('Support'));

    const attempts = await Promise.all([
      ...Array.from({ length: 10 }, () => bob('POST', `/api/items/${item.id}/claim`)),
      ...Array.from({ length: 10 }, () => carol('POST', `/api/items/${item.id}/claim`)),
    ]);

    const final = (await bob('GET', `/api/items/${item.id}`)).body.item;
    const winner = final.assignee.id;
    const winnerName = winner === s.userId('bob') ? 'bob' : 'carol';
    const results = attempts.map((r, i) => ({ r, user: i < 10 ? 'bob' : 'carol' }));

    // The winner's requests all succeed (one real change, the rest are safe retries)...
    for (const { r, user } of results.filter((x) => x.user === winnerName)) assert.equal(r.status, 200);
    assert.equal(results.filter((x) => x.user === winnerName && x.r.body.changed).length, 1);
    // ...and the loser always gets a clear 409 that names the winner.
    for (const { r } of results.filter((x) => x.user !== winnerName)) {
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'already_claimed');
      assert.equal(r.body.error.current.assignee.id, winner);
    }
    const assignedEvents = s.db.prepare(`SELECT COUNT(*) n FROM item_events WHERE item_id = ? AND type = 'assigned'`).get(item.id).n;
    assert.equal(assignedEvents, 1, 'history records exactly one assignment');
    assert.equal(final.version, 2, 'exactly one version bump');
  });

  test('claim stays correct across two separate database connections (two server processes)', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')), 'shared.db');
    const a = await startServer({ file });
    // Second "process": same file, its own connection and HTTP server.
    const { openDb } = await import('../src/db.js');
    const { createApp } = await import('../src/app.js');
    const db2 = openDb(file);
    const server2 = await new Promise((r) => { const sv = createApp(db2).listen(0, () => r(sv)); });
    const url2 = `http://127.0.0.1:${server2.address().port}`;
    try {
      const bobA = await a.as('bob');
      const item = await makeItem(bobA, a.teamId('Support'));
      const login2 = await fetch(`${url2}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'carol@example.com', password: 'password123' }),
      }).then((r) => r.json());
      const carolOn2 = () => fetch(`${url2}/api/items/${item.id}/claim`, { method: 'POST', headers: { authorization: `Bearer ${login2.token}` } });

      const res = await Promise.all([
        ...Array.from({ length: 8 }, () => bobA('POST', `/api/items/${item.id}/claim`)),
        ...Array.from({ length: 8 }, carolOn2),
      ]);
      const events = a.db.prepare(`SELECT COUNT(*) n FROM item_events WHERE item_id = ? AND type = 'assigned'`).get(item.id).n;
      assert.equal(events, 1);
      assert.ok(res.some((r) => r.status === 409), 'someone lost');
      assert.ok(res.every((r) => [200, 409].includes(r.status)), 'no 5xx under cross-connection contention');
    } finally {
      await new Promise((r) => server2.close(r));
      await a.close();
    }
  });
});

describe('stale updates (optimistic concurrency)', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('an edit based on an old version is rejected with the current state, and nothing is lost', async () => {
    const bob = await s.as('bob');
    const alice = await s.as('alice');
    const item = await makeItem(bob, s.teamId('Support'), { title: 'Original' });

    const first = await alice('PATCH', `/api/items/${item.id}`, { title: 'Alice title', version: item.version });
    assert.equal(first.status, 200);

    // Bob still has version 1 open in his browser.
    const stale = await bob('PATCH', `/api/items/${item.id}`, { description: 'Bob text', version: item.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.equal(stale.body.error.current.title, 'Alice title');
    assert.equal(stale.body.error.current.version, 2);

    const after = (await bob('GET', `/api/items/${item.id}`)).body.item;
    assert.equal(after.description, 'desc', "bob's stale write was not applied");
    assert.equal(after.title, 'Alice title', "alice's write was not overwritten");

    // Retrying against the fresh version works.
    const retry = await bob('PATCH', `/api/items/${item.id}`, { description: 'Bob text', version: 2 });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.item.version, 3);
  });

  test('If-Match header works and a missing version is refused with 428', async () => {
    const bob = await s.as('bob');
    const item = await makeItem(bob, s.teamId('Support'));
    const noVersion = await bob('PATCH', `/api/items/${item.id}`, { title: 'x' });
    assert.equal(noVersion.status, 428);
    const ok = await bob('PATCH', `/api/items/${item.id}`, { title: 'via header' }, { 'If-Match': `"${item.version}"` });
    assert.equal(ok.status, 200);
  });

  test('concurrent status changes from the same version: only one applies', async () => {
    const alice = await s.as('alice');
    const item = await makeItem(alice, s.teamId('Support'));
    const claimed = (await alice('POST', `/api/items/${item.id}/claim`)).body.item;
    const [a, b] = await Promise.all([
      alice('POST', `/api/items/${item.id}/transition`, { to: 'in_progress', version: claimed.version }),
      alice('POST', `/api/items/${item.id}/transition`, { to: 'blocked', version: claimed.version }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const events = s.db.prepare(`SELECT COUNT(*) n FROM item_events WHERE item_id = ? AND type = 'status_changed'`).get(item.id).n;
    assert.equal(events, 1);
  });

  test('comments do not bump the version, so they never invalidate someone else\'s edit', async () => {
    const bob = await s.as('bob');
    const carol = await s.as('carol');
    const item = await makeItem(bob, s.teamId('Support'));
    const c = await carol('POST', `/api/items/${item.id}/comments`, { body: 'I looked at this' });
    assert.equal(c.status, 201);
    const edit = await bob('PATCH', `/api/items/${item.id}`, { title: 'Still editable', version: item.version });
    assert.equal(edit.status, 200);
  });
});
