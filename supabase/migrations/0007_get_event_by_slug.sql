-- 0007_get_event_by_slug.sql — Task 1.5a [SECURITY]: the public read path
-- `get_event_by_slug` (tiered fields + private gate + password gate + count rule)
-- plus the password verifier `verify_event_password`. TASKS.md labels this "(0005b)".
--
-- Named 0007_* (logical "0005b"): the Supabase CLI only applies files whose
-- version prefix is purely numeric, so the physical numbering runs one ahead of
-- the logical labels (1.1a=0001 … 1.5.0=0006, 1.5a=0007). This sorts right after
-- 0006_guest_unlock_status.sql — see the 0002…0006 headers for the same note.
--
-- WHY THIS EXISTS (SCHEMA 安全模型 §1 单一读路径; D3/D5/D7②; G1/G4).
-- `anon` has NO direct privilege on any client-data table (0004/0005). Every
-- guest/public read of an event therefore flows through THIS SECURITY DEFINER
-- function, which — running as the table-owning migration role — bypasses RLS for
-- the read and enforces the field-tier boundary in ONE place. The function is the
-- physical guarantee that an un-RSVP'd / unauthenticated viewer can never see the
-- full address, the guest list, or a private event's existence.
--
-- THE FIELD TIERS (SCHEMA "get_event_by_slug 字段边界", pinned):
--   第一类 (public façade, always past the gates): title, description, cover,
--     theme, effect, location_CITY (city only), starts/ends_at, date_tbd, host
--     display_name, rsvp_enabled, + going_count/capacity_remaining (see count rule).
--   第二类 (only after unlock): location_TEXT (full address), location_url, and —
--     via separate RPCs — the guest list + comment-post right. We surface a single
--     `unlocked` boolean so the client knows to fetch those.
--   第三类 (NEVER to any guest): guests.contact, other guests' token/user_id, the
--     raw view_password_hash, the Can't-Go list, questionnaire answers. None of
--     those are ever placed in the returned object here.
--
-- THE GATE ORDER (SCHEMA "私密 + 密码闸顺序", strict):
--   ① visibility='private' AND caller is not service_role  → return NULL (D3).
--      Private events are link-private AND DB-role-gated: only the trusted Next SSR
--      path (service_role) can read them; anon/authenticated guests get nothing,
--      not even a façade. `is distinct from` so a null role (no JWT) is denied too.
--   ② view_password_hash set AND password absent/wrong → return the MINIMAL LOCKED
--      response (title/cover/description — enough for the password box + share
--      preview), and NOTHING second-tier. service_role does NOT bypass this: a
--      password-protected event must show only the façade until the password is
--      presented, even on the SSR path (else a plain SSR load would leak the
--      address to anyone with the link).
--   ③ otherwise → normal tiered response.
--
-- THE COUNT RULE (D7②): going_count + capacity_remaining are OMITTED FROM THE
-- RETURN BODY (省略而非置0 — the KEYS are absent, not zeroed) when hide_guest_count
-- is set, OR the event is private and the caller is not unlocked. Returning jsonb
-- (not a fixed composite) is deliberate: it is the only way to omit a key rather
-- than send it as null, which TEST-SPEC §1.5a checks structurally ('going_count'
-- not in data).
--
-- UNLOCK IS DECIDED ONLY BY THE SHARED HELPER (G4). The second-tier gate and the
-- count rule both read `unlocked` from public.guest_unlock_status(event_id, token)
-- — never a re-implemented predicate. 护栏 6/8 greps THIS function body for the
-- `guest_unlock_status(` call and FAILS the task if the gate is inlined instead.
-- The helper scopes the token to event_id, so a forged / cross-event / absent
-- token yields unlocked=false here and the address/list stay hidden.
--
-- search_path is pinned empty (everything schema-qualified, incl. auth.role()/
-- auth.uid() and extensions.crypt) to harden the definer against search_path
-- hijacking — same posture as 0002/0006.

