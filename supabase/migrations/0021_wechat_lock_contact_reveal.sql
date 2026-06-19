-- 0021_wechat_lock_contact_reveal.sql — Round-4: WeChat binding + event "lock"
-- with deferred TWO-WAY, EPHEMERAL contact reveal (阅后即焚).
--
-- WHY THIS EXISTS (HANDOFF §12 + "JU 细节纠偏" §6; audited & strengthened).
-- The product: host and guest each bind a WeChat id, but NEITHER side's WeChat is
-- shown until the event is "locked" (收尾/定档). On lock the contacts open TWO-WAY —
-- the RSVP'd guest sees the host's WeChat, the host sees each attending guest's
-- WeChat — and stay open only within a BURN WINDOW (disappear 24h after the event's
-- effective end). Guests NEVER see each other's WeChat. Locking also CLOSES new RSVPs.
--
-- DB IS THE SECURITY BOUNDARY (CLAUDE.md). WeChat is a "locked-only" field, gated in
-- SECURITY DEFINER RPCs exactly like location_text — never readable by anon or by an
-- unlocked/pre-lock/passerby caller. Two mechanisms enforce it:
--   1. The DEFINER RPCs below own every WeChat READ path (host & guest), each gated on
--      a lock + burn predicate.
--   2. COLUMN-LEVEL revokes (1.2) so the host's own DIRECT table read (the dashboard
--      roster) cannot pull guest wechat off the table at all, and locked_at cannot be
--      set/cleared via PostgREST — only lock_event may write it (irreversible).
--
-- Additive per CLAUDE.md: three columns, two shared SQL helpers, two NEW RPCs
-- (lock_event, get_event_guest_contacts), and the immutable-since-applied functions
-- submit_rsvp (0008) and get_event_by_slug (0018) DROPPED and RECREATED with the new
-- signatures here (never edited in place). search_path stays pinned empty on every
-- DEFINER; everything is schema-qualified; PUBLIC's implicit execute is revoked then
-- granted to the minimal roles.

