# Test suite

Integration tests against the **real Supabase project** named in `.env` —
there is no local server to start first, since the app has no deployed
backend. Every test calls `POST {SUPABASE_URL}/rest/v1/rpc/<fn>` exactly the
way the browser does (`helpers.js`'s `Session.rpc()` mirrors
`client/src/lib/supabase.js`).

```
cd server
npm install
npm test
```

Requires `server/scripts/credentials.local.csv` to exist (run
`node scripts/seedUsers.js` first) — the suite logs in as real seeded
accounts rather than maintaining separate fixtures.

## Safety model

- Tests run with `--test-concurrency=1` (files run strictly one after
  another), both so no two files ever race a `fn_login` for the same account
  (which would invalidate each other's session via `session_version`) and so
  global `game_state` toggle flips in one file can't race another's.
- Anything that mutates game data does so on a **disposable team** created
  via `fn_super_add_team` (`TEST-...` team codes) and permanently deleted via
  `db.js`'s direct-Postgres `deleteTestTeam()` in an `after()` hook — never on
  one of the real 30 seeded teams.
- Any global toggle a test needs open (`r1_replace_open`, `r2_selection_open`,
  `card_play_open`) is read first, changed, and restored to its original
  value afterward.
- `mayhem.test.js` is read-only + role-boundary only. Round 3 has only 3
  events total and one response per team per event — both genuinely
  mutating operations (`fn_trigger_mayhem_event`, `fn_record_mayhem_response`)
  touch real, shared event-day state that a disposable team can't isolate,
  so they aren't exercised here.
