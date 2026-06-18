"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export type GuestContact = { name: string; contact: string };

/**
 * Copy all guest contacts to the clipboard (audit H11 — let the host reach guests).
 * Contacts are host-only data already on the page; this just formats "name, contact"
 * lines for pasting into a group chat / mail. Hidden when no one left a contact.
 */
export function CopyContactsButton({ contacts }: { contacts: GuestContact[] }) {
  const t = useTranslations("hostEvent");
  const [copied, setCopied] = useState(false);

  if (contacts.length === 0) return null;

  async function copy() {
    const text = contacts.map((c) => `${c.name}, ${c.contact}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions): fall back to a prompt.
      window.prompt(t("copyContacts"), text);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex h-9 items-center justify-center rounded-lg border border-line px-3 text-sm font-medium text-paper transition hover:bg-surface-2"
    >
      {copied ? t("copyContactsCopied") : t("copyContacts", { count: contacts.length })}
    </button>
  );
}
