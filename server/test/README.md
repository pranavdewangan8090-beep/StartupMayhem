# API test suite

Integration tests that hit the real running server over HTTP (no mocking) —
`node`'s built-in test runner, no extra dependencies.

## Running

1. Start the server with generous rate limits for the test run — the
   suite fires dozens of requests in a few seconds, which the production
   defaults (40 logins/min, 120 general requests/min) are deliberately
   tight enough to legitimately throttle:

   ```bash
   RATE_LIMIT_LOGIN=500 RATE_LIMIT_GENERAL=1000 RATE_LIMIT_ACTION=500 npm start
   ```

2. Run the tests, with credentials passed as env vars (never hardcoded):

```bash
TEST_SUPER_ADMIN_ID=1 TEST_SUPER_ADMIN_PASSWORD=<real password> \
TEST_ADMIN_ID=1 TEST_ADMIN_PASSWORD=<real password> \
TEST_T01_PASSWORD=<real password> \
node --test --test-concurrency=1
```

(or `npm test` for the same, without the concurrency flag — see below).

**`--test-concurrency=1` matters.** The app enforces one active session per
login ID, including Admin/Super Admin (a new login bumps `session_version`
and invalidates the previous session). Node's test runner runs test files
in parallel by default; since every file logs in as the same Super Admin
account, parallel files invalidate each other's sessions mid-run. Running
serially avoids that.

## Env vars

| Var | Required for | 
|---|---|
| `TEST_SUPER_ADMIN_ID` / `TEST_SUPER_ADMIN_PASSWORD` | Almost everything — most suites create their own disposable team via the Super Admin API |
| `TEST_ADMIN_ID` / `TEST_ADMIN_PASSWORD` | A couple of admin-role-specific checks only; those tests skip cleanly without it |
| `TEST_T01_PASSWORD` | A few auth.test.js checks that log in as the real T01 team |
| `TEST_BASE_URL` | Override the server URL (default `http://localhost:4000/api`) |
| `TEST_ORIGIN` | Override the Origin header sent (default `http://localhost:5173`) — must be in the server's `CORS_ORIGINS` |
| `ALLOW_MAYHEM_TRIGGER_TEST=1` | **Destructive, opt-in only** — see below |

Any suite missing its required credentials skips its tests with a clear
reason instead of failing.

## Safety model

- Tests that mutate team state (card replace, action-card request, resource
  adjust, etc.) create their own throwaway `ZTEST*`/`ZTMP*` team via the
  Super Admin API and deactivate it afterward — they never touch a real
  seeded team (T01–T30) or consume its limited resources (3 card
  replacements, 4 action-card slots).
- Tests that need a toggle in a specific state (e.g. `r2_selection_open`)
  read the current value first, flip it if needed, and restore the original
  value afterward — a test run never permanently opens/closes a phase of
  the real game.
- **`mayhem.test.js`'s trigger test is the one genuine exception.** Only 3
  Market Mayhem events exist for the whole event and triggering the next
  one is one-way — there's no "undo". That test is skipped unless you pass
  `ALLOW_MAYHEM_TRIGGER_TEST=1`, and running it against a fresh/production
  database really will consume a real event slot. Reading the current event
  and recording a response for a disposable test team are both safe and
  always run.

## Cleanup

Disposable test teams are deactivated (not hard-deleted) by each test's own
teardown. Deactivated teams disappear from every real UI (all queries filter
`is_active`), so leftovers are invisible but do still occupy rows. If you
want them gone entirely before the real event:

```sql
delete from teams where team_code like 'ZTEST%' or team_code like 'ZTMP%';
```
(cascades to that team's users/action cards/etc. automatically.)
