"use client";

import { useState } from "react";

/**
 * Copy the event's public link (task 2.3).
 *
 * The host shares `/{slug}` — the slug is the public credential; the guest_token
 * never rides in a URL (SCHEMA §URL boundary). We render the relative path for
 * SSR stability and resolve the absolute origin only at click time on the client,
 * so the markup is identical on server and client.
 */
export function CopyLinkButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard can be blocked (insecure context / permissions). Fall back to a
      // prompt so the host can still grab the link.
      window.prompt("Copy this link", url);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-ink/40 px-3 py-2 font-mono text-sm text-iris">
        /{slug}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-live="polite"
        className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-line px-4 text-sm font-semibold text-paper transition hover:bg-surface-2"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
