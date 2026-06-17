# web/ — Next.js app

The frontend for the Partiful Clone (App Router + TypeScript + Tailwind).

**Setup, environment, migrations, testing, and deployment are documented in the
repo-root [`README.md`](../README.md).** The security model and per-decision audit
are in [`../SECURITY.md`](../SECURITY.md).

Quick reference (run the local Supabase stack from the repo root first — see the
root README):

```bash
pnpm --dir web install     # from repo root
pnpm --dir web dev         # dev server at http://localhost:3000
pnpm --dir web typecheck   # tsc --noEmit (strict)
pnpm --dir web lint        # ESLint
pnpm --dir web test        # Vitest (needs the local Supabase DB up)
pnpm --dir web build       # production build
```

Environment variables live in [`env.local.example`](env.local.example); copy it to
`web/.env.local` (gitignored) and fill in. Only `NEXT_PUBLIC_*` values reach the
browser; the service-role key is server-only and read solely by
`lib/supabase/service.ts`.
