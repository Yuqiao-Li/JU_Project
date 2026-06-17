# Partiful Clone

A simplified, production-intended event-invite platform. The core loop: a host
creates an event → shares a public link → guests RSVP via that link **without
needing an account** (name + optional contact only). Hosts have accounts; guests
do not.

- **Backend / DB:** Supabase (hosted Postgres + Row Level Security + Auth +
  Storage). All business rules live in the schema, RLS policies, and
  `SECURITY DEFINER` Postgres functions. There is no separate API server.
- **Frontend:** Next.js (App Router) + TypeScript (strict) + Tailwind CSS, in
  `web/`.
- **Rate limiting:** Upstash Redis on the read side (with an in-memory fallback)
  + a Postgres `rate_limits` backstop on the write side.

The single source of truth for *how* this project is built is [`CLAUDE.md`](CLAUDE.md)
(the constitution) and [`SCHEMA.md`](SCHEMA.md) (data model + per-field security
boundaries). The security audit lives in [`SECURITY.md`](SECURITY.md).

---

## Repo layout

```
partiful-clone/
  CLAUDE.md            project constitution (read this first)
  SCHEMA.md            data model + per-field security boundaries
  SECURITY.md          security review (CLAUDE.md checklist + D1–D16 / G1–G8)
  TASKS.md             execution checklist
  check-boundaries.sh  static + DB-authoritative guardrail gate
  package.json         root scripts that wrap the Supabase CLI
  supabase/
    migrations/        numbered .sql migrations (never edit an applied one)
    seed.sql           demo data for local dev
    config.toml        local Supabase stack config
  web/                 Next.js app
    app/               routes (App Router)
    components/        UI components
    lib/               typed data-access helpers, supabase clients, rate limiter
    tests/             Vitest suite (runs against a local Supabase test DB)
    types/             generated DB types
    env.local.example  env template — copy to web/.env.local
```

---

## Prerequisites

- **Node.js** 20+
- **pnpm** (`corepack enable` will provision the pinned version)
- **Docker** — required by the Supabase CLI for the local stack
- **Supabase CLI** — <https://supabase.com/docs/guides/cli>

---

## Local setup

All Supabase CLI commands run from the **repo root** (where `supabase/config.toml`
lives). App commands run from `web/`.

```bash
# 1. Install web dependencies
pnpm --dir web install

# 2. Configure environment
cp web/env.local.example web/.env.local
#    For local dev, fill web/.env.local from `supabase status -o env`
#    (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#     SUPABASE_SERVICE_ROLE_KEY). Upstash is optional locally — when unset the
#     rate limiter falls back to an in-memory window.

# 3. Start the local Supabase stack (Postgres + Auth + Storage + PostgREST)
pnpm db:start

# 4. Apply all migrations + seed demo data, then generate TS types
pnpm db:reset
pnpm db:gen-types

# 5. Run the app
pnpm --dir web dev      # http://localhost:3000
```

### Root scripts (`package.json`)

| Script              | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `pnpm db:start`     | `supabase start` — bring up the local stack                         |
| `pnpm db:stop`      | `supabase stop`                                                     |
| `pnpm db:status`    | `supabase status` — URLs + local keys                               |
| `pnpm db:reset`     | `supabase db reset` — drop, re-apply **all** migrations, run seed   |
| `pnpm db:apply`     | `supabase migration up` — apply pending migrations only             |
| `pnpm db:gen-types` | regenerate `web/types/database.ts` from the local schema            |

### Web scripts (`web/package.json`)

| Script                     | What it does                          |
| -------------------------- | ------------------------------------- |
| `pnpm --dir web dev`       | Next dev server                       |
| `pnpm --dir web build`     | production build                      |
| `pnpm --dir web start`     | serve the production build            |
| `pnpm --dir web typecheck` | `tsc --noEmit` (strict)               |
| `pnpm --dir web lint`      | ESLint                                |
| `pnpm --dir web test`      | Vitest suite (needs the local DB up)  |

---

## Environment variables

Defined in [`web/env.local.example`](web/env.local.example). `web/.env.local` is
gitignored — **never commit real keys.** Only `NEXT_PUBLIC_*` variables reach the
browser.

| Variable                              | Scope        | Required | Notes                                                                                 |
| ------------------------------------- | ------------ | -------- | ------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`            | public       | yes      | Supabase project URL.                                                                  |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`       | public       | yes      | The only Supabase key allowed in the client bundle.                                    |
| `SUPABASE_SERVICE_ROLE_KEY`           | server-only  | yes      | Trusted key; bypasses RLS. Read **only** by `web/lib/supabase/service.ts`. Never `NEXT_PUBLIC_`. |
| `EVENT_CREDENTIAL_SECRET`             | server-only  | no       | Signs event-password credential cookies. Falls back to the service-role key if unset. |
| `UPSTASH_REDIS_REST_URL`              | server-only  | no\*     | Read-side rate limiter backend.                                                        |
| `UPSTASH_REDIS_REST_TOKEN`            | server-only  | no\*     | Read-side rate limiter backend.                                                        |
| `RATELIMIT_BACKEND`                   | server-only  | no       | Set to `memory` to force the in-memory limiter.                                        |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`| server-only  | no       | Google OAuth secret, read by Supabase (not Next). Magic link works without it.        |

\* Upstash is optional. When unset, the limiter uses a process-local in-memory
sliding window — it is **always enforced**, never disabled. For production set
both so the cap is shared across instances.

---

## Database migrations

- Every schema change is a **numbered SQL file** in `supabase/migrations/`
  (`0001_…`, `0002_…`, …). Migrations are applied in order.
- **Never edit an already-applied migration** — add a new numbered file. This is
  enforced by the guardrail and the workflow in `CLAUDE.md`.
- `pnpm db:reset` re-applies everything from scratch + runs `seed.sql`; use it
  whenever you add a migration locally.
- After a schema change, run `pnpm db:gen-types` to refresh `web/types/database.ts`.

The migration set builds the full data model and security boundary up front
(tables, RLS, the guest read/write RPCs, slug generation, storage buckets,
date-poll + password support). See `SCHEMA.md` for the table-by-table design.

---

## Testing & the guardrail

```bash
# Full suite (resets the local DB in global setup, then runs every spec)
pnpm --dir web test

