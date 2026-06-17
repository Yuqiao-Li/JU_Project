"use client";

import { useRef, useState } from "react";

import { COVER_MAX_BYTES, uploadEventCover, validateCoverFile } from "@/lib/events/cover";
import { createClient } from "@/lib/supabase/client";

/**
 * Cover image field for the create/edit event form (task 2.2b).
 *
 * The cover uploads to the `event-covers` bucket via the host's authenticated
 * browser session — storage RLS (task 1.7) is the real guard: a write only lands
 * when the path's first segment is an event the host owns. That path needs the
 * event id, which exists only once the event row does, so uploading is offered in
 * edit mode; on create the host saves first (create redirects straight to edit).
 *
 * The resolved public URL rides along in a hidden input so it persists with the
 * rest of the form through the existing server action. The preview is a CSS
 * background (no next/image remote config needed, no layout shift).
 */
export function CoverUploader({ eventId, initialUrl }: { eventId: string | null; initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !eventId) return;
    setError(null);

    const invalid = validateCoverFile(file);
    if (invalid) {
      setError(invalid);
      e.target.value = "";
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const res = await uploadEventCover(supabase, eventId, file);
    setBusy(false);
    e.target.value = ""; // allow re-picking the same file after an error
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setUrl(res.url);
  }

  function remove() {
    setUrl("");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Persists with the form; the only thing the server action reads. */}
      <input type="hidden" name="cover_image_url" value={url} />

      <div
        className="relative flex aspect-[16/9] w-full items-end overflow-hidden rounded-2xl border border-line bg-surface-2 bg-cover bg-center"
        style={url ? { backgroundImage: `url(${JSON.stringify(url)})` } : undefined}
      >
        {!url && (
          <div className="flex w-full flex-col items-center justify-center gap-1 self-center px-4 text-center">
            <p className="text-sm text-muted">
              {eventId ? "Add a cover image" : "Save the event first, then add a cover"}
            </p>
            <p className="text-xs text-muted/60">PNG, JPG, or WebP · up to {Math.round(COVER_MAX_BYTES / 1024 / 1024)}MB</p>
          </div>
        )}
        {url && (
          <span className="m-3 rounded-full bg-ink/70 px-3 py-1 text-xs text-paper backdrop-blur">Cover set</span>
        )}
      </div>

      {eventId && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={onPick}
            disabled={busy}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="h-10 rounded-xl border border-line px-4 text-sm font-medium text-paper transition hover:bg-surface-2 disabled:opacity-60"
          >
            {busy ? "Uploading…" : url ? "Replace cover" : "Upload cover"}
          </button>
          {url && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="h-10 rounded-xl px-3 text-sm text-muted transition hover:text-paper disabled:opacity-60"
            >
              Remove
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-coral">
          {error}
        </p>
      )}
    </div>
  );
}
