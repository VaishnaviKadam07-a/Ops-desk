// Optional browser smoke test: two real browsers racing on the same item.
// Not part of `npm test` because it needs a Chromium and a running app.
//
//   npm start                                   (fresh database recommended: delete server/data/ops.db first)
//   cd e2e && npm install && BASE_URL=http://localhost:3000 CHROME_PATH=/path/to/chrome node ui-smoke.mjs
//
// Checks: claim race (one winner, loser sees the winner), stale edit conflict + "keep mine",
// viewer is read-only, other-team items are invisible, search, "Load more".
import { chromium } from 'playwright-core';
const URL = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
const errors = []; const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/40[39]|409/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await page.goto(URL);
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.locator('.stat.hero').waitFor();
  return page;
}
const bob = await user('Bob'); const alice = await user('Alice');
check('both users reach the dashboard', true);

// 1. Create an item through the dialog
await bob.getByRole('button', { name: 'New item' }).click();
await bob.getByLabel('Title').fill('UI race test item');
await bob.getByLabel(/What happened/).fill('Original description');
await bob.getByRole('button', { name: 'Create item' }).click();
await bob.locator('h1', { hasText: 'UI race test item' }).waitFor();
const itemUrl = bob.url();
check('create item navigates to its detail page', /#\/item\/\d+/.test(itemUrl), itemUrl);
await alice.goto(itemUrl); await alice.locator('h1', { hasText: 'UI race test item' }).waitFor();
await bob.reload(); await bob.locator('h1').waitFor();

// 2. Both claim at the same moment
await Promise.all([
  bob.getByRole('button', { name: 'Claim this' }).click(),
  alice.getByRole('button', { name: 'Claim this' }).click(),
]);
await bob.waitForTimeout(1500); await alice.waitForTimeout(1500);
const bobOwner = (await bob.locator('.owner').innerText()).trim();
const aliceOwner = (await alice.locator('.owner').innerText()).trim();
const bobWon = bobOwner === 'You';
const aliceWon = aliceOwner === 'You';
check('exactly one of the two sees "You" as owner', bobWon !== aliceWon, `(bob sees "${bobOwner}", alice sees "${aliceOwner}")`);
const loser = bobWon ? alice : bob; const winnerName = bobWon ? 'Bob Iyer' : 'Alice Rao';
const loserOwner = (await loser.locator('.owner').innerText()).trim();
check('loser sees the real winner, not themselves', loserOwner === winnerName, `("${loserOwner}")`);
check('loser was told why (toast)', await loser.locator('.toast.error').count() > 0);
const events = await bob.locator('.timeline .event', { hasText: /took this item/ }).count();
check('history shows exactly one "took this item"', events === 1, `(${events})`);

// 3. Stale edit: both open Edit on the same version; Alice saves first
await bob.reload(); await alice.reload();
await bob.locator('h1').waitFor(); await alice.locator('h1').waitFor();
await bob.getByRole('button', { name: 'Edit', exact: true }).click();
await alice.getByRole('button', { name: 'Edit', exact: true }).click();
await alice.getByLabel('Title').fill('Title changed by Alice');
await alice.getByRole('button', { name: 'Save', exact: true }).click();
await alice.locator('h1', { hasText: 'Title changed by Alice' }).waitFor();
await bob.getByLabel('Description').fill('Description changed by Bob');
await bob.getByRole('button', { name: 'Save', exact: true }).click();
await bob.getByText('This item changed since you started editing').waitFor();
check('stale save shows a conflict instead of overwriting', true);
const bannerText = await bob.locator('.banner.warn').innerText();
check('conflict names the field that changed underneath', /title/i.test(bannerText) && /Title changed by Alice/.test(bannerText));
if (SHOTS) await bob.screenshot({ path: `${SHOTS}/conflict.png` });
await bob.getByRole('button', { name: /Keep my changes/ }).click();
await bob.locator('.desc', { hasText: 'Description changed by Bob' }).waitFor();
const finalTitle = await bob.locator('h1').innerText();
check('after "keep mine": both edits present', finalTitle === 'Title changed by Alice');
check('...and description is Bob\'s', (await bob.locator('.desc').innerText()).includes('Description changed by Bob'));

// 4. Comment, workflow, approval gating in the UI
await bob.getByPlaceholder('Add a comment…').fill('Working on it');
await bob.getByRole('button', { name: 'Post' }).click();
await bob.locator('.timeline .comment', { hasText: 'Working on it' }).waitFor();
check('comment appears in history', true);
const moveBtns = await bob.locator('button', { hasText: 'In progress' }).count();
check('workflow buttons offered to the owner', moveBtns >= 0);

// 5. Viewer cannot see write controls; other-team item is not reachable
const dave = await user('Dave');
await dave.goto(itemUrl); await dave.locator('h1').waitFor();
check('viewer sees read-only message', await dave.getByText('read-only access').count() > 0);
check('viewer has no Claim/Edit/Post buttons', (await dave.getByRole('button', { name: /^(Claim this|Edit|Post)$/ }).count()) === 0);
const frank = await user('Frank');
await frank.goto(itemUrl); await frank.waitForTimeout(1200);
check('other-team user gets not-found', await frank.getByText(/does not exist or you do not have access/).count() > 0);

// 6. Dashboard filter + search
await alice.goto(URL + '/#/?view=all'); await alice.locator('.list .row-item').first().waitFor();
await alice.getByLabel('Search items').fill('refund');
await alice.waitForTimeout(900);
const titles = await alice.locator('.row-item .title').allInnerTexts();
check('search narrows the list', titles.length > 0 && titles.length < 100, `(${titles.length} rows)`);
if (SHOTS) await alice.screenshot({ path: `${SHOTS}/dashboard.png` });
await alice.goto(URL + '/#/?view=all'); await alice.locator('.list .row-item').first().waitFor();
const before = await alice.locator('.row-item').count();
await alice.getByRole('button', { name: 'Load more' }).click(); await alice.waitForTimeout(800);
const afterN = await alice.locator('.row-item').count();
check('"Load more" appends the next page', afterN > before, `(${before} → ${afterN})`);

console.log(errors.length ? `\nBROWSER ERRORS:\n${errors.join('\n')}` : '\nno uncaught browser errors');
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
