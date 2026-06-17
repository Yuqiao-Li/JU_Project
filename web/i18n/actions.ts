"use server";

import { cookies } from "next/headers";

import { isLocale, LOCALE_COOKIE, type Locale } from "./config";

/**
 * Persists the chosen locale in the NEXT_LOCALE cookie (no URL routing). Called
 * from the LocaleSwitcher; the client refreshes afterward so server components
 * re-render in the new locale.
 */
export async function setLocale(locale: Locale) {
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
