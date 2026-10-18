# Engineering Decisions

Five decisions that shaped the system, with what I gave up for each.

## 1. Claim is a conditional write; edits are version-checked

**Problem.** Two people can reach for the same item at once, and a person can edit a screen that is already out of date. These are different problems, so they get different tools.

**Decision.**
- *Claiming* is an intent ("make me owner if nobody is"). It is a single statement: `UPDATE items SET assignee_id = ? WHERE id = ? AND assignee_id IS NULL AND status NOT IN ('resolved','closed')`. The `WHERE` clause is the lock. Of N simultaneous claims, exactly one row matches. The rest get `409 already_claimed` with the current item, so the UI can say *who* won. A repeat claim by the winner is a harmless no-op.
- *Editing, assigning, releasing, changing status, approving* use optimistic concurrency: the client sends the `version` it saw, and the update only applies `WHERE version = ?`. A mismatch is `409 version_conflict` carrying the current item.
- Comments do **not** bump the version, because discussing an item should not make someone's open edit form stale.
- All writes run under `BEGIN IMMEDIATE`, so even two server processes sharing one database file cannot interleave (there is a test that does exactly that).

**Why not a lock or "last write wins".** Locks need expiry and cleanup when someone closes a tab. Last-write-wins silently destroys work, which is the exact failure the brief describes.

**Trade-off.** Users sometimes see a conflict message. I made it cheap to recover: the UI shows which fields changed underneath them and offers "keep my changes on top of the latest", which re-applies only the fields they actually touched. It is field-level, not a true three-way merge. If both people edited the same field, mine wins, and that is stated in the dialog.

## 2. Idempotency keys stored in the same transaction as the change

**Problem.** "I clicked Create, the spinner hung, did it work?" People retry. Networks retry. Both cause duplicates.

**Decision.** Mutating endpoints accept an `Idempotency-Key`. The server records `(user, key, request fingerprint, response)` in the **same transaction** as the business change. Either both exist or neither does, so there is no window where the work happened but the retry cannot tell. A retry replays the stored response; the same key with a *different* request is rejected with `422`. Failures are not stored, so a fixed request can be retried with the same key. The client generates one key per user intent and automatically retries network failures only for requests that carry a key, which is what makes automatic retry safe.

**Trade-off.** Keys are stored forever in this version (see limitations), and the guarantee is per-user. I preferred this to a unique-constraint-on-content approach, which would wrongly block legitimately similar items.

## 3. Authorization is a small set of pure rules, enforced on the server, per resource

**Problem.** "Not every user should be able to perform every action", with people holding different roles in different teams.

**Decision.**
- Roles live on the *membership* (user × team): viewer, member, lead. There is no global admin role.
- `policy.js` holds the rules as pure functions of `(user, action, item)`. Every route goes through them; nothing relies on the UI hiding a button. Examples: members may only edit items they created or hold; only leads assign; the assignee or a lead changes status; only a lead closes; **nobody approves their own request** (separation of duties).
- Items in teams you do not belong to answer **404**, not 403, in direct access, lists, search, history and counters, so existence does not leak.
- The detail endpoint returns a `can` map and a list of transitions with a *reason* when one is disabled. The UI renders from that, so the interface and the server cannot drift into disagreeing about what is allowed.

**Trade-off.** Fixed three-role model instead of configurable permissions. It covers the stated needs and is easy to reason about in a review; a real company would eventually want per-team custom roles.

## 4. Slow side effects go through a transactional outbox

**Problem.** Notifications should not slow down or fail the action that caused them, but they also must not be silently lost or sent twice.

**Decision.** Business changes write a row into an `outbox` table **inside the same transaction**. A worker later turns rows into notifications. If the action rolls back, no outbox row exists (tested). The worker is built for the three things the brief asks about:
- *Failure:* retry with exponential backoff, then park as `dead` where it stays visible.
- *Running twice:* every notification has a deduplication key, and the effects and the `done` mark commit together, so re-delivery produces one notification (tested).
- *Delay or a crashed worker:* rows stuck in `processing` are re-claimed when their lock expires (tested).

**Trade-off.** At-least-once delivery with idempotent effects, rather than attempting exactly-once. The worker runs inside the API process on a 2-second timer, which is the simplest thing that works; the outbox makes moving it to its own process a deployment change, not a rewrite. Notifications are in-app only; there is no email.

## 5. Keyset pagination, full-text search, and indexes chosen for the screens

**Problem.** Tens of thousands of active items and an ever-growing history. The browser and the app must never load everything.

**Decision.**
- Lists use **keyset (cursor) pagination** on `(last_activity_at, id)`, not `OFFSET`. Cost is flat on page 50 and the list does not shuffle or duplicate rows when new items arrive mid-scroll (tested).
- Search uses SQLite **FTS5** kept in sync by triggers. User input is tokenised and quoted, so operators and quotes cannot break or inject into the query (tested with hostile input).
- Indexes follow the screens: team + recent activity, team + priority + activity, assignee + status, and partial indexes for pending approvals and due dates.
- History is a separate append-only table (update and delete are blocked by triggers) paginated per item, so it can grow without slowing down item lists.
- The dashboard's "needs attention" is a **server-side definition** with a counter, not a client-side filter over a big list.

I benchmarked on 30,000 seeded items. That caught a real problem: the list query took 23 ms because the planner joined names before applying `LIMIT`. Paging first and joining after brought it to about 1 ms.

**Trade-off.** SQLite keeps setup to zero and its single-writer model is fine for this exercise's scale, but it is the first thing I would replace (see below). The six overview counters cost about 60 ms together on 30k items; fine now, and the first candidate for caching or incremental counters.

## What I deliberately did not build

Real-time push (the UI polls visibly-open pages every 8–30 s and uses `ETag`/`304` to keep that cheap), team/user administration screens, email or chat notifications, attachments, SLAs and escalation rules, and frontend unit tests (the UI has one browser smoke script instead). I chose depth in correctness over breadth in features, as the brief suggests.

## If this grew significantly

1. Move to PostgreSQL: row-level locking and concurrent writers. The conditional `UPDATE` and version checks translate directly; FTS5 becomes `tsvector`; the outbox uses `SELECT ... FOR UPDATE SKIP LOCKED`.
2. Run the worker as a separate process and add a real queue only if the outbox poll becomes a bottleneck.
3. Replace polling with server-sent events for open items and counters.
4. Cache or maintain per-user attention counters incrementally; archive old history by month.
5. Expire idempotency keys; add rate limiting and audit export.
