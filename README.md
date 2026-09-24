# Startup Mayhem

Event platform for E-Cell NIT Trichy's Startup Mayhem. React (mobile-first) +
Node/Express + Supabase Postgres.

## Folder structure

```
server/   Express API. All game rules run as Postgres functions (server/sql/005_functions.sql)
  sql/    001 schema, 002-004 seed data, 005 game-logic functions — run in order
  src/    routes, middleware, db pool, config
  scripts/seedUsers.js   creates the real 30 teams / 30 admins / 5 super admins
client/   React (Vite) mobile-first UI
```

## One-time setup

### 1. Database (Supabase)

In the Supabase SQL editor, or via `psql "$DATABASE_URL"`, run the files in
`server/sql/` **in order**: `001` → `002` → `003` → `004` → `005`.

`004_seed_mayhems.sql` currently has **4 placeholder mayhems** — replace this
file with your real mayhem list before the event (tags must be one or more of
`finance`, `social`, `urban`, `logistics`).

### 2. Server

```
cd server
cp .env.example .env      # fill in DATABASE_URL (Supabase connection string) and a JWT_SECRET
npm install
npm run dev                # or `npm start` in production
```

Then create the real accounts (30 teams with a random deal of cards, 30
admins, 5 super admins):

```
node scripts/seedUsers.js
```

This writes `server/scripts/credentials.local.csv` — hand these out and then
move/delete the file. It is git-ignored and must never be committed.

### 3. Client

```
cd client
npm install
npm run dev        # local dev, proxies /api to the server on :4000
npm run build       # production build (dist/) — deploy behind your host of choice
```

In production, set `CORS_ORIGINS` on the server to the exact URL the client
is served from (comma-separated if more than one), and serve the client over
HTTPS so the auth cookie's `Secure` flag works.

## Login

One screen, three roles (Team / Admin / Super Admin), selected with a
switch — this is needed because admin and super admin both use plain numeric
IDs that would otherwise collide (`admin #1` and `super_admin #1` are
different accounts).

## Live updates

Polling, not WebSockets: the client hits `GET /api/player/state?v=<version>`
every 4s; the server returns `204 No Content` when nothing changed and the
full state otherwise. This covers marketplace requests, attack notifications,
toggle changes and the mayhem card reliably on ~30 phones, with none of the
socket/reconnect complexity Supabase Realtime would add on venue WiFi.

## Security notes

- All passwords are bcrypt-hashed; no plaintext password is stored anywhere.
- Every route re-checks the caller's role server-side; the client's role
  display is cosmetic only.
- One active login per team: logging in again immediately invalidates the
  previous session's token (`session_version` bump), even if that phone still
  has the old cookie.
- Every game rule (the 3-replacement cap, the 4-action-card cap, resource
  caps/floors, marketplace ownership checks) is enforced inside a Postgres
  function with row locks — never trusted from the client, and safe against
  two people acting at the same instant.
- Every mutating request carries a client-generated `requestId`; a repeat
  (double-tap, retry) is rejected as a duplicate rather than applied twice.
- CSRF: the auth cookie is `httpOnly` and, in production, `SameSite=None;
  Secure` (needed because the client and server are different origins); every
  state-changing request is additionally checked against the `Origin` header
  and rejected if it doesn't match `CORS_ORIGINS`.
- Rate limits on login and on every game-action endpoint.
- `zod` validates every request body before it reaches business logic.
- Decision points are never returned by any player-facing route.

## Placeholder data

`server/sql/004_seed_mayhems.sql` is placeholder — swap in your real mayhem
list before the event and re-run just that file (`\i 004_seed_mayhems.sql`).
