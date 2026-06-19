import { ImageResponse } from "next/og";
import { headers } from "next/headers";

import { cardScanUrl } from "@/lib/events/card";
import { readEventBySlug } from "@/lib/events/read-event";

/**
 * 局卡 态1 正面 — the shareable art face, generated server-side as a PNG (Step-10A task 2).
 *
 * This is the `opengraph-image` Route Handler for `/{slug}` (Next 16 file convention): it
 * BOTH renders the card's art face AND doubles as the link's OG/Twitter share image,
 * replacing the old cover-only unfurl (event-card.md 实现逻辑: 态1 = 服务端 PNG, 兼作 OG
 * 分享图). Next wires the resulting `<meta property="og:image">` automatically; the page's
 * `generateMetadata` keeps providing the textual OG fields via `buildEventOgMetadata`.
 *
 * FIRST-TIER ONLY (constraint: this image is PUBLIC — anyone who has the link, or scans
 * the QR, fetches it with no token). We read the event through the trusted role with NO
 * guest token / password / viewer id, so `get_event_by_slug` returns ONLY the first tier.
 * We then render ONLY `location_city` + `starts_at` — never the full address
 * (`location_text`, second tier), never the guest list / counts / contact (third tier).
 * This mirrors og.ts's no-leak discipline: even if a future façade carried a gated field,
 * it could not surface here because we never read it. 不含局名/主办 either — per the design
 * the art's category visual carries identity (Step 10B); the public face stays minimal.
 *
 * VISUAL: layout here is a MINIMAL PLACEHOLDER. The real category-driven art (typography,
 * palette, motifs) is Step 10B — every styled block below is marked `Step 10B: visual`.
 */

export const alt = "JU";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Request-time API (`headers()`) ⇒ this image is generated dynamically per request, which
// is what we want: a freshly published/edited event must reflect its current time + city.
export const dynamic = "force-dynamic";

/** Resolve the public origin for the QR's scan URL: the request's own host, falling back
 *  to the configured site URL. Either way the QR points at the SAME public `/{slug}` page
 *  the image is served from — no token, no in-app scanner (event-card.md). */
async function resolveOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // First-tier façade only: no guestToken / password / viewerId ⇒ the RPC returns the
  // public tier (city + start), never the gated address / list / contact.
  const event = await readEventBySlug(slug);

  const origin = await resolveOrigin();
  // The absolute `/{slug}` URL the QR encodes (phone-camera scan → the public page).
  const scanUrl = cardScanUrl(origin, slug);

  // First-tier fields ONLY. A missing / draft / private event reads as a neutral card.
  const city = event?.location_city?.trim() || "";
  const startsAt = event?.starts_at ?? null;
  const dateTbd = event?.date_tbd === true;
  // Deterministic, locale-light first-tier time line for the art (the rich viewer-local
  // formatting lives in the page DOM; the shared PNG must be self-contained + stable).
  const whenLine = dateTbd
    ? "日期待定 · TBD"
    : startsAt
      ? formatWhenUtc(startsAt)
      : "";

  return new ImageResponse(
    (
      // Step 10B: visual — placeholder art frame. Flexbox only (Satori constraint).
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          // Step 10B: visual — category-driven palette/art goes here.
          background: "linear-gradient(135deg, #1a1730 0%, #2b2150 100%)",
          color: "#f4f1ff",
          padding: "72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Step 10B: visual — art typography for the time + city face. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.1 }}>
            {whenLine || "JU"}
          </div>
          {city ? (
            <div style={{ display: "flex", fontSize: 40, opacity: 0.85 }}>{city}</div>
          ) : null}
        </div>

        {/* Bottom row: brand wordmark (left) + the small QR (right), per 态1 design. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", fontSize: 32, fontWeight: 700, letterSpacing: 2 }}>
            JU
          </div>

          {/*
            QR PLACEHOLDER — DEFERRED (constraint 1: no new dependency installed).
            TODO(QR): run `pnpm --dir web add <a QR library, e.g. qrcode>` and replace this
            placeholder box with the rendered QR for `scanUrl` (a data: PNG via the lib's
            toDataURL, or an inline SVG path) so a phone camera can scan it → the `/{slug}`
            page. Keep encoding EXACTLY `scanUrl` (cardScanUrl(origin, slug)); do not embed
            any token. The box below is a clearly-marked stand-in and the scan URL is
            emitted as text beneath it so the link is usable while the QR is stubbed.
          */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 160,
                height: 160,
                // Step 10B: visual — final QR styling/frame.
                background: "#ffffff",
                color: "#1a1730",
                borderRadius: 16,
                fontSize: 20,
                fontWeight: 700,
                textAlign: "center",
              }}
            >
              QR
            </div>
            {/* Scan URL as text so the destination is usable while the QR is a stub. */}
            <div style={{ display: "flex", fontSize: 16, opacity: 0.75, maxWidth: 220 }}>
              {scanUrl}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}

/**
 * A deterministic UTC "when" line for the static PNG. The page DOM renders the rich
 * viewer-local time (when-format.ts); a shared image can't know the viewer's tz, so it
 * formats the first-tier start instant in UTC — stable and self-contained, mirroring
 * og.ts's first-tier-only posture.
 */
function formatWhenUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(ms);
}
