import { parseEffect } from "@/lib/events/theme";

/**
 * Decorative celebration overlay (Round-2 §7.2 FIX 1) — finally RENDERS the
 * host-selected `events.effect` (confetti | glow | balloons), which was stored
 * and form-selectable but never drawn until now.
 *
 * Purely presentational: no hooks, no client APIs, no data fetching, no
 * translations — so it slots into either the server or the client tree. It must
 * NOT import `next-intl/server` (a regression guard enforces that for
 * `components/events/`).
 *
 * SSR-SAFE: every particle is FIXED at module scope (no Math.random / Date /
 * new Date anywhere) so the server and client render byte-identical markup — no
 * hydration mismatch. The animation lives entirely in CSS keyframes in
 * globals.css; the global `prefers-reduced-motion` block there zeroes their
 * duration, so under reduced motion the glow stays a still glow and the
 * confetti/balloons simply hold position — the same graceful degrade as
 * `.aurora`. No JS motion guard needed.
 *
 * DESIGN-TONE: the app spends its boldness on the poster, so this stays
 * tasteful and lightweight — a light scatter, not a flood.
 */

/** The app's three warm/cool accents, cycled across confetti pieces (D: 不堆砌). */
const CONFETTI_PALETTE = ["#ff6a5c", "#ffb14e", "#9b8cff"] as const;

interface ConfettiPiece {
  left: string;
  delay: string;
  duration: string;
  size: number;
  /** index into CONFETTI_PALETTE, or -1 to use the host accent. */
  colorIndex: number;
  rounded: boolean;
}

/** 16 fixed confetti pieces — positions/delays/colors hand-tuned, deterministic. */
const CONFETTI_PIECES: readonly ConfettiPiece[] = [
  { left: "6%", delay: "0s", duration: "5.5s", size: 7, colorIndex: 0, rounded: false },
  { left: "13%", delay: "1.4s", duration: "6.2s", size: 6, colorIndex: 1, rounded: true },
  { left: "21%", delay: "0.6s", duration: "5.1s", size: 8, colorIndex: 2, rounded: false },
  { left: "28%", delay: "2.1s", duration: "6.6s", size: 6, colorIndex: -1, rounded: true },
  { left: "35%", delay: "0.9s", duration: "5.8s", size: 7, colorIndex: 1, rounded: false },
  { left: "42%", delay: "1.8s", duration: "5.3s", size: 6, colorIndex: 0, rounded: true },
  { left: "49%", delay: "0.3s", duration: "6.4s", size: 8, colorIndex: 2, rounded: false },
  { left: "56%", delay: "2.4s", duration: "5.6s", size: 6, colorIndex: -1, rounded: true },
  { left: "63%", delay: "1.1s", duration: "6.1s", size: 7, colorIndex: 0, rounded: false },
  { left: "70%", delay: "0.5s", duration: "5.4s", size: 6, colorIndex: 1, rounded: true },
  { left: "77%", delay: "2.0s", duration: "6.3s", size: 8, colorIndex: 2, rounded: false },
  { left: "84%", delay: "0.8s", duration: "5.9s", size: 6, colorIndex: -1, rounded: true },
  { left: "90%", delay: "1.6s", duration: "5.2s", size: 7, colorIndex: 0, rounded: false },
  { left: "95%", delay: "0.2s", duration: "6.5s", size: 6, colorIndex: 1, rounded: true },
  { left: "17%", delay: "3.0s", duration: "5.7s", size: 6, colorIndex: 2, rounded: false },
  { left: "73%", delay: "3.3s", duration: "6.0s", size: 7, colorIndex: -1, rounded: true },
];

interface Balloon {
  left: string;
  delay: string;
  duration: string;
  width: number;
  /** balloon body color, or null to use the host accent. */
  color: string | null;
}

/** 7 fixed balloons rising — accent + coral/amber, deterministic positions. */
const BALLOONS: readonly Balloon[] = [
  { left: "8%", delay: "0s", duration: "9s", width: 26, color: null },
  { left: "24%", delay: "1.8s", duration: "10.5s", width: 22, color: "#ff6a5c" },
  { left: "40%", delay: "0.7s", duration: "9.8s", width: 28, color: "#ffb14e" },
  { left: "54%", delay: "2.6s", duration: "11s", width: 22, color: null },
  { left: "68%", delay: "1.1s", duration: "9.4s", width: 26, color: "#ff6a5c" },
  { left: "82%", delay: "0.3s", duration: "10.2s", width: 24, color: "#ffb14e" },
  { left: "93%", delay: "2.2s", duration: "10.8s", width: 20, color: null },
];

export function EventEffect({
  effect,
  accent,
}: {
  effect: string | null | undefined;
  accent: string;
}): React.ReactElement | null {
  // Fail-closed normalization: "none"/null/unknown → null → render nothing.
  const key = parseEffect(effect ?? "");
  if (!key) return null;

  const overlayClass = "absolute inset-0 overflow-hidden pointer-events-none";

  if (key === "glow") {
    // A hero-local cousin of `.aurora`: a soft radial glow in the host accent,
    // pulsing opacity + scale via one CSS keyframe.
    return (
      <div aria-hidden className={overlayClass}>
        <div
          className="effect-glow absolute left-1/2 top-1/2 size-[140%] -translate-x-1/2 -translate-y-1/2"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${accent}59, transparent 62%)`,
          }}
        />
      </div>
    );
  }

  if (key === "balloons") {
    return (
      <div aria-hidden className={overlayClass}>
        {BALLOONS.map((b, i) => {
          const color = b.color ?? accent;
          return (
            <span
              key={i}
              className="effect-balloon absolute bottom-[-20%] block"
              style={{
                left: b.left,
                width: `${b.width}px`,
                height: `${Math.round(b.width * 1.25)}px`,
                borderRadius: "50% 50% 50% 50% / 55% 55% 45% 45%",
                background: `radial-gradient(circle at 35% 30%, ${color}, ${color}cc)`,
                animationDelay: b.delay,
                animationDuration: b.duration,
              }}
            />
          );
        })}
      </div>
    );
  }

  // confetti
  return (
    <div aria-hidden className={overlayClass}>
      {CONFETTI_PIECES.map((p, i) => {
        const color = p.colorIndex < 0 ? accent : CONFETTI_PALETTE[p.colorIndex];
        return (
          <span
            key={i}
            className="effect-confetti absolute top-[-12%] block"
            style={{
              left: p.left,
              width: `${p.size}px`,
              height: `${p.size}px`,
              borderRadius: p.rounded ? "9999px" : "1px",
              background: color,
              animationDelay: p.delay,
              animationDuration: p.duration,
            }}
          />
        );
      })}
    </div>
  );
}
