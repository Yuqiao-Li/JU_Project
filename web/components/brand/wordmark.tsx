import Link from "next/link";

/**
 * The product wordmark. The trailing asterisk is the one small brand flourish —
 * a confetti spark in coral. Used on the front door and the dashboard header.
 */
export function Wordmark({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-baseline font-display text-2xl font-extrabold tracking-tight text-paper ${className}`}
    >
      JU
      <span aria-hidden className="ml-0.5 text-coral">
        *
      </span>
    </Link>
  );
}
