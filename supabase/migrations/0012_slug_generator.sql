-- 0012_slug_generator.sql — Task 1.6: the event slug generator (slugify + base62
-- tail), per SCHEMA "SLUG 生成规格" / D15.
--
-- Physical 0012 = logical task "1.6": the Supabase CLI only applies files whose
-- version prefix is purely numeric, so the physical numbering runs one ahead of
-- the logical labels (1.1a=0001 … 1.5e=0011, 1.6=0012). Sorts right after
-- 0011_vote_finalize_promote_aggregates.sql.
--
-- WHY THIS EXISTS. The slug is the ONLY public handle on an event and it travels
-- in the URL (the guest_token NEVER does — SCHEMA "URL 边界"). For a PRIVATE event
-- the human-readable prefix must therefore not leak anything inferable, and the
-- 10-char random tail is the real anti-enumeration defence: it must come from a
-- cryptographic source so an attacker cannot walk private slugs. The tail's
-- randomness is a HARD SECURITY property, not cosmetics (护栏 2 greps for it).
--
-- THE PINNED CONTRACT (SCHEMA "SLUG 生成规格", D15):
--   * Shape = `{slugify(title), capped at 40 chars}-{10-char base62 tail}`.
--   * Empty slugify (pure-Chinese / blank / punctuation-only title) collapses to
--     JUST the random tail — no leading hyphen, NO transliteration (a private
--     event's prefix must not leak inferable info).
--   * The tail is base62 from extensions.gen_random_bytes() ONLY. NEVER random()
--     / timestamp / sequence — those are predictable.
--   * Uniqueness is fail-closed: on a collision the generator retries ONCE with a
--     fresh tail; a second collision RAISES. It never silently degrades to a
--     weaker source or a longer/mangled slug.
--
-- NOT wired into events here. The events.slug column keeps its crypto-strong
-- fallback default (0001) and stays the ultimate unique backstop; the create-event
-- flow (task 2.2a) calls generate_event_slug(title) explicitly to mint the
-- readable slug before insert. Keeping this migration additive (functions only)
-- avoids changing existing insert behaviour.

-- ── slugify: the human-readable prefix ───────────────────────────────────────
-- Lowercase, drop apostrophes (so "Rain's" -> "rains", not "rain-s"), turn every
-- run of non-[a-z0-9] into a single hyphen, trim hyphens, cap at 40 chars, then
-- re-trim in case the 40-char cut landed on a separator. Non-ASCII (e.g. Chinese)
-- has no [a-z0-9] survivors -> collapses to '' (the caller then emits a pure tail).
-- IMMUTABLE + only pg_catalog built-ins (translate/lower/regexp_replace/left/trim
-- /chr) which always resolve regardless of search_path.
create or replace function public.slugify(input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from
    left(
      trim(both '-' from
        regexp_replace(
          translate(lower(coalesce(input, '')), chr(39) || chr(8217), ''),
          '[^a-z0-9]+', '-', 'g'
        )
      ),
      40
    )
  );
$$;

-- ── slug_random_suffix: the crypto-random tail ───────────────────────────────
-- n base62 chars derived from extensions.gen_random_bytes(n). Each byte (0..255)
-- is folded into the 62-char alphabet via `% 62` and indexed 1-based into the
-- alphabet. gen_random_bytes is the ONLY entropy source (护栏 2). search_path is
-- pinned empty and the only cross-schema call is schema-qualified.
create or replace function public.slug_random_suffix(n integer default 10)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text :=
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  bytes  bytea;
  result text := '';
  i      integer;
begin
  if n is null or n < 1 then
    raise exception 'slug_random_suffix length must be >= 1 (got %)', n;
  end if;
  bytes := extensions.gen_random_bytes(n);
  for i in 0 .. n - 1 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 62) + 1, 1);
  end loop;
  return result;
end;
$$;

-- ── generate_event_slug: prefix + tail, unique, fail-closed ───────────────────
-- SECURITY DEFINER so the uniqueness probe sees ALL events regardless of the
-- caller's RLS — otherwise a host would only "see" their own events and could
-- mint a slug that collides with another host's, defeating the retry (the unique
-- constraint would then reject the insert with no readable error). search_path
-- pinned empty; slugify / slug_random_suffix / events are all schema-qualified.
create or replace function public.generate_event_slug(title text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  prefix    text;
  suffix    text;
  candidate text;
  attempt   integer;
begin
  prefix := public.slugify(title);
  -- Up to TWO attempts: a fresh crypto-random tail each time, retry ONCE on a
  -- unique-collision, then fail closed (D15) — never widen/weaken the slug.
  for attempt in 1 .. 2 loop
    suffix := public.slug_random_suffix(10);
    if prefix = '' then
      candidate := suffix;                  -- Chinese/blank title -> pure random tail
    else
      candidate := prefix || '-' || suffix;
    end if;
    if not exists (select 1 from public.events e where e.slug = candidate) then
      return candidate;
    end if;
  end loop;
  raise exception 'could not generate a unique event slug after retry (fail-closed, D15)';
end;
$$;

-- EXECUTE: only hosts (authenticated) and the trusted SSR/server path
-- (service_role) ever mint slugs — guests never create events, so anon gets
-- nothing. PUBLIC's implicit default execute is replaced by explicit grants.
revoke all on function public.slugify(text) from public;
grant execute on function public.slugify(text) to authenticated, service_role;

revoke all on function public.slug_random_suffix(integer) from public;
grant execute on function public.slug_random_suffix(integer) to authenticated, service_role;

revoke all on function public.generate_event_slug(text) from public;
grant execute on function public.generate_event_slug(text) to authenticated, service_role;
