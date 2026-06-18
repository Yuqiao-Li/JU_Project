"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

/** Cooldown (seconds) before a magic link can be re-sent. */
const RESEND_COOLDOWN_SECONDS = 45;

/**
 * How often (ms) the "sent" state polls for a session. The browser client stores
 * auth in COOKIES (@supabase/ssr), so a sign-in completed in the link-opened tab
 * does NOT fire `onAuthStateChange` here — polling is the reliable cross-tab signal.
 */
const SESSION_POLL_MS = 2500;

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
  // 6-digit verification code path (an alternative to clicking the link).
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  // Guard so the cross-tab redirect fires exactly once.
  const redirectedRef = useRef(false);

  // Full navigation so the server picks up the freshly-set auth cookies.
  const goToNext = useCallback(() => {
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    window.location.assign(next);
  }, [next]);

  // Tick the cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  // While the "sent" state is shown, detect a sign-in that completed in ANOTHER
  // tab (the magic link opens a new tab) and redirect this original tab to `next`.
  // Cookies don't fire onAuthStateChange cross-tab, so we poll getSession; we also
  // keep a SIGNED_IN listener for the same-tab OTP path (FIX #2).
  useEffect(() => {
    if (status.kind !== "sent") return;
    const supabase = createClient();
    let active = true;

    const checkSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (active && session) goToNext();
    };

    // Check immediately, then on an interval.
    void checkSession();
    const timer = setInterval(checkSession, SESSION_POLL_MS);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) goToNext();
    });

    return () => {
      active = false;
      clearInterval(timer);
      sub.subscription.unsubscribe();
    };
  }, [status.kind, goToNext]);

  // Email magic links carry `flow=email` so the callback can send them to the
  // "you're signed in" interstitial; Google OAuth (same-tab) omits it and lands
  // straight on `next`.
  function callbackUrl(flow?: "email"): string {
    const params = new URLSearchParams({ next });
    if (flow) params.set("flow", flow);
    return `${siteOrigin()}/auth/callback?${params.toString()}`;
  }

  // Shared OTP send used by the initial submit and the resend button. The link
  // it emails carries `flow=email` so the callback routes it to the interstitial.
  const sendOtp = useCallback(async (): Promise<{ error: string | null }> => {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl("email") },
    });
    return { error: error?.message ?? null };
    // callbackUrl reads `next` (stable prop) + `email`; email is the only dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, next]);

  // Finish sign-in WITHOUT leaving this tab by entering the 6-digit code from
  // the email. signInWithOtp emails both a link and this token (FIX #2/#3).
  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (verifying) return;
    setVerifying(true);
    setOtpError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: "email",
    });
    if (error) {
      setVerifying(false);
      setOtpError(t("otpError"));
      return;
    }
    // Session is now set in THIS tab — go straight to the dashboard.
    goToNext();
  }

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

        {/* Or finish without leaving this tab: type the 6-digit code. */}
        <form onSubmit={verifyCode} className="mt-5 flex flex-col gap-3 text-left">
          <label htmlFor="otp" className="eyebrow text-center">
            {t("otpLabel")}
          </label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder={t("otpPlaceholder")}
            className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-center text-lg tracking-[0.4em] text-paper placeholder:tracking-normal placeholder:text-muted/60 focus:border-iris focus:outline-none"
          />
          <button
            type="submit"
            disabled={verifying || code.trim().length < 6}
            className="h-11 rounded-xl bg-coral px-5 font-semibold text-ink transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {verifying ? t("verifying") : t("verifyCode")}
          </button>
          {otpError && (
            <p role="alert" className="text-center text-sm text-coral">
              {otpError}
            </p>
          )}
        </form>

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
              setCode("");
              setOtpError(null);
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