-- ── verify_event_password(slug, password) → boolean ───────────────────────────
-- The dedicated password check for the Next password box (task 2.5): bcrypt-verify
-- a candidate against the stored hash. SCHEMA also has it carry per-IP/-event rate
-- limiting — that lives in the 2.3.5 limiter infrastructure (Next + the rate_limits
-- depth limiter); the signature here is the pinned `(slug, password)`, so this
-- function stays the pure, correct bcrypt verifier (NOT a stub — it really hashes).
create or replace function public.verify_event_password(
  slug     text,
  password text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select e.view_password_hash into v_hash
  from public.events e
  where e.slug = verify_event_password.slug;

  if not found then
    return false;            -- unknown slug: nothing to grant access to
  end if;

  if v_hash is null then
    return true;             -- event isn't password-protected: gate is open
  end if;

  if password is null then
    return false;            -- a hash is set but no candidate was supplied
  end if;

  -- bcrypt: crypt(candidate, stored_hash) reproduces stored_hash IFF the candidate
  -- matches. Comparing against the stored hash (its own salt) is constant-shape.
  return v_hash = extensions.crypt(password, v_hash);
end;
$$;

revoke all on function public.verify_event_password(text, text) from public;
grant execute on function public.verify_event_password(text, text)
  to anon, authenticated, service_role;

-- ── get_event_by_slug(slug, guest_token?, password?) → jsonb ──────────────────
create or replace function public.get_event_by_slug(
  slug        text,
  guest_token uuid default null,
  password    text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_event       public.events%rowtype;
  v_host_name   text;
  v_is_unlocked boolean;
  v_occupancy   integer;
  v_show_count  boolean;
  v_result      jsonb;
begin
  -- Resolve the event by slug. Unknown slug → null (no existence oracle).
  select * into v_event
  from public.events e
  where e.slug = get_event_by_slug.slug;

  if not found then
    return null;
  end if;

  -- ① Private gate (D3): only the trusted SSR path (service_role) may read a
  -- private event at all. Everyone else — anon, an authenticated guest — gets
  -- null, never even a façade. (Hosts read their own private events through the
  -- direct host-ownership RLS path, not this RPC.)
  if v_event.visibility = 'private'
     and auth.role() is distinct from 'service_role' then
    return null;
  end if;

  -- ② Password gate: a hash present means the caller must supply the matching
  -- password (same bcrypt semantics as verify_event_password; the hash is already
  -- in hand so we don't re-query). On failure return only the minimal locked
  -- response — title/cover/description for the password box + share preview, and
  -- nothing second-tier. NOT bypassed by service_role (see header).
  if v_event.view_password_hash is not null
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
  -- helper (G4) — token scoped to THIS event, or the caller's linked account.
  -- Forged / cross-event / absent token ⇒ unlocked=false ⇒ address & list stay hidden.
  select coalesce(gu.unlocked, false) into v_is_unlocked
  from public.guest_unlock_status(v_event.id, guest_token) gu;

  select p.display_name into v_host_name
  from public.profiles p
  where p.id = v_event.host_id;

  -- Occupancy = going headcount INCLUDING plus-ones (mirrors submit_rsvp's
  -- capacity accounting, D7①). plus_ones is NOT NULL default 0.
  select coalesce(sum(1 + r.plus_ones), 0) into v_occupancy
  from public.rsvps r
  where r.event_id = v_event.id and r.status = 'going';

  -- Count rule (D7②): show going_count/capacity_remaining unless hide_guest_count,
  -- or the event is private and the caller is not unlocked. When false the keys are
  -- OMITTED below (省略而非置0).
  v_show_count := not v_event.hide_guest_count
                  and not (v_event.visibility = 'private' and not v_is_unlocked);

  -- First-tier façade — always returned once past the gates. No third-tier field
  -- (contact / other tokens / raw hash / Can't-Go / answers) is ever included.
  v_result := jsonb_build_object(
    'id',                  v_event.id,
    'slug',                v_event.slug,
    'title',               v_event.title,
    'description',         v_event.description,
    'cover_image_url',     v_event.cover_image_url,
    'theme',               v_event.theme,
    'effect',              v_event.effect,
    'location_city',       v_event.location_city,   -- city-level only (first tier)
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
    'unlocked',            v_is_unlocked
  );

  -- going_count / capacity_remaining added as KEYS only when visible (capacity
  -- null ⇒ unlimited ⇒ remaining null). Absent entirely otherwise.
  if v_show_count then
    v_result := v_result || jsonb_build_object(
      'going_count', v_occupancy,
      'capacity_remaining',
        case when v_event.capacity is null then null
             else greatest(v_event.capacity - v_occupancy, 0) end
    );
  end if;

  -- Second tier (sensitive): full address only after unlock. The guest list and
  -- the comment-post right are separate RPCs; the `unlocked` flag above is the
  -- client's signal to fetch them.
  if v_is_unlocked then
    v_result := v_result || jsonb_build_object(
      'location_text', v_event.location_text,
      'location_url',  v_event.location_url
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_event_by_slug(text, uuid, text) from public;
grant execute on function public.get_event_by_slug(text, uuid, text)
  to anon, authenticated, service_role;