# Static + DB-authoritative guardrail gate
RUN_DB_CHECKS=1 SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  bash ./check-boundaries.sh
```

- **Vitest** runs against the **local Supabase test DB**. The global setup runs
  `supabase db reset` (migrations + seed) and mints confirmed host sessions, so
  the stack must be up (`pnpm db:start`) first. Anon paths use the anon key, host
  paths use a minted session, trusted paths use the service role — the suite
  exercises the security boundary the way real callers do.
- **`check-boundaries.sh`** is the gate run before every commit. It enforces the
  no-frontend-for-unbuilt-features blacklist, slug entropy, banned patterns
  (`sessionStorage`, service-role leaking to the client, committed secrets), and
  — with `RUN_DB_CHECKS=1` + a reachable `SUPABASE_DB_URL` — a DB-authoritative
  RLS check (every table has RLS + a non-permissive policy, no anon policies on
  client-data tables, no `using(true)`, storage RLS enabled). It finishes with
  typecheck + lint + build.

Done = `TASKS.md` has no `[ ]` left, `pnpm --dir web test` is green, and
`check-boundaries.sh` (with DB checks) is green.

---

## Deployment

The app is deployable at all times: **Vercel** (frontend) + **Supabase cloud**
(backend) + **Upstash** (rate-limit Redis).

### 1. Supabase (cloud project)

1. Create a project at <https://supabase.com>.
2. Link and push migrations from the repo root:
   ```bash
   supabase link --project-ref <your-project-ref>
   supabase db push          # applies supabase/migrations/* in order
   ```
   (Do **not** seed production with `seed.sql` — it is demo data.)
3. Storage buckets (`event-covers` public, `event-photos` private) and their RLS
   are created by migration `0013`, so they exist after `db push` — no manual
   bucket setup.
4. **Auth:** enable Email (magic link) — on by default. For Google sign-in, set
   the provider client id/redirect in the dashboard (or `config.toml`) and supply
   `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`. Add your production origin to the Auth
   **Site URL** and **Redirect URLs** allow-list (e.g. `https://your-app.vercel.app`).

### 2. Upstash (read-side rate limiting)

1. Create a Redis database at <https://upstash.com>.
2. Copy its REST URL + token into the Vercel env (`UPSTASH_REDIS_REST_URL`,
   `UPSTASH_REDIS_REST_TOKEN`). Without them the limiter still works per-instance
   in memory, but a shared Redis is recommended in production.

### 3. Vercel (frontend)

1. Import the repo; set the project **root directory to `web/`**.
2. Set environment variables (from the table above): the two `NEXT_PUBLIC_*`
   values, `SUPABASE_SERVICE_ROLE_KEY`, the Upstash pair, and optionally
   `EVENT_CREDENTIAL_SECRET`. The service-role key must be a **plain** (non
   `NEXT_PUBLIC_`) Vercel env var so it never reaches the browser.
3. Deploy. Vercel injects the real client IP (`x-real-ip` / `x-forwarded-for`),
   which the read-side limiter relies on.

### Production checklist

- [ ] Migrations pushed (`supabase db push`); types regenerated if schema changed.
- [ ] Auth Site URL + Redirect URLs include the production origin.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` set as a server-only Vercel var (never `NEXT_PUBLIC_`).
- [ ] Upstash configured for a shared rate-limit window.
- [ ] No secrets committed (`.env*` is gitignored; the guardrail greps for leaks).

---

## Security model (summary)

- **Guests never authenticate.** A guest RSVPs via the event's public slug and
  gets a random `guest_token` (localStorage) to edit their own RSVP. The token is
  the guest credential — **never required for, and never placed in, a URL.**
- **The database is the security boundary.** Guest-facing reads and writes go
  only through `SECURITY DEFINER` RPCs that validate inputs; anon has no direct
  table access to client data. Hosts touch only their own events via RLS keyed on
  `host_id = auth.uid()`.
- **Private events** are readable only by the trusted SSR path (service role);
  the RPC returns `null` to everyone else.
- **`contact` is host-visible metadata only** — never an identity or dedup key.

The full, per-decision audit (CLAUDE.md checklist + D1–D16 / G1–G8) is in
[`SECURITY.md`](SECURITY.md).
