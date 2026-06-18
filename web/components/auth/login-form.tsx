"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/** Cooldown (seconds) before a magic link can be re-sent. */
const RESEND_COOLDOWN_SECONDS = 45;

/**
 * Resolve the origin used to build the auth callback URL. In production behind a
 * proxy / custom domain, `window.location.origin` can be an off-allowlist origin
 * that Supabase silently rejects, so prefer the explicit NEXT_PUBLIC_SITE_URL and
 * only fall back to the live origin for local dev (M49).
 */
function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return window.location.origin;
}

/**
 * Host sign-in: magic link (primary) + Google (one tap). Hosts only — guests
 * never sign in (they RSVP from the invite link). The callback URL carries the
 * sanitized `next` so people land where they were headed.
 */
export function LoginForm({ next }: { next: string }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Seconds remaining on the resend cooldown; 0 means a resend is allowed.
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);

  // Tick the cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  function callbackUrl(): string {
    const params = new URLSearchParams({ next });
    return `${siteOrigin()}/auth/callback?${params.toString()}`;
  }

  // Shared OTP send used by the initial submit and the resend button.
  const sendOtp = useCallback(async (): Promise<{ error: string | null }> => {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl() },
    });
    return { error: error?.message ?? null };
    // callbackUrl reads `next` (stable prop) + `email`; email is the only dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, next]);

  async function sendMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "sending" });
    const { error } = await sendOtp();
    if (error) {
      setStatus({ kind: "error", message: error });
    } else {
      setStatus({ kind: "sent" });
      setCooldown(RESEND_COOLDOWN_SECONDS);
    }
  }

  async function resendMagicLink() {
    if (cooldown > 0 || resending) return;
    setResending(true);
    const { error } = await sendOtp();
    setResending(false);
    if (error) {
      setStatus({ kind: "error", message: error });
    } else {
      setCooldown(RESEND_COOLDOWN_SECONDS);
    }
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
    const resendDisabled = cooldown > 0 || resending;
    return (
      <div className="rounded-2xl border border-line bg-surface/70 p-6 text-center">
        <p className="font-display text-lg font-bold text-paper">{t("checkEmailTitle")}</p>
        <p className="mt-2 text-sm text-muted">
          {t.rich("checkEmailBody", {
            email,
            highlight: (chunks) => <span className="text-paper">{chunks}</span>,
          })}
        </p>
        <p className="mt-3 text-sm text-muted">{t("spamHint")}</p>
        <div className="mt-5 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={resendMagicLink}
            disabled={resendDisabled}
            aria-live="polite"
            className="h-11 w-full rounded-xl border border-line bg-surface px-5 font-medium text-paper transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resending ? t("resending") : cooldown > 0 ? t("resendIn", { seconds: cooldown }) : t("resend")}
          </button>
          <button
            type="button"
            onClick={() => {
              setStatus({ kind: "idle" });
              setCooldown(0);
            }}
            className="text-sm font-medium text-iris underline-offset-4 hover:underline"
          >
            {t("useDifferentEmail")}
          </button>
        </div>
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
