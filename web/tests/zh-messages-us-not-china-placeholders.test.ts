import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION GUARD — the Chinese messages catalog must use US (North-American) placeholders,
 * NOT mainland-China ones, in the `eventForm` namespace.
 *
 * AUDIENCE / THE BUG THIS LOCKS IN:
 *   This product targets North-American Chinese speakers (北美华人), NOT users in mainland
 *   China. An earlier i18n pass wrongly seeded `web/messages/zh.json` with China-flavored
 *   example placeholders — a Shanghai city (上海·徐汇), a China-style address (天台路 123 号
 *   5 室), and a CNY price (每人 10 元 …). Those have since been corrected to US equivalents
 *   that mirror the already-US-correct `en.json`:
 *     • cityPlaceholder      上海·徐汇                → 纽约·布鲁克林            (Brooklyn, NY)
 *     • addressPlaceholder    天台路 123 号 5 室       → 布鲁克林大道 123 号 5 单元 (123 Rooftop Ave, Apt 5)
 *     • chipInNotePlaceholder 每人 10 元，包酒水和零食 → 每人 10 美元，包酒水和零食 ($10 …, USD)
 *   This test pins those corrections so a future translation/refactor pass can't quietly
 *   reintroduce the China placeholders.
 *
 * WHY THE BANS ARE NARROW (and deliberately NOT a bare `元` / bare `天台` ban):
 *   We must NOT over-reach. Two legitimately-Chinese, audience-correct strings would be
 *   false-positives under a careless ban and are explicitly ALLOWED here:
 *     • `美元` — the US-correct currency word in chipInNotePlaceholder. A bare-`元` ban would
 *       wrongly flag it, so we ban only the price FORM `10 元` / `10元` (the old CNY value) and
 *       the explicit CNY markers `人民币` / `￥` — never a bare `元`.
 *     • `天台生日趴` — eventNamePlaceholder: a "rooftop birthday party", culturally neutral and
 *       intentionally kept (it mirrors en's "Rooftop birthday"). A bare-`天台` ban would wrongly
 *       flag it, so we ban only the China-address marker `天台路` (Rooftop *Road*) — never a
 *       bare `天台`.
 *
 * WHY A PURE-JSON TEST: this only inspects message-catalog CONTENT, so it reads + JSON.parse-s
 * the catalog files from disk (Node `fs`) — no DB, no React, no `@/` alias — in the same
 * read-from-disk style as `h5-no-silent-unpublish.test.ts` /
 * `client-tree-no-server-getTranslations.test.ts`. The whole-file string is also scanned so a
 * China placeholder reintroduced ANYWHERE in zh.json (not just these three keys) is caught.
 */

/** Read a repo file by path relative to THIS test file (robust to cwd). */
function readRepoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}

type Catalog = { eventForm?: Record<string, unknown> };

const ZH_TEXT = readRepoFile("messages/zh.json");
const EN_TEXT = readRepoFile("messages/en.json");
const zh = JSON.parse(ZH_TEXT) as Catalog;
const en = JSON.parse(EN_TEXT) as Catalog;
const zhForm = (zh.eventForm ?? {}) as Record<string, unknown>;
const enForm = (en.eventForm ?? {}) as Record<string, unknown>;

/** Read a key as a string (fails loudly if the namespace/key is gone). */
function str(form: Record<string, unknown>, key: string, where: string): string {
  const v = form[key];
  expect(typeof v, `${where}.${key} is a string`).toBe("string");
  return v as string;
}

