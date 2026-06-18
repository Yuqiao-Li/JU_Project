/**
 * Inline script helper (Round-2 §7.4 hydration contract).
 *
 * Per the Next.js "preventing flash before hydration" guide: a `<script>` rendered
 * `type="text/javascript"` on the SERVER (so it RUNS during HTML parsing, before paint,
 * to correct the DOM on a hard navigation) and `type="text/plain"` on the CLIENT (so it
 * is INERT on a soft `<Link>` nav, where the client render already produced the local
 * value). `suppressHydrationWarning` covers the intentional type mismatch and stops React
 * from warning about a script tag in the render output.
 *
 * No `"use client"`: this renders in both trees; the `typeof window` check is what
 * distinguishes them.
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
