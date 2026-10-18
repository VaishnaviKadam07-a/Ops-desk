import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { PRIORITY_RANK, openDb, tx } from './db.js';

export const DEMO_PASSWORD = 'password123';

const USERS = [
  ['alice@example.com', 'Alice Rao'],      // lead: Support + Engineering
  ['bob@example.com', 'Bob Iyer'],         // member: Support
  ['carol@example.com', 'Carol Mehta'],    // member: Support + Engineering
  ['dave@example.com', 'Dave Khan'],       // viewer: Support
  ['erin@example.com', 'Erin Patel'],      // lead: Engineering + Finance
  ['frank@example.com', 'Frank Joshi'],    // member: Finance only
];
const TEAMS = ['Support', 'Engineering', 'Finance'];
const MEMBERSHIPS = [
  ['alice@example.com', 'Support', 'lead'], ['alice@example.com', 'Engineering', 'lead'],
  ['bob@example.com', 'Support', 'member'],
  ['carol@example.com', 'Support', 'member'], ['carol@example.com', 'Engineering', 'member'],
  ['dave@example.com', 'Support', 'viewer'],
  ['erin@example.com', 'Engineering', 'lead'], ['erin@example.com', 'Finance', 'lead'],
  ['frank@example.com', 'Finance', 'member'],
];

const TOPICS = {
  Support: ['Refund request', 'Login failure', 'Duplicate charge', 'Delayed delivery', 'Account locked', 'Invoice mismatch', 'Chargeback dispute', 'App crash report'],
  Engineering: ['Production incident', 'Slow query', 'Deploy rollback', 'Memory leak', 'Failing health check', 'Certificate expiry', 'Queue backlog', 'Cache stampede'],
  Finance: ['Payment investigation', 'Vendor approval', 'Reconciliation gap', 'Expense exception', 'Payout delay', 'Tax compliance request', 'Budget variance', 'Audit evidence'],
};
const DETAILS = ['for enterprise customer', 'in the EU region', 'after last release', 'reported by sales', 'flagged by monitoring', 'needs sign-off', 'repeat occurrence', 'affects several accounts'];

// Small deterministic RNG so large seeds are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function seed(db, { large = false, items: itemCount } = {}) {
  const already = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (already) return { skipped: true };
  const now = Date.now();
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  tx(db, () => {
    const pwd = hashPassword(DEMO_PASSWORD);
    const userId = {};
    for (const [email, name] of USERS) {
      userId[email] = Number(db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)').run(email, name, pwd, now).lastInsertRowid);
    }
    const teamId = {};
    for (const t of TEAMS) teamId[t] = Number(db.prepare('INSERT INTO teams (name) VALUES (?)').run(t).lastInsertRowid);
    for (const [e, t, r] of MEMBERSHIPS) db.prepare('INSERT INTO memberships (user_id, team_id, role) VALUES (?,?,?)').run(userId[e], teamId[t], r);

    const membersByTeam = {};
    for (const [e, t, r] of MEMBERSHIPS) (membersByTeam[t] ||= []).push({ id: userId[e], role: r });
    const doers = (t) => membersByTeam[t].filter((m) => m.role !== 'viewer');

    const insItem = db.prepare(
      `INSERT INTO items (team_id, title, description, status, priority, priority_rank, assignee_id, creator_id,
                          requires_approval, approval_state, due_at, version, created_at, updated_at, last_activity_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insEvent = db.prepare('INSERT INTO item_events (item_id, actor_id, type, data, created_at) VALUES (?,?,?,?,?)');

    const count = itemCount ?? (large ? 30000 : 150);
    const DAY = 86_400_000;
    for (let n = 0; n < count; n++) {
      const team = pick(TEAMS);
      const creators = doers(team);
      const creator = pick(creators).id;
      const roll = rand();
      const status = roll < 0.35 ? 'open' : roll < 0.6 ? 'in_progress' : roll < 0.7 ? 'blocked' : roll < 0.85 ? 'resolved' : 'closed';
      const pr = pick(['low', 'medium', 'medium', 'high', 'urgent']);
      const needsApproval = team === 'Finance' && rand() < 0.3 ? 1 : 0;
      let approval = needsApproval ? 'pending' : 'none';
      let assignee = null;
      if (status !== 'open' || rand() < 0.3) assignee = pick(creators).id;
      if (needsApproval && ['in_progress', 'resolved', 'closed'].includes(status)) approval = 'approved';
      const created = now - Math.floor(rand() * 90 * DAY);
      const lastAct = Math.min(now, created + Math.floor(rand() * 20 * DAY));
      const due = rand() < 0.4 ? now + Math.floor((rand() - 0.4) * 14 * DAY) : null;
      const title = `${pick(TOPICS[team])} #${1000 + n} ${pick(DETAILS)}`;
      const description = `${pick(TOPICS[team])} ${pick(DETAILS)}. Reported via ${pick(['chat', 'email', 'phone', 'monitoring'])}. Needs investigation and a clear owner.`;
      const id = Number(insItem.run(teamId[team], title, description, status, pr, PRIORITY_RANK[pr], assignee, creator,
        needsApproval, approval, due, 1, created, lastAct, lastAct).lastInsertRowid);
      insEvent.run(id, creator, 'created', JSON.stringify({ priority: pr, requiresApproval: !!needsApproval }), created);
      if (assignee) insEvent.run(id, assignee, 'assigned', JSON.stringify({ to: assignee, via: 'claim' }), created + 60_000);
      if (status !== 'open') insEvent.run(id, assignee ?? creator, 'status_changed', JSON.stringify({ from: 'open', to: status }), lastAct);
    }
  });
  return { skipped: false, users: USERS.length, items: itemCount ?? (large ? 30000 : 150) };
}

// `node src/seed.js [--large]`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ops.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openDb(file);
  console.log(seed(db, { large: process.argv.includes('--large') }), '->', file);
}
