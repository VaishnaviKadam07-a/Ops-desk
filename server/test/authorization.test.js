import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { makeItem, startServer } from './helpers.js';

describe('authorization is enforced by the server', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('requests without a valid token are rejected', async () => {
    assert.equal((await s.raw('GET', '/api/items')).status, 401);
    assert.equal((await s.raw('GET', '/api/items', { token: 'nope' })).status, 401);
  });

  test('wrong password and unknown user get the same answer', async () => {
    const a = await s.raw('POST', '/api/auth/login', { body: { email: 'bob@example.com', password: 'wrong' } });
    const b = await s.raw('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'wrong' } });
    assert.equal(a.status, 401);
    assert.deepEqual(a.body, b.body);
  });

  test('viewers can read but cannot create, comment, claim or edit', async () => {
    const bob = await s.as('bob');
    const dave = await s.as('dave');
    const item = await makeItem(bob, s.teamId('Support'));
    assert.equal((await dave('GET', `/api/items/${item.id}`)).status, 200);
    assert.equal((await dave('POST', '/api/items', { teamId: s.teamId('Support'), title: 'x' })).status, 403);
    assert.equal((await dave('POST', `/api/items/${item.id}/comments`, { body: 'hi' })).status, 403);
    assert.equal((await dave('POST', `/api/items/${item.id}/claim`)).status, 403);
    assert.equal((await dave('PATCH', `/api/items/${item.id}`, { title: 'x', version: 1 })).status, 403);
  });

  test('items in other teams are invisible: 404 on direct access, absent from lists and search', async () => {
    const bob = await s.as('bob');
    const frank = await s.as('frank'); // Finance only
    const item = await makeItem(bob, s.teamId('Support'), { title: 'Confidential refund matter' });
    assert.equal((await frank('GET', `/api/items/${item.id}`)).status, 404);
    assert.equal((await frank('GET', `/api/items/${item.id}/events`)).status, 404);
    assert.equal((await frank('POST', `/api/items/${item.id}/claim`)).status, 404);
    assert.equal((await frank('POST', `/api/items/${item.id}/comments`, { body: 'hi' })).status, 404);
    const list = await frank('GET', '/api/items?q=confidential');
    assert.equal(list.body.items.length, 0);
    assert.equal((await frank('GET', `/api/items?team=${s.teamId('Support')}`)).status, 404);
    assert.equal((await frank('POST', '/api/items', { teamId: s.teamId('Support'), title: 'sneaky' })).status, 404);
  });

  test('members can only change items they created or hold; leads can change any item in their team', async () => {
    const carol = await s.as('carol');
    const bob = await s.as('bob');
    const alice = await s.as('alice');
    const item = await makeItem(carol, s.teamId('Support'));
    const byBob = await bob('PATCH', `/api/items/${item.id}`, { title: 'hijack', version: 1 });
    assert.equal(byBob.status, 403);
    const byAlice = await alice('PATCH', `/api/items/${item.id}`, { title: 'lead edit', version: 1 });
    assert.equal(byAlice.status, 200);
  });

  test('leadership in one team does not carry over to another', async () => {
    // Alice leads Support + Engineering, but has no access to Finance.
    const alice = await s.as('alice');
    const erin = await s.as('erin');
    const item = await makeItem(erin, s.teamId('Finance'));
    assert.equal((await alice('GET', `/api/items/${item.id}`)).status, 404);
  });

  test('only leads can assign, and only to members/leads of the same team', async () => {
    const bob = await s.as('bob');
    const alice = await s.as('alice');
    const item = await makeItem(bob, s.teamId('Support'));
    assert.equal((await bob('POST', `/api/items/${item.id}/assign`, { assigneeId: s.userId('carol'), version: 1 })).status, 403);
    assert.equal((await alice('POST', `/api/items/${item.id}/assign`, { assigneeId: s.userId('dave'), version: 1 })).status, 400, 'viewer');
    assert.equal((await alice('POST', `/api/items/${item.id}/assign`, { assigneeId: s.userId('frank'), version: 1 })).status, 400, 'other team');
    const ok = await alice('POST', `/api/items/${item.id}/assign`, { assigneeId: s.userId('carol'), version: 1 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.assignee.id, s.userId('carol'));
  });

  test('nobody can approve their own request (separation of duties)', async () => {
    const erin = await s.as('erin'); // the only Finance lead
    const item = await makeItem(erin, s.teamId('Finance'), { requiresApproval: true });
    const r = await erin('POST', `/api/items/${item.id}/approval`, { decision: 'approve', version: item.version });
    assert.equal(r.status, 403);
  });

  test('the detail endpoint tells the UI what the caller may do, matching what the server enforces', async () => {
    const bob = await s.as('bob');
    const alice = await s.as('alice');
    const item = await makeItem(bob, s.teamId('Support'));
    const asBob = (await bob('GET', `/api/items/${item.id}`)).body;
    const asAlice = (await alice('GET', `/api/items/${item.id}`)).body;
    assert.equal(asBob.can.assign, false);
    assert.equal(asAlice.can.assign, true);
    assert.equal(asBob.can.edit, true); // creator
  });
});
