"use client";

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
  const [state, formAction, pending] = useActionState(updateProfile, INITIAL);
  const [username, setUsername] = useState(initialUsername);
  // Set only from the async availability fetch, keyed to the input it answered.
  const [remote, setRemote] = useState<Remote>(null);

  const trimmed = username.trim();
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
    hint = { kind: "default", text: "Lowercase letters, numbers, hyphens, underscores." };
  } else if (!local.ok) {
    hint = { kind: "invalid", text: local.error };
  } else if (remote && remote.for === trimmed) {
    hint =
      remote.kind === "available"
        ? { kind: "available", text: "Looks open — claim it." }
        : remote.kind === "taken"
          ? { kind: "taken", text: "That one's taken." }
          : { kind: "unknown", text: "We'll confirm when you save." };
  } else {
    hint = { kind: "checking", text: "Checking availability…" };
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
          Name
        </label>
        <input
          id="display_name"
          name="display_name"
          type="text"
          required
          defaultValue={initialDisplayName}
          maxLength={80}
          placeholder="Rain"
          className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="username" className="eyebrow">
          Username
        </label>
        <div className="flex items-center rounded-xl border border-line bg-surface-2 focus-within:border-iris">
          <span className="pl-4 font-mono text-sm text-muted">/u/</span>
          <input
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={30}
            placeholder="rain"
            className="h-12 flex-1 bg-transparent pl-1 pr-4 text-paper placeholder:text-muted/60 focus:outline-none"
          />
        </div>
        <p className={`text-xs ${hintColor}`}>{hint.text}</p>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-12 rounded-xl bg-coral px-6 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save profile"}
        </button>
        {state.status === "success" && (
          <span role="status" className="text-sm text-iris">
            {state.message}
          </span>
        )}
        {state.status === "error" && (
          <span role="alert" className="text-sm text-coral">
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
