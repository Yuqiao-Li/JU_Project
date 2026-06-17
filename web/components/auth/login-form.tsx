"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/**
 * Host sign-in: magic link (primary) + Google (one tap). Hosts only — guests
 * never sign in (they RSVP from the invite link). The callback URL carries the
 * sanitized `next` so people land where they were headed.
 */
export function LoginForm({ next }: { next: string }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function callbackUrl(): string {
    const params = new URLSearchParams({ next });
    return `${window.location.origin}/auth/callback?${params.toString()}`;
  }

  async function sendMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "sending" });
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl() },
    });
    setStatus(error ? { kind: "error", message: error.message } : { kind: "sent" });
  }

  async function continueWithGoogle() {
    setStatus({ kind: "sending" });
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callbackUrl() },
    });
    // On success the browser is redirected away; only an error returns here.
    if (error) setStatus({ kind: "error", message: error.message });
  }

  if (status.kind === "sent") {
    return (
      <div className="rounded-2xl border border-line bg-surface/70 p-6 text-center">
        <p className="font-display text-lg font-bold text-paper">{t("checkEmailTitle")}</p>
        <p className="mt-2 text-sm text-muted">
          {t.rich("checkEmailBody", {
            email,
            highlight: (chunks) => <span className="text-paper">{chunks}</span>,
          })}
        </p>
        <button
          type="button"
          onClick={() => setStatus({ kind: "idle" })}
          className="mt-4 text-sm font-medium text-iris underline-offset-4 hover:underline"
        >
          {t("useDifferentEmail")}
        </button>
      </div>
    );
  }

  const busy = status.kind === "sending";

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={sendMagicLink} className="flex flex-col gap-3">
        <label htmlFor="email" className="eyebrow">
          {t("emailLabel")}
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="h-12 rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
        >
          {busy ? t("sending") : t("sendMagicLink")}
        </button>
      </form>

      <div className="flex items-center gap-3 text-muted">
        <span className="h-px flex-1 bg-line" />
        <span className="eyebrow">{t("or")}</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <button
        type="button"
        onClick={continueWithGoogle}
        disabled={busy}
        className="flex h-12 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-5 font-medium text-paper transition hover:bg-surface-2 disabled:opacity-60"
      >
        {t("continueWithGoogle")}
      </button>

      {status.kind === "error" && (
        <p role="alert" className="text-sm text-coral">
          {status.message}
        </p>
      )}
    </div>
  );
}
