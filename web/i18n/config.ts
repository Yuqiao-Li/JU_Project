/**
 * i18n configuration (next-intl, no URL routing).
 * The active locale is carried in the `NEXT_LOCALE` cookie; default is Chinese
 * (the product's audience). A language switcher sets the cookie; routes are not
 * prefixed, so the whole existing route tree stays where it is.
 */
export const locales = ["zh", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "zh";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined | null): value is Locale {
  return value != null && (locales as readonly string[]).includes(value);
}
