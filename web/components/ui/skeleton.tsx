/**
 * Skeleton — a quiet placeholder block for `loading.tsx` route fallbacks (task 6.3).
 *
 * Most "loading" in this app is the brief server render of a page segment streaming in.
 * A skeleton that mirrors the silhouette of what's arriving makes a navigation read as
 * "responding," not "stuck." The pulse rides Tailwind's `animate-pulse`, which the global
 * reduced-motion rule (globals.css) collapses to still — so the quality floor is honored
 * for free. Purely decorative, so it's hidden from assistive tech; the surrounding
 * `loading.tsx` carries the `role="status"` announcement.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-surface-2 ${className}`} />;
}
