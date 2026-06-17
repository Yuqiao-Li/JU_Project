"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Wordmark } from "@/components/brand/wordmark";

/**
 * Root error boundary (task 6.3) — the fallback for an uncaught render error anywhere in
 * the route tree below the root layout. Error boundaries must be Client Components.
 *
 * `unstable_retry` (Next 16.2) re-fetches and re-renders the failed segment in place. Most
 * read paths here are transient (a poll hiccup, a cold database), so "Try again" is the
 * honest first move; a "Go home" escape hatch covers the rest. Direction over apology
 * (frontend-design): say what happened plainly, offer the recovery, no mood. We log the
 * error for the host; the message stays generic so a server error never leaks details to
 * the page (Next already scrubs server errors in production).
 */
export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-20">
      <div className="w-full max-w-md text-center">
        <Wordmark href="/" className="text-2xl" />
        <h1 className="mt-10 text-balance font-display text-3xl font-extrabold leading-tight text-paper">
          Something went sideways.
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-balance text-muted">
          That didn&rsquo;t load. It&rsquo;s usually a blip — try again, and if it keeps happening,
          come back in a bit.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="inline-flex h-12 items-center justify-center rounded-xl bg-coral px-7 font-semibold text-ink transition hover:brightness-105"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex h-12 items-center justify-center rounded-xl border border-line px-6 font-semibold text-paper transition hover:bg-surface-2"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
