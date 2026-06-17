import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonClient, hostClient, infra, serviceClient } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 1.7 — Storage buckets + RLS (migration 0013_storage_buckets_rls.sql;
 * SCHEMA "Storage (D16)" / TEST-SPEC §1.3 Storage bullet).
 *
 * Storage is the one place a guest-facing asset (the cover, an OG image) and a
 * strictly private one (the album) share a single physical table — storage.objects
 * — so the write policy is the whole security story: without the host-ownership +
 * path-prefix check, ANY logged-in user could overwrite another host's cover, and
 * anon could upload at will (SCHEMA: "不写这条 = 任意登录用户覆盖他人封面 / anon 可传").
 * This suite hammers, with an "assume the policy is leaky" stance:
 *
 *   1. Buckets exist with the pinned server-enforced config (D16): event-covers is
 *      public-read with a ~5MB cap + an image-only mime allowlist; event-photos is
 *      PRIVATE (public=false) with the same allowlist.
 *   2. Writes are gated by RLS to `authenticated` AND `auth.uid() = events.host_id`
 *      (owns the event) AND the object path prefix = `<event_id>/`:
 *        * the owning host CAN upload into its own event prefix;
 *        * anon CANNOT upload (no policy for anon) — 禁止 anon 写;
 *        * a NON-owner host CANNOT upload into another event's prefix;
 *        * even the owner CANNOT upload outside an owned prefix (no/foreign folder)
 *          — fail-closed when the first path segment isn't an owned event id.
 *   3. Bucket-level guards are enforced server-side, not just in the UI (D16): an
 *      oversized file and a disallowed mime are both refused even for the owner.
 *   4. Reads: event-covers is publicly fetchable (public bucket); event-photos is
 *      NOT publicly readable by anon — 相册不得公开读.
 *
 * Behaviour is driven through supabase-js against the real Storage API (the actual
 * attack surface), and the policy/bucket SHAPE is cross-checked DB-authoritatively
 * via psql (catches a weakening the behavioural layer might mask — e.g. a sneaky
 * anon write policy, a permissive `using(true)`, or a public album bucket). Events
 * are seeded as the postgres superuser because, with Supabase auto-expose OFF, even
 * service_role has no PostgREST grant on public.events. Gated on a reachable local
 * stack so the file still skips (green) without Docker.
 */
const LOCAL_UP = localStackRunning();

