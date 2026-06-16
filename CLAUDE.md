# CLAUDE.md — Partiful Clone (Project Constitution)

> Read this file fully before doing anything. This is the source of truth for
> how this project is built. When in doubt, follow this file over your own
> assumptions. If this file conflicts with a user instruction, ask.

## What we're building

A simplified, production-intended clone of Partiful: an event-invite platform.
Core loop: a host creates an event → shares a public link → guests RSVP via that
link **without needing an account** (name + optional contact only). The host has
an account; guests do not.

This is meant to become a real, shippable, commercial product. Optimize for
**simplicity, reliability, and clean extension points**, not cleverness.

## Tech stack (do not deviate without asking)

- **Backend / DB**: Supabase (hosted Postgres + Row Level Security + Realtime +
  Auth + Storage). All business rules live in the DB schema + RLS policies +
  Postgres functions where it makes sense. No separate API server.
- **Frontend**: Next.js (App Router) + TypeScript + Tailwind CSS.
- **Data access**: `@supabase/supabase-js`. Server Components use the server
  client; client components use the browser client.
- **Auth**: Supabase Auth for HOSTS ONLY (email magic link + Google). Guests are
  anonymous and identified by a per-guest token, never by an account.
- **Package manager**: pnpm.
- **Deploy target**: Vercel (frontend) + Supabase cloud (backend). Keep it
  deployable at all times.

## Non-negotiable architecture rules

1. **Guests never authenticate.** A guest RSVPs using the event's public slug.
   Each guest gets a random `guest_token` (stored in localStorage + returned by
   the RSVP RPC) that lets them edit *their own* RSVP later. Never require login
   for guests.
2. **All writes go through RLS or `SECURITY DEFINER` RPCs.** Never rely on the
   frontend to enforce permissions. The anon key is public; assume any client
   call can be forged. The database is the security boundary.
3. **Guest-facing writes (RSVP, comments) happen via Postgres RPC functions**
   marked `SECURITY DEFINER`, with the function itself validating inputs (event
   exists, event is open, capacity, etc.). Do NOT give the anon role broad
   INSERT on tables.
4. **Hosts can only touch their own events.** Every host-scoped table has an RLS
   policy keyed on `auth.uid() = events.host_id`.
5. **Schema is extension-ready.** Even for features we don't build a UI for yet
   (date polls, questionnaires, chip-in, tickets), the tables/columns should
   exist or be trivially addable. Prefer additive migrations.
6. **Every migration is a numbered SQL file** in `supabase/migrations/`. Never
   edit an already-applied migration; add a new one.

## Repo layout

```
partiful-clone/
  CLAUDE.md            <- this file
  TASKS.md             <- the task list you work through
  BLOCKERS.md          <- write here when stuck; never stop to wait for the user
  supabase/
    migrations/        <- numbered .sql migrations
    seed.sql           <- demo data for local dev
  web/                 <- Next.js app
    app/
    components/
    lib/
      supabase/        <- client/server supabase helpers
    types/             <- generated DB types (supabase gen types)
```

## Workflow you MUST follow

For every task in TASKS.md, in order:

1. Read the task and its acceptance criteria.
2. Implement it.
3. Verify it:
   - `pnpm --dir web typecheck` must pass (tsc --noEmit).
   - `pnpm --dir web lint` must pass.
   - `pnpm --dir web build` must succeed.
   - If the task adds a migration, the SQL must be valid (apply against local
     supabase if available; otherwise lint the SQL).
4. `git add -A && git commit` with a conventional-commit message
   (`feat:`, `fix:`, `chore:`, `db:`).
5. Check off the task in TASKS.md (change `[ ]` to `[x]`).
6. Move to the next unchecked task.

If you cannot complete a task (missing secret, ambiguous spec, external
dependency you can't resolve): append a clear entry to BLOCKERS.md describing
what's blocked and why, then SKIP it and continue with the next task. Do not
stop and wait for the user.

## Coding standards

- TypeScript strict mode on. No `any` unless justified with a comment.
- Server-side data fetching in Server Components by default; only use client
  components where interactivity is required (RSVP form, feed, polls).
- Keep components small. Co-locate component-specific logic.
- Tailwind for all styling. No CSS-in-JS, no separate stylesheets beyond
  globals.
- All DB access through typed helpers in `web/lib/`. No raw fetch to Supabase
  REST from components.
- Validate all user input with zod at the boundary before calling Supabase.
- Handle loading and error states everywhere a network call happens.

## Security checklist (apply to every feature)

- [ ] Can a malicious guest write data for an event they shouldn't? (RLS/RPC must
      prevent it.)
- [ ] Can a guest edit someone else's RSVP? (guest_token must be required.)
- [ ] Can a non-host read a private event's guest list? (RLS must prevent it.)
- [ ] Are capacity / waitlist limits enforced in the DB, not just the UI?
- [ ] Are secrets only in env vars, never committed? (`.env.local` is gitignored;
      only `NEXT_PUBLIC_*` may reach the client.)

## What NOT to do

- Do not add a separate backend server (Express/FastAPI/etc.).
- Do not store guest accounts or guest passwords.
- Do not enforce permissions only in the frontend.
- Do not edit applied migrations.
- Do not pull in heavy UI libraries; Tailwind + a few headless primitives only.
- Do not commit secrets or service-role keys to the repo.
