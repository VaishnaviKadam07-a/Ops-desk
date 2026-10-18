import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { makeItem, startServer } from './helpers.js';

describe('workflow rules', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  const move = (call, item, to) => call('POST', `/api/items/${item.id}/transition`, { to, version: item.version });

  test('work cannot start on an unowned item', async () => {
    const bob = await s.as('bob');
    const alice = await s.as('alice'); // a lead may transition any item, so the rule itself is what stops her
    const item = await makeItem(bob, s.teamId('Support'));
    assert.equal((await move(bob, item, 'in_progress')).status, 403, 'creator who is not the assignee is not allowed either');
    const r = await move(alice, item, 'in_progress');
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'needs_assignee');
  });

  test('illegal jumps are refused and the response lists what is allowed', async () => {
    const bob = await s.as('bob');
    const item = (await bob('POST', `/api/items/${(await makeItem(bob, s.teamId('Support'))).id}/claim`)).body.item;
    const r = await move(bob, item, 'resolved');
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'invalid_transition');
    assert.ok(r.body.error.allowed.includes('in_progress'));
  });

  test('items that need approval cannot be started until a different lead approves', async () => {
    const frank = await s.as('frank');
    const erin = await s.as('erin');
    let item = await makeItem(frank, s.teamId('Finance'), { requiresApproval: true });
    assert.equal(item.approvalState, 'pending');
    item = (await frank('POST', `/api/items/${item.id}/claim`)).body.item;

    const blocked = await move(frank, item, 'in_progress');
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error.code, 'needs_approval');

    const notLead = await frank('POST', `/api/items/${item.id}/approval`, { decision: 'approve', version: item.version });
    assert.equal(notLead.status, 403);

    const approved = await erin('POST', `/api/items/${item.id}/approval`, { decision: 'approve', note: 'ok', version: item.version });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.item.approvalState, 'approved');

    const started = await move(frank, approved.body.item, 'in_progress');
    assert.equal(started.status, 200);
    assert.equal(started.body.item.status, 'in_progress');

    // A decision can only be made once.
    const again = await erin('POST', `/api/items/${item.id}/approval`, { decision: 'reject', version: started.body.item.version });
    assert.equal(again.status, 422);
  });

  test('rejecting an approval closes the item', async () => {
    const frank = await s.as('frank');
    const erin = await s.as('erin');
    const item = await makeItem(frank, s.teamId('Finance'), { requiresApproval: true });
    const r = await erin('POST', `/api/items/${item.id}/approval`, { decision: 'reject', note: 'no budget', version: item.version });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.status, 'closed');
    assert.equal(r.body.item.approvalState, 'rejected');
  });

  test('only the assignee or a lead may change status; only a lead may close', async () => {
    const bob = await s.as('bob');
    const carol = await s.as('carol');
    const alice = await s.as('alice');
    let item = await makeItem(bob, s.teamId('Support'));
    item = (await bob('POST', `/api/items/${item.id}/claim`)).body.item;

    assert.equal((await move(carol, item, 'in_progress')).status, 403, 'bystander member');
    item = (await move(bob, item, 'in_progress')).body.item;
    item = (await move(bob, item, 'resolved')).body.item;
    assert.equal((await move(bob, item, 'closed')).status, 403, 'assignee cannot close');
    const closed = await move(alice, item, 'closed');
    assert.equal(closed.status, 200);
    assert.equal((await move(alice, closed.body.item, 'open')).status, 422, 'closed is terminal');
  });

  test('a claimed item can be released by its owner but not while in progress', async () => {
    const bob = await s.as('bob');
    let item = await makeItem(bob, s.teamId('Support'));
    item = (await bob('POST', `/api/items/${item.id}/claim`)).body.item;
    item = (await move(bob, item, 'in_progress')).body.item;
    const early = await bob('POST', `/api/items/${item.id}/release`, { version: item.version });
    assert.equal(early.status, 422);
    item = (await move(bob, item, 'open')).body.item;
    const ok = await bob('POST', `/api/items/${item.id}/release`, { version: item.version });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.assignee, null);
  });
});

describe('history', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('every change is recorded in order with who did it', async () => {
    const bob = await s.as('bob');
    const alice = await s.as('alice');
    let item = await makeItem(bob, s.teamId('Support'), { priority: 'low' });
    item = (await alice('PATCH', `/api/items/${item.id}`, { priority: 'urgent', version: item.version })).body.item;
    item = (await bob('POST', `/api/items/${item.id}/claim`)).body.item;
    await bob('POST', `/api/items/${item.id}/comments`, { body: 'on it' });
    await bob('POST', `/api/items/${item.id}/transition`, { to: 'in_progress', version: item.version });

    const detail = (await bob('GET', `/api/items/${item.id}`)).body;
    const types = detail.events.map((e) => e.type).reverse();
    assert.deepEqual(types, ['created', 'priority_changed', 'assigned', 'comment', 'status_changed']);
    const pc = detail.events.find((e) => e.type === 'priority_changed');
    assert.equal(pc.actor.name, 'Alice Rao');
    assert.deepEqual(pc.data.priority, { from: 'low', to: 'urgent' });
  });

  test('history is append-only even at the database level', async () => {
    const bob = await s.as('bob');
    const item = await makeItem(bob, s.teamId('Support'));
    assert.throws(() => s.db.prepare('UPDATE item_events SET type = ? WHERE item_id = ?').run('x', item.id), /append-only/);
    assert.throws(() => s.db.prepare('DELETE FROM item_events WHERE item_id = ?').run(item.id), /append-only/);
  });

  test('events paginate with a cursor', async () => {
    const bob = await s.as('bob');
    const item = await makeItem(bob, s.teamId('Support'));
    for (let i = 0; i < 7; i++) await bob('POST', `/api/items/${item.id}/comments`, { body: `c${i}` });
    const p1 = (await bob('GET', `/api/items/${item.id}/events?limit=5`)).body;
    assert.equal(p1.events.length, 5);
    assert.ok(p1.nextCursor);
    const p2 = (await bob('GET', `/api/items/${item.id}/events?limit=5&cursor=${p1.nextCursor}`)).body;
    assert.equal(p2.events.length, 3); // 7 comments + created = 8
    assert.equal(p2.nextCursor, null);
    const ids = [...p1.events, ...p2.events].map((e) => e.id);
    assert.equal(new Set(ids).size, 8);
  });
});