/** Run SQL as the postgres superuser (bypasses grants/RLS). Throws on SQL error. */
function runSql(sql: string): string {
  const cfg = resolveLocalSupabase({ autoStart: false });
  if (!cfg) throw new Error("local supabase stack not reachable");
  return execFileSync("psql", [cfg.dbUrl, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Last non-empty line of psql `-At` output (a single scalar). */
function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

/** All non-empty lines of psql `-At` output (one per row). */
function lines(out: string): string[] {
  return out.trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
const TITLE_PREFIX = "t17"; // cleanup deletes every event whose title starts here

const COVERS = "event-covers";
const PHOTOS = "event-photos";
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
const COVER_SIZE_LIMIT = 5 * 1024 * 1024; // ~5MB cap on covers (D16)

describe("task 1.7: Storage buckets + RLS (SCHEMA Storage / D16; TEST-SPEC §1.3)", () => {
  const i = infra();
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];

  let eventA = ""; // owned by host A
  let eventB = ""; // owned by host B
  const uploaded: Array<{ bucket: string; path: string }> = []; // for cleanup

  beforeAll(() => {
    if (!LOCAL_UP) return;
    expect(i.dbReady, i.skipReason ?? "db not ready").toBe(true);

    const aId = hostA?.id ?? "";
    const bId = hostB?.id ?? "";
    expect(aId).not.toBe("");
    expect(bId).not.toBe("");
    expect(aId).not.toBe(bId);

    // Profiles are auto-created by the auth.users trigger; upsert defensively so
    // the file is self-contained regardless of run order.
    runSql(
      `insert into public.profiles (id, display_name) values
         ('${aId}', 'Host A t17'), ('${bId}', 'Host B t17')
       on conflict (id) do nothing;`,
    );
    eventA = scalar(
      runSql(
        `with ins as (insert into public.events (host_id, title, visibility, status)
           values ('${aId}', '${TITLE_PREFIX} Event A', 'public', 'published') returning id)
         select id from ins;`,
      ),
    );
    eventB = scalar(
      runSql(
        `with ins as (insert into public.events (host_id, title, visibility, status)
           values ('${bId}', '${TITLE_PREFIX} Event B', 'public', 'published') returning id)
         select id from ins;`,
      ),
    );
    expect(eventA).not.toBe("");
    expect(eventB).not.toBe("");
  });

  afterAll(async () => {
    if (!LOCAL_UP) return;
    // Best-effort: drop uploaded objects (service role bypasses RLS), then delete
    // seeded events (ON DELETE CASCADE clears children). Orphan blobs are harmless
    // in the test DB but we tidy anyway.
    try {
      const svc = serviceClient();
      for (const u of uploaded) await svc.storage.from(u.bucket).remove([u.path]);
    } catch {
      // ignore — test DB cleanup is best-effort
    }
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%';`);
  });

  // ── Bucket config (D16): server-enforced, not just UI ────────────────────────
  it.skipIf(!LOCAL_UP)("creates event-covers (public, ~5MB, image-only) and event-photos (private)", () => {
    const covers = scalar(
      runSql(
        `select public::text||'|'||coalesce(file_size_limit::text,'NULL')||'|'||
                coalesce(array_to_string(allowed_mime_types, ','),'NULL')
           from storage.buckets where id = '${COVERS}';`,
      ),
    );
    expect(covers).toBe(`true|${COVER_SIZE_LIMIT}|${ALLOWED_MIME.join(",")}`);

    // event-photos: PRIVATE bucket (public=false), with a size cap + mime allowlist.
    const photosPublic = scalar(runSql(`select public::text from storage.buckets where id = '${PHOTOS}';`));
    expect(photosPublic, "event-photos must be a PRIVATE bucket (相册不得公开读)").toBe("false");
    const photosLimit = scalar(runSql(`select coalesce(file_size_limit::text,'NULL') from storage.buckets where id = '${PHOTOS}';`));
    expect(photosLimit).not.toBe("NULL");
    const photosMime = scalar(runSql(`select coalesce(array_to_string(allowed_mime_types, ','),'NULL') from storage.buckets where id = '${PHOTOS}';`));
    expect(photosMime).toBe(ALLOWED_MIME.join(","));
  });

  // ── DB-authoritative policy shape (catches a weakening the API layer can mask) ─
  it.skipIf(!LOCAL_UP)("storage.objects RLS on; no using(true)/check(true); no anon/public write or read policy", () => {
    // RLS must stay enabled (RLS off + a table grant => anon could write).
    expect(
      scalar(runSql(
        `select relrowsecurity::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='storage' and c.relname='objects';`,
      )),
    ).toBe("true");

    // No catch-all `using(true)`/`with check(true)` policy (护栏 5 / G8).
    expect(
      lines(runSql(
        `select 'PERMISSIVE:'||policyname from pg_policies
           where schemaname='storage' and tablename='objects'
             and (coalesce(qual,'')='true' or coalesce(with_check,'')='true');`,
      )),
    ).toEqual([]);

    // No policy grants anon/public a WRITE (INSERT/UPDATE/DELETE/ALL) — 禁止 anon 写.
    expect(
      lines(runSql(
        `select 'ANON_WRITE:'||policyname||':'||cmd from pg_policies
           where schemaname='storage' and tablename='objects'
             and (roles && array['anon','public']::name[])
             and cmd in ('INSERT','UPDATE','DELETE','ALL');`,
      )),
    ).toEqual([]);

    // No policy grants anon/public a READ (SELECT/ALL): covers are served via the
    // public-bucket endpoint, NOT an anon RLS policy, and the album stays private.
    expect(
      lines(runSql(
        `select 'ANON_READ:'||policyname||':'||cmd from pg_policies
           where schemaname='storage' and tablename='objects'
             and (roles && array['anon','public']::name[])
             and cmd in ('SELECT','ALL');`,
      )),
    ).toEqual([]);

    // The write policies exist and are scoped to `authenticated` (I1 — never public).
    const writeRoles = lines(runSql(
      `select cmd||':'||array_to_string(roles,',') from pg_policies
         where schemaname='storage' and tablename='objects' and cmd in ('INSERT','UPDATE','DELETE')
         order by cmd;`,
    ));
    expect(writeRoles).toEqual(["DELETE:authenticated", "INSERT:authenticated", "UPDATE:authenticated"]);
  });

  // ── Writes: owner CAN, others CANNOT (host-ownership + path-prefix) ───────────
  it.skipIf(!LOCAL_UP)("owner host CAN upload a cover into its own event prefix", async () => {
    const path = `${eventA}/cover.png`;
    const res = await hostClient(hostA).storage.from(COVERS).upload(path, PNG, { contentType: "image/png" });
    expect(res.error, `owner upload should succeed: ${JSON.stringify(res.error)}`).toBeNull();
    if (!res.error) uploaded.push({ bucket: COVERS, path });
  });

  it.skipIf(!LOCAL_UP)("anon CANNOT upload to event-covers (禁止 anon 写)", async () => {
    const res = await anonClient().storage.from(COVERS).upload(`${eventA}/anon.png`, PNG, { contentType: "image/png" });
    expect(res.error, "anon storage write must be denied").not.toBeNull();
  });

  it.skipIf(!LOCAL_UP)("a NON-owner host CANNOT upload into another host's event prefix", async () => {
    // host A targeting host B's event prefix -> WITH CHECK (ownership) fails.
    const res = await hostClient(hostA).storage.from(COVERS).upload(`${eventB}/steal.png`, PNG, { contentType: "image/png" });
    expect(res.error, "non-owner storage write must be denied").not.toBeNull();
  });

  it.skipIf(!LOCAL_UP)("even the owner CANNOT upload outside an owned event prefix (fail-closed path check)", async () => {
    const c = hostClient(hostA);
    // No folder prefix at all -> first path segment is not an owned event id.
    const noPrefix = await c.storage.from(COVERS).upload(`rogue-${eventA}.png`, PNG, { contentType: "image/png" });
    expect(noPrefix.error, "upload without an event-id prefix must be denied").not.toBeNull();
    // A folder that isn't a uuid -> still no matching owned event -> denied (no error thrown).
    const junkPrefix = await c.storage.from(COVERS).upload(`not-a-uuid/x.png`, PNG, { contentType: "image/png" });
    expect(junkPrefix.error, "upload under a non-event-id folder must be denied").not.toBeNull();
  });

  // ── Bucket guards enforced server-side, even for the owner (D16) ──────────────
  it.skipIf(!LOCAL_UP)("rejects an oversized cover even from the owner (file_size_limit)", async () => {
    const tooBig = new Uint8Array(COVER_SIZE_LIMIT + 1024); // just over the 5MB cap
    const res = await hostClient(hostA).storage.from(COVERS).upload(`${eventA}/big.png`, tooBig, { contentType: "image/png" });
    expect(res.error, "over-limit upload must be rejected (size enforced server-side)").not.toBeNull();
  });

  it.skipIf(!LOCAL_UP)("rejects a disallowed mime even from the owner (allowed_mime_types)", async () => {
    const res = await hostClient(hostA).storage.from(COVERS).upload(`${eventA}/note.txt`, new Uint8Array([1, 2, 3]), {
      contentType: "text/plain",
    });
    expect(res.error, "disallowed mime must be rejected (mime enforced server-side)").not.toBeNull();
  });

  // ── Reads: cover public; album private (相册不得公开读) ────────────────────────
  it.skipIf(!LOCAL_UP)("event-covers is publicly readable; event-photos is NOT", async () => {
    // Cover uploaded above by the owner -> fetchable via the public bucket URL.
    const coverPath = `${eventA}/cover.png`;
    const { data: pub } = anonClient().storage.from(COVERS).getPublicUrl(coverPath);
    const coverRes = await fetch(pub.publicUrl);
    expect(coverRes.ok, "public cover must be readable via the public URL").toBe(true);

    // Put an object in the PRIVATE album bucket (owner write allowed on both buckets).
    const albumPath = `${eventA}/album.png`;
    const up = await hostClient(hostA).storage.from(PHOTOS).upload(albumPath, PNG, { contentType: "image/png" });
    expect(up.error, `owner album upload should succeed: ${JSON.stringify(up.error)}`).toBeNull();
    if (!up.error) uploaded.push({ bucket: PHOTOS, path: albumPath });

    // anon must NOT be able to download a private-album object.
    const anonDl = await anonClient().storage.from(PHOTOS).download(albumPath);
    expect(anonDl.error, "event-photos must not be anon-downloadable").not.toBeNull();

    // ...and the public-URL endpoint must not serve a private bucket either.
    const { data: photoPub } = anonClient().storage.from(PHOTOS).getPublicUrl(albumPath);
    const photoRes = await fetch(photoPub.publicUrl);
    expect(photoRes.ok, "private album must not be served over the public URL").toBe(false);
  });
});
