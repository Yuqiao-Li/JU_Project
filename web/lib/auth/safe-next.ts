/**
 * Sanitize a post-auth redirect target. Only same-origin absolute paths are
 * allowed — never a protocol-relative (`//evil`) or absolute URL — so the
 * `?next=` param can't become an open redirect after sign-in.
 */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  // Must be a root-relative path and not protocol-relative ("//host").
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}
