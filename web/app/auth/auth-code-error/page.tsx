import Link from "next/link";

import { Wordmark } from "@/components/brand/wordmark";

export default function AuthCodeErrorPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm text-center">
        <Wordmark href="/" />
        <h1 className="mt-8 font-display text-xl font-bold text-paper">That link didn&apos;t work</h1>
        <p className="mt-2 text-sm text-muted">
          Sign-in links expire and can only be used once. Ask for a fresh one and you&apos;ll be
          right in.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