-- ── 1.1 Schema additions ──────────────────────────────────────────────────────────
alter table public.profiles add column wechat_id text;   -- host wechat (host's own row)
alter table public.events   add column locked_at timestamptz;  -- manual lock; null = not manually locked; irreversible
alter table public.guests   add column wechat_id text;   -- guest wechat (RSVP-required; lock-gated on read)
-- NOTE: do NOT reuse guests.contact — different semantics (contact = host-anytime-
-- visible legacy metadata; wechat_id = locked-only contact exchange).

-- ── 1.2 Column-level privilege hardening (the host-side gate; DB is the boundary) ───
-- The host reads the roster via a DIRECT RLS table read (dashboard) and edits their
-- event directly. TWO columns must stay out of those direct paths:
--   • guests.wechat_id  — "locked-only" guest contact; reachable ONLY via the gated
--                          DEFINER RPC get_event_guest_contacts, never off the table.
--   • events.locked_at  — irreversible; writable ONLY by lock_event (DEFINER).
-- CRITICAL PG SEMANTICS: a column-level REVOKE does NOT subtract from the TABLE-WIDE
-- grants 0004 already issued (`grant select on guests`, `grant select,insert,update,
-- delete on events`) — a table-level privilege overrides a column-level revoke, so a
-- bare `revoke select (wechat_id)` / `revoke update (locked_at)` is a NO-OP (the host
-- could still read wechat off the table pre-lock and clear locked_at to re-open the
-- pre-lock state). The only correct way to hide ONE column from a role that holds the
-- table grant is to DROP the table-wide grant and RE-GRANT every column EXCEPT the
-- protected one. Tradeoff: a future column added to these tables needs its own grant
-- here — fail-closed, the safe direction. anon has NO grant on either table; DEFINER
-- RPCs run as the table owner and are unaffected. (The host roster read selects only
-- guests(display_name, contact) and no host write names locked_at, so this is
-- non-breaking — see migration-0021 boundary tests A4/A9.)

-- guests: re-grant SELECT on every column EXCEPT wechat_id.
revoke select on public.guests from authenticated;
grant select (id, event_id, guest_token, user_id, display_name, contact, created_at)
  on public.guests to authenticated;

-- events: re-grant UPDATE on every column EXCEPT locked_at. SELECT/INSERT/DELETE stay
-- table-wide from 0004, so the host still READS locked_at for the lock UI — only direct
-- UPDATE of locked_at is denied (lock_event is the sole writer; irreversible).
revoke update on public.events from authenticated;
grant update (id, host_id, slug, title, description, cover_image_url, theme, effect,
              starts_at, ends_at, date_tbd, location_text, location_url, location_city,
              lat, lng, visibility, view_password_hash, capacity, allow_plus_ones,
              max_plus_ones, rsvp_enabled, hide_guest_list, hide_guest_count,
              hide_feed_timestamps, anonymize_guest_list, allow_photo_upload,
              guest_approval_enabled, chip_in_url, chip_in_note, status,
              created_at, updated_at)
  on public.events to authenticated;

-- ── 1.3 Shared derivation helpers (stable SQL; reused everywhere — single source) ───
create or replace function public.event_is_locked(p_locked_at timestamptz, p_starts_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_locked_at is not null
      or (p_starts_at is not null and now() >= p_starts_at - interval '1 day');
$$;

-- Contact (wechat) opens ONLY while locked AND within the burn window: it disappears
-- 24h after the effective end (coalesce(ends_at, starts_at)). date_tbd (no dates)
-- never auto-burns.
create or replace function public.event_contact_open(
  p_locked_at timestamptz, p_starts_at timestamptz, p_ends_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select public.event_is_locked(p_locked_at, p_starts_at)
     and (coalesce(p_ends_at, p_starts_at) is null
          or now() < coalesce(p_ends_at, p_starts_at) + interval '24 hours');
$$;

revoke all on function public.event_is_locked(timestamptz, timestamptz) from public;
grant execute on function public.event_is_locked(timestamptz, timestamptz) to anon, authenticated, service_role;
revoke all on function public.event_contact_open(timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.event_contact_open(timestamptz, timestamptz, timestamptz) to anon, authenticated, service_role;

-- ── 1.4 New RPC: lock_event(event_id) — host-only, irreversible, idempotent ─────────
create or replace function public.lock_event(event_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_event public.events%rowtype;
begin
  select * into v_event from public.events e where e.id = lock_event.event_id;
  if not found then raise exception 'event not found'; end if;
  -- host-only: auth.uid() reflects the CALLER's JWT even inside SECURITY DEFINER.
  if v_event.host_id is distinct from auth.uid() then raise exception 'not authorized'; end if;
  -- Irreversible + idempotent: only ever null -> now(); never cleared, never moved.
  if v_event.locked_at is null then
    update public.events set locked_at = now() where id = v_event.id
      returning locked_at into v_event.locked_at;
  end if;
  return jsonb_build_object(
    'id', v_event.id,
    'locked_at', v_event.locked_at,
    'is_locked', public.event_is_locked(v_event.locked_at, v_event.starts_at)
  );
end; $$;
revoke all on function public.lock_event(uuid) from public;
grant execute on function public.lock_event(uuid) to authenticated, service_role;  -- NOT anon

-- ── 1.5 New RPC: get_event_guest_contacts(event_id) — host's lock-gated guest view ──
create or replace function public.get_event_guest_contacts(event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_event public.events%rowtype; v_result jsonb;
begin
  select * into v_event from public.events e where e.id = get_event_guest_contacts.event_id;
  if not found then return '[]'::jsonb; end if;
  if v_event.host_id is distinct from auth.uid() then return '[]'::jsonb; end if;     -- host-only
  if not public.event_contact_open(v_event.locked_at, v_event.starts_at, v_event.ends_at)
    then return '[]'::jsonb; end if;                                                  -- lock + burn gate
  select coalesce(jsonb_agg(jsonb_build_object(
           'display_name', g.display_name,
           'status',       r.status,
           'plus_ones',    r.plus_ones,
           'wechat_id',    g.wechat_id
         ) order by r.created_at asc, g.id), '[]'::jsonb)
    into v_result
  from public.rsvps r join public.guests g on g.id = r.guest_id
  where r.event_id = v_event.id and r.status in ('going','maybe','waitlisted');
  return v_result;
end; $$;
revoke all on function public.get_event_guest_contacts(uuid) from public;
grant execute on function public.get_event_guest_contacts(uuid) to authenticated, service_role;  -- NOT anon

-- ── 1.6 Recreate submit_rsvp — add wechat_id (required for going/maybe) + lock gate ─
-- Copied byte-faithfully from 0008 with ONLY the marked round-4 additions: the new
-- last parameter wechat_id, the lock gate (locking closes new RSVPs), the
-- required-for-attending check, and storing wechat the same way contact is stored.
-- Everything else (dedup D1, advisory-lock capacity/waitlist D7①, write-side rate
-- limit D14, return shape D15) is unchanged.
drop function if exists public.submit_rsvp(text, text, text, uuid, integer, text, text);

create or replace function public.submit_rsvp(
  slug               text,
  display_name       text,
  status             text default 'going',
  guest_token        uuid default null,
  plus_ones          integer default 0,
  contact            text default null,
  client_fingerprint text default null,
  wechat_id          text default null   -- round-4: guest wechat (required going/maybe)
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- DB depth rate limit (D14/G7): at most this many write attempts per
  -- (event, identity) per fixed 60-second window. Generous on purpose.
  c_submit_limit constant integer := 50;

  v_event       public.events%rowtype;
  v_name        text;
  v_status      text;
  v_plus_ones   integer;
  v_guest_id    uuid;
  v_guest_token uuid;
  v_outcome     text;
  v_occupancy   integer;
  v_bucket      text;
  v_window      timestamptz;
  v_count       integer;
  v_wechat      text;
begin
  -- ── Input validation (the function is the trust boundary, CLAUDE.md rule 3) ──
  v_name := nullif(btrim(display_name), '');
  if v_name is null then
    raise exception 'display_name is required';
  end if;

  v_status := lower(btrim(coalesce(status, '')));
  if v_status not in ('going', 'maybe', 'not_going') then
    raise exception 'invalid RSVP status: %', status;
  end if;

  -- ── Resolve the event by slug. Unknown slug → error (no row to write to) ──────
  select * into v_event
  from public.events e
  where e.slug = submit_rsvp.slug;

  if not found then
    raise exception 'event not found';
  end if;

  -- The event must be accepting RSVPs.
  if not v_event.rsvp_enabled then
    raise exception 'RSVP is disabled for this event';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'event is cancelled';
  end if;

  -- Locking the event closes new RSVPs (round-4: lock = finalize).
  if public.event_is_locked(v_event.locked_at, v_event.starts_at) then
    raise exception 'event is locked';
  end if;

  -- Guest wechat is required when actually attending (going/maybe). A 'not_going'
  -- decline carries no contact exchange, so wechat may be omitted there.
  v_wechat := nullif(btrim(wechat_id), '');
  if v_status in ('going','maybe') and v_wechat is null then
    raise exception 'wechat_id is required';
  end if;

  -- Clamp plus_ones to what the event allows.
  v_plus_ones := least(
    greatest(coalesce(plus_ones, 0), 0),
    case when v_event.allow_plus_ones then v_event.max_plus_ones else 0 end
  );

  -- ── Write-side depth rate limit (D14) ───────────────────────────────────────────
  v_bucket := 'submit:' || v_event.id::text || ':'
              || coalesce(nullif(client_fingerprint, ''), guest_token::text, 'anon');
  v_window := date_trunc('minute', now());

  insert into public.rate_limits (bucket_key, window_start, count)
  values (v_bucket, v_window, 1)
  on conflict (bucket_key, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;

  if v_count > c_submit_limit then
    raise exception 'submit_rsvp rate limit exceeded' using errcode = 'P0001';
  end if;

  -- ── Per-event serialization for the capacity decision (D7①). ────────────────────
  perform pg_advisory_xact_lock(hashtext(v_event.id::text));

  -- ── Dedup (D1): token (event-scoped) → linked account → new guest ─────────────
  if guest_token is not null then
    select g.id, g.guest_token into v_guest_id, v_guest_token
    from public.guests g
    where g.event_id = v_event.id
      and g.guest_token = submit_rsvp.guest_token;
  end if;

  if v_guest_id is null and auth.uid() is not null then
    select g.id, g.guest_token into v_guest_id, v_guest_token
    from public.guests g
    where g.event_id = v_event.id
      and g.user_id = auth.uid();
  end if;

  if v_guest_id is not null then
    -- Update the matched guest's mutable fields. wechat set the same way as contact.
    update public.guests g
       set display_name = v_name,
           contact      = submit_rsvp.contact,
           wechat_id    = v_wechat,
           user_id      = coalesce(g.user_id, auth.uid())
     where g.id = v_guest_id;
  else
    -- (3) brand-new guest: fresh server-minted token (column default), account link
    -- from auth.uid() (null for anon). contact + wechat carried as metadata.
    insert into public.guests (event_id, display_name, contact, wechat_id, user_id)
    values (v_event.id, v_name, submit_rsvp.contact, v_wechat, auth.uid())
    returning guests.id, guests.guest_token into v_guest_id, v_guest_token;
  end if;

  -- ── Capacity / waitlist decision (D7①), inside the advisory lock ──────────────
  if v_status = 'going' and v_event.capacity is not null then
    select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
    from public.rsvps r
    where r.event_id = v_event.id
      and r.status = 'going'
      and r.guest_id <> v_guest_id;

    if v_occupancy + (1 + v_plus_ones) > v_event.capacity then
      v_outcome := 'waitlisted';
    else
      v_outcome := 'going';
    end if;
  else
    v_outcome := v_status;
  end if;

  -- ── Upsert the RSVP (unique(event_id, guest_id)). ──────────────────────────────
  insert into public.rsvps (event_id, guest_id, status, plus_ones)
  values (v_event.id, v_guest_id, v_outcome, v_plus_ones)
  on conflict (event_id, guest_id)
    do update set status    = excluded.status,
                  plus_ones = excluded.plus_ones;

  -- ── Confirmation (D15): own token + confirmed status. ───────────────────────────
  return jsonb_build_object(
    'event_id',    v_event.id,
    'guest_id',    v_guest_id,
    'guest_token', v_guest_token,
    'status',      v_outcome,
    'plus_ones',   v_plus_ones,
    'waitlisted',  (v_outcome = 'waitlisted')
  );
end;
$$;

revoke all on function
  public.submit_rsvp(text, text, text, uuid, integer, text, text, text) from public;
grant execute on function
  public.submit_rsvp(text, text, text, uuid, integer, text, text, text)
  to anon, authenticated, service_role;

-- ── 1.7 Recreate get_event_by_slug — add is_locked + gated host_wechat_id ───────────
-- Copied byte-faithfully from 0018 (same 5-arg signature, same drop/recreate/grant)
-- with ONLY the marked round-4 additions: pull the host wechat alongside the name,
-- compute is_locked + contact_open, always expose is_locked on the tiered façade, and
-- reveal host_wechat_id ONLY to an UNLOCKED (RSVP'd) viewer once locked AND within the
-- burn window (double-blind + 阅后即焚). The password-locked minimal branch is
-- UNCHANGED. The guest_unlock_status(...) call is preserved (护栏 6 / G4).
drop function if exists public.get_event_by_slug(text, uuid, text, boolean, uuid);

create or replace function public.get_event_by_slug(
  slug              text,
  guest_token       uuid    default null,
  password          text    default null,
  password_verified boolean default false,
  viewer_id         uuid    default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event        public.events%rowtype;
  v_host_name    text;
  v_host_wechat  text;
  v_is_unlocked  boolean;
  v_is_locked    boolean;
  v_contact_open boolean;
  v_occupancy    integer;
  v_show_count   boolean;
  v_viewer_id    uuid;
  v_result       jsonb;
begin
  -- Resolve the event by slug. Unknown slug → null (no existence oracle).
  select * into v_event
  from public.events e
  where e.slug = get_event_by_slug.slug;

  if not found then
    return null;
  end if;

  -- ① Private gate (D3): only the trusted SSR path (service_role) may read a private
  -- event at all. Everyone else gets null.
  if v_event.visibility = 'private'
     and auth.role() is distinct from 'service_role' then
    return null;
  end if;

  -- ② Password gate. On failure return only the minimal locked response — nothing
  -- second-tier, and (round-4) no is_locked / host_wechat either.
  if v_event.view_password_hash is not null
     and not (get_event_by_slug.password_verified and auth.role() = 'service_role')
     and (password is null
          or v_event.view_password_hash <> extensions.crypt(password, v_event.view_password_hash)) then
    return jsonb_build_object(
      'slug',             v_event.slug,
      'title',            v_event.title,
      'description',      v_event.description,
      'cover_image_url',  v_event.cover_image_url,
      'visibility',       v_event.visibility,
      'requires_password', true,
      'locked',           true,
      'unlocked',         false
    );
  end if;

  -- ③ Normal tiered response. The unlock decision comes ONLY from the shared gate
  -- helper (G4) — token scoped to THIS event, or the caller's linked account. The
  -- trusted viewer_id is HONOURED ONLY for service_role.
  v_viewer_id := case when auth.role() = 'service_role' then get_event_by_slug.viewer_id
                      else null end;

  select coalesce(gu.unlocked, false) into v_is_unlocked
  from public.guest_unlock_status(v_event.id, guest_token, v_viewer_id) gu;

  select p.display_name, p.wechat_id into v_host_name, v_host_wechat
  from public.profiles p
  where p.id = v_event.host_id;

  -- Round-4 lock + burn derivation (single source: the shared helpers).
  v_is_locked    := public.event_is_locked(v_event.locked_at, v_event.starts_at);
  v_contact_open := public.event_contact_open(v_event.locked_at, v_event.starts_at, v_event.ends_at);

  -- Occupancy = going headcount INCLUDING plus-ones (mirrors submit_rsvp's accounting).
  select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
  from public.rsvps r
  where r.event_id = v_event.id and r.status = 'going';

  -- Count rule (D7②).
  v_show_count := not v_event.hide_guest_count
                  and not (v_event.visibility = 'private' and not v_is_unlocked);

  -- First-tier façade — always returned once past the gates. is_locked is ALWAYS
  -- present here (round-4). No third-tier field is ever included.
  v_result := jsonb_build_object(
    'id',                  v_event.id,
    'slug',                v_event.slug,
    'title',               v_event.title,
    'description',         v_event.description,
    'cover_image_url',     v_event.cover_image_url,
    'theme',               v_event.theme,
    'effect',              v_event.effect,
    'location_city',       v_event.location_city,
    'starts_at',           v_event.starts_at,
    'ends_at',             v_event.ends_at,
    'date_tbd',            v_event.date_tbd,
    'host_display_name',   v_host_name,
    'rsvp_enabled',        v_event.rsvp_enabled,
    'visibility',          v_event.visibility,
    'capacity',            v_event.capacity,
    'allow_plus_ones',     v_event.allow_plus_ones,
    'max_plus_ones',       v_event.max_plus_ones,
    'hide_guest_list',     v_event.hide_guest_list,
    'hide_guest_count',    v_event.hide_guest_count,
    'hide_feed_timestamps', v_event.hide_feed_timestamps,
    'chip_in_url',         v_event.chip_in_url,
    'chip_in_note',        v_event.chip_in_note,
    'status',              v_event.status,
    'requires_password',   v_event.view_password_hash is not null,
    'locked',              false,
    'is_locked',           v_is_locked,
    'unlocked',            v_is_unlocked
  );

  -- going_count / capacity_remaining added as KEYS only when visible.
  if v_show_count then
    v_result := v_result || jsonb_build_object(
      'going_count', v_occupancy,
      'capacity_remaining',
        case when v_event.capacity is null then null
             else greatest(v_event.capacity - v_occupancy, 0) end
    );
  end if;

  -- Second tier (sensitive): full address only after unlock.
  if v_is_unlocked then
    v_result := v_result || jsonb_build_object(
      'location_text', v_event.location_text,
      'location_url',  v_event.location_url
    );
  end if;

  -- Host wechat: revealed to an UNLOCKED (RSVP'd) viewer only once the event is locked
  -- and still within the burn window (阅后即焚). A non-RSVP'd passerby never gets it.
  if v_is_unlocked and v_contact_open then
    v_result := v_result || jsonb_build_object('host_wechat_id', v_host_wechat);
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_event_by_slug(text, uuid, text, boolean, uuid) from public;
grant execute on function public.get_event_by_slug(text, uuid, text, boolean, uuid)
  to anon, authenticated, service_role;
