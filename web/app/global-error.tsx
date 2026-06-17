"use client";

import { useEffect } from "react";

import "./globals.css";

/**
 * Global error boundary (task 6.3) — catches an error thrown by the ROOT layout itself,
 * which `app/error.tsx` cannot (an error boundary never wraps its own segment's layout).
 * It replaces the root layout when active, so it must render its own `<html>`/`<body>`
 * and pull in the global stylesheet for the brand tokens. The display font isn't loaded
 * here (next/font lives in the replaced layout), so type falls back to the system stack —
 * acceptable for a last-resort screen. Same posture as the route boundary: log it, offer
 * a retry, keep the copy generic.
 */
export default function GlobalError({
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
    <html lang="en">
      <body className="min-h-screen bg-ink text-paper antialiased">
        <main className="flex min-h-screen items-center justify-center px-5 py-20">
          <div className="w-full max-w-md text-center">
            <p className="font-display text-2xl font-extrabold tracking-tight text-paper">
              partiful<span className="text-coral">*</span>
            </p>
            <h1 className="mt-10 font-display text-3xl font-extrabold text-paper">
              Something went sideways.
            </h1>
            <p className="mx-auto mt-4 max-w-sm text-muted">
              The app hit an unexpected error. Try again — that usually clears it.
            </p>
            <div className="mt-8 flex items-center justify-center">
              <button
                type="button"
                onClick={() => unstable_retry()}
                className="inline-flex h-12 items-center justify-center rounded-xl bg-coral px-7 font-semibold text-ink transition hover:brightness-105"
              >
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
