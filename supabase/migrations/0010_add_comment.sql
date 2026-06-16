-- 0010_add_comment.sql — Task 1.5d [SECURITY]: the Activity-Feed comment RPCs.
--   * get_comments(slug, guest_token?)  — the read path: READ-OPEN (no RSVP), but
--     visibility-gated (D3); returns body / author display_name / created_at only.
--   * add_comment(slug, guest_token, body, client_fingerprint?) — the write path:
--     unlock-gated (shared helper), author bound server-side (D6), rsvp_enabled=false
--     ⇒ host-only, never writes gif, write-side DB depth rate limit (D14).
-- TASKS.md labels this "(0005e)".
--
-- Named 0010_* (logical "0005e"): the Supabase CLI only applies files whose version
-- prefix is purely numeric, so the physical numbering runs one ahead of the logical
-- labels (1.1a=0001 … 1.5b=0008, 1.5c=0009, 1.5d=0010). This sorts right after
-- 0009_get_guest_list.sql — see the 0002…0009 headers for the same note.
--
-- WHY THIS EXISTS (SCHEMA 安全模型 §1/§2 单一读/写路径; D3/D5/D6/D14; G1/G4).
-- `anon` has NO direct privilege on the comments table (0004/0005) — every guest
-- read and write of a comment flows through one of these two SECURITY DEFINER
-- functions, which run as the table-owning migration role (bypassing RLS) and
-- enforce, in ONE place, the visibility gate (read) and the unlock + authorship +
-- host-only rules (write). The host's own direct read of their event's comments is
-- a separate path — the events.host_id ownership RLS read — NOT these RPCs.
--
-- ── COMMENT-READ CONTRACT (get_comments; SCHEMA "get_comments" + TEST-SPEC §1.5d/§4.1) ──
--   * READ IS OPEN (D6 读开放): an un-RSVP'd / not-unlocked viewer CAN read the feed.
--     There is deliberately NO unlock gate here (the boundary grep 护栏 6 requires the
--     helper only in get_event_by_slug / get_guest_list / add_comment — NOT here).
--   * BUT it still carries the D3 visibility gate (沿用 D3 可见性闸): a private event's
--     feed is readable ONLY through the trusted SSR path (service_role). anon /
--     authenticated guests calling a private slug directly get [] — private comments
--     never leak (TEST-SPEC §1.5d 私密评论). This mirrors get_event_by_slug's ① gate.
--   * Each entry exposes ONLY id / body / author display_name / is_host / created_at.
--     The author's guest_id / host_id / user_id / contact are NEVER placed in the
--     result — authorship is surfaced as a name + an is_host badge, nothing linkable.
--   * 时间正序 (created_at asc) — the feed reads oldest→newest (§4.1).
--   * hide_feed_timestamps is 纯渲染 (SCHEMA §2): created_at is still returned; the
--     frontend hides it. So it is NOT applied here.
--   * `guest_token` is accepted for call-site symmetry with the other guest RPCs and
--     forward-compat, but is intentionally UNUSED — the read is open, so nothing gates
--     on it. (Passing it must never change the result.)
--   * RETURNS jsonb — always a jsonb ARRAY. Unknown slug and the private-blocked case
--     both return the SAME '[]'::jsonb, so the type is uniform and neither leaks an
--     existence/visibility oracle. Same posture as 0009 get_guest_list.
--
-- ── COMMENT-WRITE CONTRACT (add_comment; SCHEMA "add_comment" + TEST-SPEC §1.5d) ──
--   * AUTHOR IS BOUND SERVER-SIDE (D6) — the client can NEVER choose the author:
--       · caller is the event host (auth.uid() = events.host_id) ⇒ author = host
--         (host_id := auth.uid(), guest_id := null). The host may always comment —
--         the unlock gate and rsvp_enabled do NOT apply to them.
--       · otherwise ⇒ guest path: author = the guest_id RESOLVED BY THE SHARED GATE
--         helper from the event-scoped token (or the caller's linked account), NOT
--         anything the client sent. There is no guest_id/host_id parameter at all, so
--         a forged-author attempt has nowhere to land (TEST-SPEC §1.5d 作者伪造).
--   * WRITE GATE = the shared helper ONLY (G4): a guest must be UNLOCKED
--     (public.guest_unlock_status → unlocked=true) to post. 护栏 6 greps THIS function
--     body for the `guest_unlock_status(` call and FAILS the task if the gate is
--     re-implemented. The helper scopes the token to event_id, so a forged /
--     cross-event / absent token ⇒ unlocked=false ⇒ rejected (cross-event §1.5d).
--   * rsvp_enabled=false ⇒ HOST-ONLY (D6): the guest branch is rejected outright; only
--     the host (above) may post. (评论降级 host-only — SCHEMA §2 rsvp_enabled.)
--   * NEVER writes gif_url (D6): the column stays null; the GIF surface is removed for
--     the MVP (XSS面). Re-enabling needs https + a domain allowlist first.
--   * WRITE-SIDE DEPTH RATE LIMIT (D14/G7, §2.3.5): before any work we atomically
--     upsert-and-increment a per-(event, identity) counter in `rate_limits` and raise
--     once it exceeds the cap in the current fixed 60-second window. This is the
--     BACKSTOP that still bites an abuser who bypasses the Next/Upstash read limiter
--     and hits this RPC directly ("绕 Next 也拦" — §2.3.5 asserts add_comment is
--     DB-limited). Counting runs BEFORE the gates so even rejected spam is throttled.
--     Identity = the Next-injected real client IP/fingerprint when present, else the
--     guest_token (a returning guest), else the host's auth.uid(), else a per-event
--     `anon` bucket. `client_fingerprint` is an OPTIONAL trailing param — the pinned
--     3-arg call `add_comment(slug, guest_token, body)` still works unchanged; the SSR
--     route injects the real IP so each caller is isolated in its own bucket. The cap
--     is generous so normal feed chatter never trips it — only sustained abuse does.
--   * RETURNS jsonb (the inserted row, desensitized like the read path): id / body /
--     author_display_name / is_host / created_at. No third-tier field is ever returned.
--
-- Both functions pin search_path empty (everything schema-qualified, incl. auth.uid()/
-- auth.role(); pg_catalog built-ins resolve implicitly) to harden the definers against
-- search_path hijacking — same posture as 0002/0006/0007/0008/0009.

-- ── get_comments(slug, guest_token?) → jsonb ──────────────────────────────────
create or replace function public.get_comments(
  slug        text,
  guest_token uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event  public.events%rowtype;
  v_result jsonb;
begin
  -- Resolve the event by slug. Unknown slug → empty feed (no existence oracle).
  select * into v_event
  from public.events e
  where e.slug = get_comments.slug;

  if not found then
    return '[]'::jsonb;
  end if;

  -- D3 visibility gate (沿用 D3 可见性闸): read is open for public events, but a
  -- PRIVATE event's feed is reachable ONLY via the trusted SSR path (service_role).
  -- anon / an authenticated guest hitting a private slug directly get [] — private
  -- comments never leak. `is distinct from` denies a null role (no JWT) too. The
  -- legitimate guest of a private event reads through that same SSR path (which
  -- forwards as service_role); the host reads via direct ownership RLS, not this RPC.
  if v_event.visibility = 'private'
     and auth.role() is distinct from 'service_role' then
    return '[]'::jsonb;
  end if;

  -- READ-OPEN (D6): no unlock gate — `guest_token` is intentionally unused here.
  -- Desensitized projection: ONLY id / body / author display_name / is_host /
  -- created_at. The author's guest_id / host_id / user_id / contact never leave this
  -- query — authorship is just a name + a host badge. 时间正序 (oldest first).
  -- jsonb_agg over an empty set is NULL → coalesce to '[]' so the type stays array.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',                  c.id,
               'body',                c.body,
               'author_display_name', coalesce(g.display_name, p.display_name),
               'is_host',             (c.host_id is not null),
               'created_at',          c.created_at
             )
             order by c.created_at asc, c.id
           ),
           '[]'::jsonb
         )
    into v_result
  from public.comments c
  left join public.guests   g on g.id = c.guest_id
  left join public.profiles p on p.id = c.host_id
  where c.event_id = v_event.id;

  return v_result;
