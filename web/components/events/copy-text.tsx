"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * Copy a short string (e.g. a WeChat id) to the clipboard with a brief "copied" state
 * (round-4). Mirrors the copy-link affordance: tries the clipboard API and falls back
 * to a prompt when it's blocked (insecure context / permissions). Labels come from the
 * `eventPage` namespace.
 */
export function CopyText({ value }: { value: string }) {
  const t = useTranslations("eventPage");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt(t("copyButton"), value);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-line px-3 text-sm font-semibold text-paper transition hover:bg-surface-2"
    >
      {copied ? t("copiedButton") : t("copyButton")}
    </button>
  );
}
