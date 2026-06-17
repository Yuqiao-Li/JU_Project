import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COVER_MAX_BYTES,
  COVER_MIME,
  coverObjectPath,
  uploadEventCover,
  validateCoverFile,
} from "../lib/events/cover";
import { hostClient, infra, serviceClient } from "./helpers/clients";
import { localStackRunning, resolveLocalSupabase } from "./setup/local-supabase";

/**
 * Task 2.2b — cover upload helper (unit + Storage authorization integration).
 *
 * The cover lives in the `event-covers` bucket and is written client-side by the
 * host's authenticated browser session, so the WHOLE security story is the
 * storage RLS from task 1.7: a write is allowed only when the object path's first
 * segment is an event the caller owns (`<event_id>/…`, `auth.uid()=host_id`). This
 * helper is what the form calls, so it must build exactly that path and route
 * through that gate.
 *
 *   1. Pure unit: `coverObjectPath` always prefixes `<event_id>/` (the exact thing
 *      the RLS keys on) with a random object id (anti-enumeration, D16) and a mime-
 *      derived extension; `validateCoverFile` mirrors the bucket's server-enforced
 *      mime allowlist + ~5MB cap so the UI fails fast without weakening the DB.
 *   2. Integration (Storage 授权断言, gated on a local stack): the OWNING host can
 *      upload through the helper and the public URL round-trips into events
 *      .cover_image_url via the host's own RLS path; a NON-owner host is DENIED
 *      uploading into another event's prefix (helper returns ok:false, never throws).
 */
const LOCAL_UP = localStackRunning();
const i = infra();
const dbReady = LOCAL_UP && i.dbReady;

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

function scalar(out: string): string {
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
const TITLE_PREFIX = "t22b"; // cleanup deletes every event whose title starts here
const COVERS = "event-covers";

describe("task 2.2b: cover object path + file validation (unit)", () => {
  it("prefixes the object path with <event_id>/ so storage RLS matches (D16)", () => {
    const eventId = "11111111-2222-3333-4444-555555555555";
    const path = coverObjectPath(eventId, "image/png", "abc123");
    expect(path.startsWith(`${eventId}/`)).toBe(true);
    // first path segment (what storage.foldername(name)[1] returns) is the event id
    expect(path.split("/")[0]).toBe(eventId);
    expect(path).toBe(`${eventId}/abc123.png`);
  });

  it("derives the extension from the mime type, not an attacker-controlled filename", () => {
    const id = "ev";
    expect(coverObjectPath(id, "image/jpeg", "r")).toBe("ev/r.jpg");
    expect(coverObjectPath(id, "image/webp", "r")).toBe("ev/r.webp");
    expect(coverObjectPath(id, "image/png", "r")).toBe("ev/r.png");
  });

  it("uses a random object id so covers can't be enumerated", () => {
    const id = "ev";
    expect(coverObjectPath(id, "image/png", "AAA")).not.toBe(coverObjectPath(id, "image/png", "BBB"));
  });

  it("validateCoverFile mirrors the bucket allowlist + size cap (server still enforces)", () => {
    for (const type of COVER_MIME) {
      expect(validateCoverFile({ type, size: 1024 })).toBeNull();
    }
    expect(validateCoverFile({ type: "text/plain", size: 1024 })).not.toBeNull();
    expect(validateCoverFile({ type: "image/gif", size: 1024 })).not.toBeNull();
    expect(validateCoverFile({ type: "image/png", size: COVER_MAX_BYTES + 1 })).not.toBeNull();
    expect(validateCoverFile({ type: "image/png", size: COVER_MAX_BYTES })).toBeNull();
  });
});

describe("task 2.2b: cover upload goes through storage RLS (integration)", () => {
  const hostA = i.hosts[0];
  const hostB = i.hosts[1];
  let eventA = ""; // owned by host A
  let eventB = ""; // owned by host B
  const uploaded: Array<{ bucket: string; path: string }> = [];

  beforeAll(() => {
    if (!dbReady) return;
    const aId = hostA?.id ?? "";
    const bId = hostB?.id ?? "";
    expect(aId).not.toBe("");
    expect(bId).not.toBe("");
    runSql(
      `insert into public.profiles (id, display_name) values
         ('${aId}', 'Host A t22b'), ('${bId}', 'Host B t22b')
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
    if (!dbReady) return;
    try {
      const svc = serviceClient();
      for (const u of uploaded) await svc.storage.from(u.bucket).remove([u.path]);
    } catch {
      // best-effort cleanup
    }
    runSql(`delete from public.events where title like '${TITLE_PREFIX}%';`);
  });

  it.skipIf(!dbReady)("owner host uploads via the helper and the URL round-trips into cover_image_url", async () => {
    const a = hostClient(hostA);
    const blob = new Blob([PNG], { type: "image/png" });
    const file = new File([blob], "cover.png", { type: "image/png" });

    const res = await uploadEventCover(a, eventA, file);
    expect(res.ok, `owner upload should succeed: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) return;
    expect(res.path.startsWith(`${eventA}/`)).toBe(true);
    expect(typeof res.url).toBe("string");
    uploaded.push({ bucket: COVERS, path: res.path });

    // Persist the URL through the host's OWN RLS path (host_id = auth.uid()).
    const { error: upErr } = await a.from("events").update({ cover_image_url: res.url }).eq("id", eventA);
    expect(upErr).toBeNull();
    expect(scalar(runSql(`select cover_image_url from public.events where id = '${eventA}';`))).toBe(res.url);
  });

  it.skipIf(!dbReady)("a non-owner host is denied uploading into another event's prefix (ok:false, no throw)", async () => {
    const a = hostClient(hostA);
    const blob = new Blob([PNG], { type: "image/png" });
    const file = new File([blob], "steal.png", { type: "image/png" });
    // Host A aims at host B's event prefix -> storage RLS WITH CHECK fails.
    const res = await uploadEventCover(a, eventB, file);
    expect(res.ok, "non-owner upload must be denied").toBe(false);
  });
});
