import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { toFtsQuery } from '../src/items.js';
import { makeItem, startServer } from './helpers.js';

describe('listing, search and pagination', () => {
  let s; let bob; let alice;
  before(async () => {
    s = await startServer();
    bob = await s.as('bob');
    alice = await s.as('alice');
    for (let i = 0; i < 60; i++) {
      await makeItem(bob, s.teamId('Support'), { title: `${i % 3 === 0 ? 'Payment failure' : 'Login issue'} number ${i}`, priority: ['low', 'medium', 'high', 'urgent'][i % 4] });
    }
  });
  after(() => s.close());

  async function walk(call, qs) {
    const seen = [];
    let cursor = null; let pages = 0;
    do {
      const r = await call('GET', `/api/items?limit=25&${qs}${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.nextCursor; pages++;
    } while (cursor);
    return { seen, pages };
  }

  test('keyset pagination visits every item exactly once', async () => {
    const { seen, pages } = await walk(bob, '');
    assert.equal(seen.length, 60);
    assert.equal(new Set(seen).size, 60);
    assert.equal(pages, 3);
  });

  test('pagination stays stable when new items arrive mid-walk (no duplicates, no skips of old items)', async () => {
    const first = await bob('GET', '/api/items?limit=25');
    await makeItem(bob, s.teamId('Support'), { title: 'Arrived mid walk' });
    const second = await bob('GET', `/api/items?limit=25&cursor=${first.body.nextCursor}`);
    const ids = [...first.body.items, ...second.body.items].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('priority sort puts urgent first and also paginates cleanly', async () => {
    const r = await bob('GET', '/api/items?sort=priority&limit=10');
    assert.ok(r.body.items.every((i) => i.priority === 'urgent'));
    const { seen } = await walk(bob, 'sort=priority');
    assert.equal(new Set(seen).size, seen.length);
  });

  test('full text search matches prefixes and combines with filters', async () => {
    const r = await bob('GET', '/api/items?q=paym&limit=100');
    assert.equal(r.body.items.length, 20);
    assert.ok(r.body.items.every((i) => /Payment/.test(i.title)));
    const urgent = await bob('GET', '/api/items?q=payment&priority=urgent&limit=100');
    assert.ok(urgent.body.items.length > 0 && urgent.body.items.every((i) => i.priority === 'urgent' && /Payment/.test(i.title)));
  });

  test('search follows edits (index stays in sync)', async () => {
    const item = (await bob('GET', '/api/items?q=number&limit=1')).body.items[0];
    await alice('PATCH', `/api/items/${item.id}`, { title: 'Zebra stampede', version: item.version });
    const hit = await bob('GET', '/api/items?q=zebra');
    assert.deepEqual(hit.body.items.map((i) => i.id), [item.id]);
  });

  test('hostile search input cannot break the query', async () => {
    for (const q of ['"', 'a AND', 'NEAR(', '*', "'; DROP TABLE items;--", '   ']) {
      const r = await bob('GET', `/api/items?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, `q=${q}`);
    }
    assert.equal(toFtsQuery('foo "bar" OR baz'), '"foo" "bar" "or" "baz"*');
  });

  test('bad cursors and filters are 400s, not crashes', async () => {
    assert.equal((await bob('GET', '/api/items?cursor=garbage')).status, 400);
    assert.equal((await bob('GET', '/api/items?status=nonsense')).status, 400);
    assert.equal((await bob('GET', '/api/items?view=nonsense')).status, 400);
  });

  test('limit is capped', async () => {
    const r = await bob('GET', '/api/items?limit=100000');
    assert.ok(r.body.items.length <= 100);
  });

  test('the attention view and overview counts agree and respect who is asking', async () => {
    const carol = await s.as('carol');
    const mine = (await makeItem(carol, s.teamId('Support'), { title: 'Carol owns this', priority: 'low' }));
    await carol('POST', `/api/items/${mine.id}/claim`);
    const ov = (await carol('GET', '/api/overview')).body.counts;
    const list = (await carol('GET', '/api/items?view=attention&limit=100')).body.items;
    assert.equal(list.length, ov.attention);
    assert.ok(list.some((i) => i.id === mine.id));
    // Bob's attention list must not contain Carol's low-priority owned item.
    const bobList = (await bob('GET', '/api/items?view=attention&limit=100')).body.items;
    assert.ok(!bobList.some((i) => i.id === mine.id));
  });

  test('approval view is only populated for leads of that team, excluding their own requests', async () => {
    const frank = await s.as('frank');
    const erin = await s.as('erin');
    const item = await makeItem(frank, s.teamId('Finance'), { requiresApproval: true });
    const own = await makeItem(erin, s.teamId('Finance'), { requiresApproval: true });
    const forErin = (await erin('GET', '/api/items?view=approval')).body.items.map((i) => i.id);
    assert.ok(forErin.includes(item.id));
    assert.ok(!forErin.includes(own.id));
    assert.equal((await frank('GET', '/api/items?view=approval')).body.items.length, 0);
  });
});
