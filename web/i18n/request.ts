import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "./config";

/**
 * Resolves the request locale from the NEXT_LOCALE cookie (default: zh) and
 * loads the matching message catalog. Consumed by the next-intl plugin wired in
 * next.config.ts.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(requested) ? requested : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