describe("zh.json US-placeholders guard: no China city/address/currency markers anywhere", () => {
  // ── Assertion #1: whole-file scan — a China placeholder ANYWHERE in zh.json is caught. ──
  // We scan the raw file text so a reintroduction in any key (not just the three we corrected)
  // trips this. Tokens are chosen narrowly so `美元` (USD) and `天台生日趴` (rooftop party) pass.
  const BANNED: ReadonlyArray<readonly [string, string]> = [
    ["上海", "Shanghai city marker (use 纽约/布鲁克林 — Brooklyn, NY)"],
    ["徐汇", "Shanghai Xuhui district marker (use a NYC locale)"],
    ["天台路", "China-style address 'Rooftop ROAD' (use 布鲁克林大道 — note: 天台生日趴 the party is fine)"],
    ["人民币", "CNY currency word (this product prices in USD / 美元)"],
    ["￥", "CNY/yen currency symbol (use 美元 / $)"],
    ["10 元", "old CNY price form '10 元' (use 10 美元 — note: bare 元 inside 美元 is fine)"],
    ["10元", "old CNY price form '10元' (use 10 美元 — note: bare 元 inside 美元 is fine)"],
  ];

  it.each(BANNED.map(([t, why]) => ({ token: t, why })))(
    "zh.json does NOT contain the China marker $token",
    ({ token, why }) => {
      expect(ZH_TEXT.includes(token), `zh.json must not contain "${token}" — ${why}`).toBe(false);
    },
  );

  // ── Assertion #6 (positive control on the bans): the narrow tokens really are narrow. ──
  it("the bans do NOT outlaw `美元` (USD) — zh.json keeps the US currency word", () => {
    expect(ZH_TEXT.includes("美元"), "zh.json should keep 美元 (USD); a bare-元 ban would wrongly flag it").toBe(true);
    // None of the banned tokens is a substring of 美元 (proves we never bare-banned 元).
    for (const [token] of BANNED) {
      expect("美元".includes(token), `banned token "${token}" must not match inside 美元`).toBe(false);
    }
  });

  it("the bans do NOT outlaw `天台生日趴` (rooftop party) — eventNamePlaceholder is intentionally kept", () => {
    const eventName = str(zhForm, "eventNamePlaceholder", "zh.eventForm");
    expect(eventName.length, "zh.eventForm.eventNamePlaceholder is non-empty (kept as-is)").toBeGreaterThan(0);
    expect(eventName, "eventNamePlaceholder stays the culturally-neutral rooftop party").toBe("天台生日趴");
    // None of the banned tokens is a substring of 天台生日趴 (proves we never bare-banned 天台).
    for (const [token] of BANNED) {
      expect("天台生日趴".includes(token), `banned token "${token}" must not match inside 天台生日趴`).toBe(false);
    }
  });
});

describe("zh.json US-placeholders guard: the three corrected eventForm keys are US values", () => {
  // ── Assertion #2: cityPlaceholder is the US (NYC) value, never Shanghai. ──
  it("cityPlaceholder is US-appropriate (纽约·布鲁克林 / Brooklyn, NY), not 上海·徐汇", () => {
    const city = str(zhForm, "cityPlaceholder", "zh.eventForm");
    expect(city, "exact US value").toBe("纽约·布鲁克林");
    expect(/布鲁克林|纽约/.test(city), "cityPlaceholder names Brooklyn/NY (布鲁克林/纽约)").toBe(true);
    expect(city.includes("上海"), "cityPlaceholder must not say 上海").toBe(false);
    expect(city.includes("徐汇"), "cityPlaceholder must not say 徐汇").toBe(false);
  });

  // ── Assertion #3: addressPlaceholder is the US value, not the China '天台路' address. ──
  it("addressPlaceholder is the US value (contains 布鲁克林) and drops the China 天台路 marker", () => {
    const address = str(zhForm, "addressPlaceholder", "zh.eventForm");
    expect(address, "exact US value").toBe("布鲁克林大道 123 号 5 单元");
    expect(address.includes("布鲁克林"), "addressPlaceholder is a Brooklyn (布鲁克林) address").toBe(true);
    expect(address.includes("天台路"), "addressPlaceholder must not use the China 天台路 (Rooftop Road) marker").toBe(
      false,
    );
  });

  // ── Assertion #4: chipInNotePlaceholder prices in USD (美元), never the old '10 元' CNY. ──
  it("chipInNotePlaceholder prices in USD (contains 美元) and drops the old 10 元 / 10元 CNY form", () => {
    const note = str(zhForm, "chipInNotePlaceholder", "zh.eventForm");
    expect(note, "exact US value").toBe("每人 10 美元，包酒水和零食");
    expect(note.includes("美元"), "chipInNotePlaceholder prices in 美元 (USD)").toBe(true);
    expect(note.includes("10 元"), "chipInNotePlaceholder must not use the CNY form '10 元'").toBe(false);
    expect(note.includes("10元"), "chipInNotePlaceholder must not use the CNY form '10元'").toBe(false);
  });
});

describe("en.json US-placeholders sanity (reference catalog stays US-correct)", () => {
  // ── Assertion #5: pin that en.json — the reference — remains US-correct. ──
  it("en.eventForm.cityPlaceholder contains Brooklyn", () => {
    const city = str(enForm, "cityPlaceholder", "en.eventForm");
    expect(city.includes("Brooklyn"), "en cityPlaceholder names Brooklyn").toBe(true);
  });

  it("en.eventForm.chipInNotePlaceholder prices in USD (contains $)", () => {
    const note = str(enForm, "chipInNotePlaceholder", "en.eventForm");
    expect(note.includes("$"), "en chipInNotePlaceholder uses a $ price").toBe(true);
  });
});
