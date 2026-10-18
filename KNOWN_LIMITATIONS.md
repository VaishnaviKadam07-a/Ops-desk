# Known Limitations

Stated plainly, so nobody has to discover them in the review.

## Testing gaps
- **The frontend has no unit or component tests.** The 47 automated tests (`npm test`) cover the server. The UI is covered by one optional browser script, `e2e/ui-smoke.mjs` (17 checks with two real Chromium sessions: claim race, stale-edit conflict and "keep mine", read-only viewer, hidden other-team items, search, pagination). It passed against the final build, but it is a single happy-path-and-races script that needs a browser to run, not a regression suite. Running it found two real bugs (history not refreshing after a claim; search box out of sync with the URL), both fixed. Other UI paths (approval buttons, release/assign, notifications panel, mobile layout) were not browser-tested.
- No load test beyond query benchmarks on a 30,000-item database. Concurrency tests use tens of simultaneous requests, not thousands.

## Scale
- **SQLite allows one writer at a time.** Writes queue behind each other (5 s busy timeout, then a `503` with `Retry-After`). Fine for this scope; not for thousands of simultaneously writing users. The first thing to replace.
- The overview counters scan per request (about 60 ms on 30k items). Not cached.
- The in-process worker and the in-memory login throttle assume a single API process. Multiple processes still work correctly for data (tested), but the login throttle is then per-process.
- Idempotency keys and read notifications are never cleaned up.

## Product
- No admin screens: users, teams and roles come from seed data.
- Roles are fixed (viewer / member / lead). No custom permissions.
- Rejecting an approval closes the item. There is no "request changes" step.
- Edit conflicts are resolved per field. If two people changed the same field, the person saving chooses to overwrite it; there is no side-by-side text merge.
- Notifications are in-app only; no email or chat.
- Search matches whole words plus a prefix on the last word. No typo tolerance or ranking.
- Items cannot be deleted (by design: history must not disappear), and there is no archive.
- "Overdue" and "gone quiet" use fixed rules (past due date; no activity for 3 days) that are not configurable.

## Security
- Session tokens are kept in `localStorage`, so an XSS bug would expose them. React escapes output, but there is no Content-Security-Policy.
- No HTTPS termination and no refresh-token rotation; sessions last 12 hours. (CSRF is not a concern for bearer-token auth.)
- Demo passwords are shared and printed on the login page. Remove the seed before any real use.
- The login throttle is simple (10 attempts per 5 minutes per IP and email) and in memory.

## Real-time behaviour
- No push. Open pages poll (item detail every 8 s, overview every 20 s, list every 30 s while visible). Someone else's change can take up to that long to appear, and any action you take still goes through the version and ownership checks, so a stale screen cannot cause a wrong write.
