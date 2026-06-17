import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cover image upload helper (task 2.2b).
 *
 * The cover lives in the PUBLIC `event-covers` bucket and is uploaded client-side
 * by the host's authenticated browser session. The security boundary is the
 * storage RLS from task 1.7: a write is allowed only when the object path's first
 * segment is an event the caller owns (`auth.uid() = events.host_id`). So this
 * helper's one job is to build a path that begins with `<event_id>/` and hand the
 * bytes to the Storage API — RLS does the rest. The bucket also enforces the mime
 * allowlist + size cap server-side; `validateCoverFile` only mirrors those for a
 * fast, friendly client-side rejection (never the real guard, D16).
 */

export const COVERS_BUCKET = "event-covers";

/** Server-enforced bucket limits (kept in sync with migration 0013). */
export const COVER_MAX_BYTES = 5 * 1024 * 1024; // ~5MB
export const COVER_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export type CoverUploadResult =
  | { ok: true; url: string; path: string }
  | { ok: false; message: string };

/**
 * Build the storage object path: `<event_id>/<random>.<ext>`.
 *
 * The `<event_id>/` prefix is exactly what storage RLS keys on
 * (`storage.foldername(name)[1]`), and the random object id prevents enumeration
 * (D16). The extension is derived from the mime type, never an attacker-supplied
 * filename.
 */
export function coverObjectPath(eventId: string, mime: string, randomId: string): string {
  const ext = EXT_BY_MIME[mime] ?? "bin";
  return `${eventId}/${randomId}.${ext}`;
}

/** Client-side mirror of the bucket guards. Returns an error message, or null if OK. */
export function validateCoverFile(file: { type: string; size: number }): string | null {
  if (!(COVER_MIME as readonly string[]).includes(file.type)) {
    return "Use a PNG, JPG, or WebP image.";
  }
  if (file.size > COVER_MAX_BYTES) {
    return "Keep the cover under 5MB.";
  }
  return null;
}

/**
 * Upload a cover to `event-covers/<event_id>/…` and return its public URL.
 *
 * `supabase` must be the host's authenticated client so storage RLS sees their
 * `auth.uid()`; a non-owner (or anon) is denied by the bucket policy and this
 * returns `{ ok: false }` rather than throwing.
 */
export async function uploadEventCover(
  supabase: SupabaseClient,
  eventId: string,
  file: File,
): Promise<CoverUploadResult> {
  const invalid = validateCoverFile(file);
  if (invalid) return { ok: false, message: invalid };

  const path = coverObjectPath(eventId, file.type, crypto.randomUUID());
  const { error } = await supabase.storage.from(COVERS_BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) {
    return { ok: false, message: "Couldn't upload that image. Try again." };
  }

  const { data } = supabase.storage.from(COVERS_BUCKET).getPublicUrl(path);
  return { ok: true, url: data.publicUrl, path };
}
