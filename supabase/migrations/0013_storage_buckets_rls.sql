-- 0013_storage_buckets_rls.sql — Task 1.7: Storage buckets + RLS (SCHEMA "Storage
-- (D16)").
--
-- Physical file 0013 = logical task 1.7 (the file numbering runs one ahead of the
-- TASKS.md labels — see the 0002/0004 headers for the same note).
--
-- WHAT THIS MIGRATION DOES
-- Creates the two event-media buckets and the storage.objects RLS that governs
-- them. storage.objects already ships RLS ENABLED (Supabase default; owned by
-- supabase_storage_admin) with NO policy = a deny-all baseline (every non-owner
-- refused) — that baseline is what tasks 1.3/1.4 relied on. This migration adds
-- the buckets plus the precise WRITE policies that let a host manage ONLY its own
-- event's media, while keeping anon fully shut out.
--
-- THE TWO BUCKETS (D16)
--   * event-covers — PUBLIC read / host write. The cover is a first-class public
--     façade (it is also the OG share image), so the bucket is public=true: reads
--     are served by the public-object endpoint, no anon RLS policy needed. Object
--     names are `<event_id>/<uuid>.<ext>` (the random uuid prevents enumeration).
--   * event-photos — PRIVATE album (🟡, no UI yet). public=false: no public read,
--     no anon read policy — future reads go through signed URLs / a trusted gate.
--     Structure only for now (SCHEMA: "现仅建结构").
-- Both carry a server-enforced mime allowlist (image/png|jpeg|webp) + a size cap
-- (covers ~5MB), so an oversized or non-image upload is refused by the Storage API
-- itself, not merely by the client (D16: "上传校验(服务端强制,非只前端)").
--
-- THE WRITE POLICY (the actual security story)
-- INSERT/UPDATE/DELETE on storage.objects are allowed only when the caller is
-- `authenticated` AND owns the event whose id is the object's FIRST path segment
-- (`auth.uid() = events.host_id` for `(storage.foldername(name))[1] = <event_id>`).
-- Without it, ANY logged-in user could overwrite another host's cover and anon
-- could upload at will (SCHEMA: "不写这条 = 任意登录用户覆盖他人封面 / anon 可传").
--   * The predicate compares `events.id::text` to the folder string (never casts
--     the untrusted folder to uuid), so a non-uuid / missing prefix simply matches
--     no row and the write is denied — fail-closed, never an error path.
--   * Scoped to the two event buckets; `to authenticated` only (I1 — never public),
--     so anon has NO write policy and stays denied. Reads need no policy here:
--     event-covers is public via the bucket, event-photos is deliberately private.

-- ── Buckets (idempotent; re-applies config on conflict) ───────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('event-covers', 'event-covers', true,  5242880,  array['image/png','image/jpeg','image/webp']),
  ('event-photos', 'event-photos', false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public           = excluded.public,
      file_size_limit  = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Write policies on storage.objects: host owns the event in the path prefix ──
-- One predicate, reused across INSERT/UPDATE/DELETE so the rule can't drift.
-- (CREATE POLICY is not idempotent; drop-if-exists keeps re-apply / db reset safe.)
drop policy if exists "event_media_owner_insert" on storage.objects;
create policy "event_media_owner_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('event-covers', 'event-photos')
    and exists (
      select 1 from public.events e
      where e.id::text = (storage.foldername(name))[1]
        and e.host_id = auth.uid()
    )
  );

drop policy if exists "event_media_owner_update" on storage.objects;
create policy "event_media_owner_update" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('event-covers', 'event-photos')
    and exists (
      select 1 from public.events e
      where e.id::text = (storage.foldername(name))[1]
        and e.host_id = auth.uid()
    )
  )
  with check (
    bucket_id in ('event-covers', 'event-photos')
    and exists (
      select 1 from public.events e
      where e.id::text = (storage.foldername(name))[1]
        and e.host_id = auth.uid()
    )
  );

drop policy if exists "event_media_owner_delete" on storage.objects;
create policy "event_media_owner_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('event-covers', 'event-photos')
    and exists (
      select 1 from public.events e
      where e.id::text = (storage.foldername(name))[1]
        and e.host_id = auth.uid()
    )
  );
