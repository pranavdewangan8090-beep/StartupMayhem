# Startup Mayhem

Event platform for E-Cell NIT Trichy's Startup Mayhem. React (mobile-first) +
Supabase (Postgres + PostgREST) — **no deployed backend**: the client calls
Supabase directly, and every game rule runs as a Postgres function.

## Folder structure

```
server/   Not a deployed server — just SQL + one-off scripts run against Supabase
  sql/    001 schema, 002-003 seed data, 005 game-logic functions,
          010-026 the Supabase-direct auth + RPC layer, crises, and fixes —
          run in numeric order
  scripts/seedUsers.js   resets the game and creates 45 teams / 20 admins / 10 super admins —
                         re-running it keeps every existing login/password the same, only
                         generating new ones for newly added slots
  scripts/applySql.js    applies SQL files in one transaction (dry run unless --commit)
client/   React (Vite) mobile-first UI — talks to Supabase via lib/supabase.js
```

## One-time setup

### 1. Database (Supabase)

On a fresh project, run every file in `server/sql/` **in numeric order**
(`001` → `026`, skipping the numbers that don't exist) — `cd server && npm
run seed:cards` does exactly that with psql. The real Round 3 crises and
their per-Market-card tiers are in `021_seed_real_crises.sql`.

You'll also need to create `_app_secrets` yourself (it's deliberately not in
any SQL file, so the real JWT secret never touches source control) — see the
comment at the top of `server/sql/010_supabase_auth.sql`.

Then create the real accounts (45 teams with a random deal of cards, 20
admins, 10 super admins). This also **resets the game**: all crises go back to
untriggered, R1 replacements open, card play closed, trading off:

```
cd server
cp .env.example .env      # fill in DATABASE_URL (Supabase connection string)
npm install
node scripts/seedUsers.js
```

This writes `server/scripts/credentials.local.csv`. **Keep this file** — it
is git-ignored and must never be committed, but it's also the durable
source of truth for credentials: running `seedUsers.js` again (e.g. to
reset scores before the event, or after a rehearsal) reuses every
login/password already in it unchanged, and only generates fresh ones for
newly added teams/staff. Deleting it before a reset regenerates every
credential from scratch instead.

### 2. Client

```
cd client
cp .env.example .env   # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (both public values)
npm install
npm run dev             # local dev
npm run build            # production build (dist/) — deploy behind your host of choice, e.g. Vercel/Netlify
```

Both env values are safe to expose client-side (the anon key relies on RLS +
locked-down grants, not secrecy) — see `client/.env`.

## Login

One screen, three roles (Team / Admin / Super Admin), selected with a
switch — this is needed because admin and super admin both use plain numeric
IDs that would otherwise collide (`admin #1` and `super_admin #1` are
different accounts).

Auth is custom, not Supabase Auth/GoTrue: `fn_login` (in
`010_supabase_auth.sql`) verifies the password against `users.password_hash`
with pgcrypto and mints a JWT signed with the project's own secret.
PostgREST verifies that JWT exactly like a Supabase Auth token, and
`fn_auth_user()` is how every RLS-locked table and RPC function reads the
caller's identity back out of it.

## Live updates

Polling, not WebSockets: the client calls `fn_player_state()` every 4s. This
covers action-card requests, deal offers, toggle changes and the mayhem card
reliably on ~30 phones, with none of the socket/reconnect complexity Supabase
Realtime would add on venue WiFi.

## Security notes

- All passwords are bcrypt-hashed (via pgcrypto's `crypt()`/`gen_salt('bf')`,
  compatible with the same hash format `bcryptjs` used previously); no
  plaintext password is stored anywhere.
- **Only `fn_login` is callable without logging in.** Postgres grants
  EXECUTE on new functions to `PUBLIC` by default (and `anon` inherits it), so
  `revoke ... from anon` alone does nothing — `025_security_lockdown.sql`
  revokes from `PUBLIC` and `anon` across the schema. Any new function must
  be granted to `authenticated` explicitly, and internal helpers (anything
  not called by the client) must not be granted at all. After adding
  functions, `node scripts/applySql.js <file>` prints which ones `anon` can
  call — it should only ever be `fn_login`.
- **No table is ever exposed to PostgREST via RLS policy + grant.** Every
  table a client can reach data from (`teams`, `users`, `_app_secrets`, etc.)
  has RLS enabled with zero policies and no grants to `anon`/`authenticated`
  — the only way in is a curated `SECURITY DEFINER` function that derives the
  caller's identity from `fn_auth_user()` and returns only the columns that
  role should see. This is deliberate: RLS is row-level only, so a policy
  letting a player `SELECT` their own team row would also let them query
  hidden columns (like `decision_points`) via `?select=`. Every admin/super
  admin RPC additionally checks the caller's role via `fn_require_role()`.
- Multiple simultaneous logins are allowed per account — logging in on a
  second screen does not kick out the first (`session_version` is not
  bumped on login). Resetting a password or deactivating the account still
  invalidates every existing session for it immediately, via
  `session_version`/`is_active` respectively — those are separate,
  intentional mechanisms, not the login flow.
- Every game rule (the 3-replacement cap, the 3-action-card cap, resource
  caps/floors, deal-card ownership checks) is enforced inside a Postgres
  function with row locks — never trusted from the client, and safe against
  two people acting at the same instant.
- Every mutating RPC call carries a client-generated `requestId`; a repeat
  (double-tap, retry) is rejected as a duplicate rather than applied twice.
- Decision points are never returned by any player-facing function.

## Changing the live database

Put the change in a new numbered file in `server/sql/`, then:

```
cd server
node scripts/applySql.js sql/0NN_whatever.sql            # dry run — rolled back
node scripts/applySql.js --commit sql/0NN_whatever.sql   # apply
```

Apply database changes **before** deploying a client build that depends on
them.

## Tests

`server/test/` runs against the **live** Supabase project, logging in as
real seeded accounts and mutating shared `game_state` toggles, so it
refuses to run unless `SM_ALLOW_LIVE_TESTS=1` is set. Never run it during
the event. See `server/test/README.md`.
