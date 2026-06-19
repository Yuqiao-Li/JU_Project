"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";

import { validateUsername } from "@/lib/profile/username";

import { type ProfileFormState, updateProfile } from "./actions";

const INITIAL: ProfileFormState = { status: "idle" };

type HintKind = "default" | "invalid" | "checking" | "available" | "taken" | "unknown";
type Remote = { for: string; kind: "available" | "taken" | "unknown" } | null;

/**
 * Profile settings form. The username field shows an *advisory* availability
 * hint as you type — but the DB unique index is the real authority, so the save
 * still surfaces a taken-username error if a race loses (TASKS 2.1).
 */
export function ProfileForm({
  initialDisplayName,
  initialUsername,
}: {
  initialDisplayName: string;
  initialUsername: string;
}) {
  const t = useTranslations("settings");
  const [state, formAction, pending] = useActionState(updateProfile, INITIAL);
  const [username, setUsername] = useState(initialUsername);
  // Set only from the async availability fetch, keyed to the input it answered.
  const [remote, setRemote] = useState<Remote>(null);
  // Becomes true once the host confirms removing their public profile.
  const [confirmedClear, setConfirmedClear] = useState(false);

  const trimmed = username.trim();
  const hadUsername = initialUsername.trim() !== "";
  // Clearing a previously-set username deletes the public /u/<handle>. We guard
  // that as a deliberate, confirmed action — not a silent empty-field write (H19).
  const clearingUsername = hadUsername && trimmed === "";
  const unchanged = trimmed === "" || trimmed.toLowerCase() === initialUsername.trim().toLowerCase();
  const local = validateUsername(trimmed);

  // Debounced advisory check. State is set only inside the async callback (never
  // synchronously in the effect body), so it can't cascade renders.
  useEffect(() => {
    if (unchanged || !local.ok) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/username-check?u=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        const data: { available: boolean | null } = await res.json();
        const kind = data.available === true ? "available" : data.available === false ? "taken" : "unknown";
        setRemote({ for: trimmed, kind });
      } catch {
        // Aborted or network hiccup — the save remains the source of truth.
        setRemote({ for: trimmed, kind: "unknown" });
      }
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // local.ok is derived from `trimmed`; `trimmed`/`unchanged` cover the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, unchanged]);

  // Derive the hint during render — no synchronous setState involved.
  let hint: { kind: HintKind; text: string };
  if (unchanged) {
    hint = { kind: "default", text: t("usernameHintDefault") };
  } else if (!local.ok) {
    hint = { kind: "invalid", text: local.error };
  } else if (remote && remote.for === trimmed) {
    hint =
      remote.kind === "available"
        ? { kind: "available", text: t("usernameAvailable") }
        : remote.kind === "taken"
          ? { kind: "taken", text: t("usernameTaken") }
          : { kind: "unknown", text: t("usernameUnknown") };
  } else {
    hint = { kind: "checking", text: t("usernameChecking") };
  }

  const hintColor =
    hint.kind === "available"
      ? "text-iris"
      : hint.kind === "invalid" || hint.kind === "taken"
        ? "text-coral"
        : "text-muted";

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="display_name" className="eyebrow">
          {t("nameLabel")}
        </label>
        <input
          id="display_name"
          name="display_name"
          type="text"
          required
          defaultValue={initialDisplayName}
          maxLength={80}
          placeholder={t("namePlaceholder")}
          className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="username" className="eyebrow">
          {t("usernameLabel")}
        </label>
        <div className="flex items-center rounded-xl border border-line bg-surface-2 focus-within:border-iris">
          <span className="pl-4 font-mono text-sm text-muted">/u/</span>
          <input
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              // Re-arm the guard whenever the field changes.
              setConfirmedClear(false);
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={30}
            placeholder={t("usernamePlaceholder")}
            className="h-12 flex-1 bg-transparent pl-1 pr-4 text-paper placeholder:text-muted/60 focus:outline-none focus-ring-off"
          />
        </div>
        <p className={`text-xs ${hintColor}`}>{hint.text}</p>
      </div>

      {clearingUsername && (
        <div className="flex flex-col gap-3 rounded-xl border border-coral/40 bg-coral/10 p-4">
          <p className="text-sm text-paper">
            {t.rich("usernameClearWarning", {
              handle: () => (
                <span className="font-mono text-paper">/u/{initialUsername.trim()}</span>
              ),
            })}
          </p>
          <label className="flex items-start gap-2 text-sm text-paper">
            <input
              type="checkbox"
              checked={confirmedClear}
              onChange={(e) => setConfirmedClear(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-coral"
            />
            <span>{t("usernameClearConfirm")}</span>
          </label>
        </div>
      )}

      {/* Sent only when the host has explicitly confirmed the clear; the server
          re-checks this before writing username=null (H19, defence in depth). */}
      <input type="hidden" name="confirm_clear" value={clearingUsername && confirmedClear ? "true" : "false"} />

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending || (clearingUsername && !confirmedClear)}
          className="h-12 rounded-xl bg-coral px-6 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
        >
          {pending ? t("saving") : t("save")}
        </button>
        {state.status === "success" && (
          <span role="status" className="text-sm text-iris">
            {state.message}
          </span>
        )}
        {state.status === "error" && (
          <span role="alert" className="text-sm text-coral">
            {state.message === "USERNAME_CLEAR_UNCONFIRMED" ? t("usernameClearBlocked") : state.message}
          </span>
        )}
      </div>
    </form>
  );
}