end;
$$;

-- EXECUTE: anon reads the public feed; authenticated for a logged-in viewer;
-- service_role for the trusted SSR path (the only path that may read a private feed).
-- PUBLIC's implicit default execute is replaced by these explicit grants.
revoke all on function public.get_comments(text, uuid) from public;
grant execute on function public.get_comments(text, uuid)
  to anon, authenticated, service_role;

-- ── add_comment(slug, guest_token, body, client_fingerprint?) → jsonb ─────────
create or replace function public.add_comment(
  slug               text,
  guest_token        uuid default null,
  body               text default null,
  client_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- DB depth rate limit (D14/G7): at most this many comment attempts per
  -- (event, identity) per fixed 60-second window. Generous on purpose — normal feed
  -- chatter stays far under it; only sustained abuse trips it. The §2.3.5 limiter
  -- test loops past this value to assert the DB backstop bites even when Next is
  -- bypassed.
  c_comment_limit constant integer := 50;

  v_event       public.events%rowtype;
  v_body        text;
  v_is_host     boolean := false;
  v_guest_id    uuid;
  v_host_id     uuid;
  v_unlocked    boolean;
  v_comment     public.comments%rowtype;
  v_author_name text;
  v_bucket      text;
  v_window      timestamptz;
  v_count       integer;
begin
  -- ── Input validation (the function is the trust boundary, CLAUDE.md rule 3) ──
  v_body := nullif(btrim(body), '');
  if v_body is null then
    raise exception 'comment body is required';
  end if;

  -- ── Resolve the event by slug. Unknown slug → error (no row to write to). ──────
  select * into v_event
  from public.events e
  where e.slug = add_comment.slug;

  if not found then
    raise exception 'event not found';
  end if;

  if v_event.status = 'cancelled' then
    raise exception 'event is cancelled';
  end if;

  -- ── Write-side depth rate limit (D14) — BEFORE any gate, so even rejected spam is
  -- throttled. Identity prefers the Next-injected fingerprint, then the token, then
  -- the host's auth.uid(), then a per-event anon bucket. Atomic upsert-and-increment
  -- on unique(bucket_key, window_start); count the attempt itself. ─────────────────
  v_bucket := 'comment:' || v_event.id::text || ':'
              || coalesce(nullif(client_fingerprint, ''),
                          guest_token::text,
                          auth.uid()::text,
                          'anon');
  v_window := date_trunc('minute', now());

  insert into public.rate_limits (bucket_key, window_start, count)
  values (v_bucket, v_window, 1)
  on conflict (bucket_key, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;

  if v_count > c_comment_limit then
    raise exception 'add_comment rate limit exceeded' using errcode = 'P0001';
  end if;

  -- ── Author binding (D6) — server-side, never client-chosen ────────────────────
  if auth.uid() is not null and auth.uid() = v_event.host_id then
    -- Caller is the event host: author = host. The host may always comment — the
    -- unlock gate and rsvp_enabled do NOT apply to them.
    v_is_host  := true;
    v_host_id  := auth.uid();
    v_guest_id := null;
  else
    -- Guest path. rsvp_enabled=false ⇒ HOST-ONLY (D6): reject the guest outright.
    if not v_event.rsvp_enabled then
      raise exception 'commenting is host-only for this event' using errcode = 'P0001';
    end if;

    -- Write gate (G4): the caller must be UNLOCKED, decided ONLY by the shared
    -- helper — token scoped to THIS event, or the caller's linked account. The
    -- helper also RESOLVES the author's guest_id, so authorship is bound to the
    -- verified credential, not to anything the client sent (no guest_id/host_id
    -- param exists). Forged / cross-event / absent token ⇒ unlocked=false ⇒ rejected.
    select gu.guest_id, coalesce(gu.unlocked, false)
      into v_guest_id, v_unlocked
    from public.guest_unlock_status(v_event.id, guest_token) gu;

    if not coalesce(v_unlocked, false) then
      raise exception 'RSVP required to comment' using errcode = 'P0001';
    end if;

    v_host_id := null;   -- guest author: host_id stays null (exactly-one-author check)
  end if;

  -- ── Insert the comment. gif_url is NEVER written (D6) — the column stays null.
  -- The comments_one_author check (num_nonnulls(guest_id, host_id)=1) is satisfied:
  -- the host branch set host_id (guest_id null), the guest branch a non-null
  -- guest_id (host_id null; the unlock gate guarantees guest_id is present). ────────
  insert into public.comments (event_id, guest_id, host_id, body)
  values (v_event.id, v_guest_id, v_host_id, v_body)
  returning * into v_comment;

  -- Author display_name for the confirmation (same shape as the read path).
  if v_is_host then
    select p.display_name into v_author_name
    from public.profiles p where p.id = v_host_id;
  else
    select g.display_name into v_author_name
    from public.guests g where g.id = v_guest_id;
  end if;

  -- Desensitized confirmation: no guest_id/host_id/contact/token ever returned.
  return jsonb_build_object(
    'id',                  v_comment.id,
    'body',                v_comment.body,
    'author_display_name', v_author_name,
    'is_host',             v_is_host,
    'created_at',          v_comment.created_at
  );
end;
$$;

-- EXECUTE: anon is the primary guest commenter (browser presenting their token);
-- authenticated lets the host (auth.uid()=host_id) and account-linked guests post;
-- service_role for the trusted SSR / server-action path that injects the real client
-- IP into client_fingerprint. PUBLIC's implicit default execute is replaced here.
revoke all on function
  public.add_comment(text, uuid, text, text) from public;
grant execute on function
  public.add_comment(text, uuid, text, text)
  to anon, authenticated, service_role;
