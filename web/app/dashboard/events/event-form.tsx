"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { CoverUploader } from "@/components/events/cover-uploader";
import { DEFAULT_THEME, EFFECT_PRESETS, THEME_SWATCHES, type ThemeKey } from "@/lib/events/theme";

import { createEvent, type EventFormState, updateEvent } from "./actions";

const INITIAL: EventFormState = { status: "idle" };

export type EventDefaults = {
  id: string;
  title: string;
  description: string;
  dateTbd: boolean;
  startsAt: string | null;
  endsAt: string | null;
  locationText: string;
  locationUrl: string;
  locationCity: string;
  visibility: "public" | "private";
  capacity: number | null;
  allowPlusOnes: boolean;
  maxPlusOnes: number;
  rsvpEnabled: boolean;
  status: string;
  hasPassword: boolean;
  coverImageUrl: string;
  themeColor: ThemeKey;
  effect: string;
  chipInUrl: string;
  chipInNote: string;
};

const BLANK: EventDefaults = {
  id: "",
  title: "",
  description: "",
  dateTbd: false,
  startsAt: null,
  endsAt: null,
  locationText: "",
  locationUrl: "",
  locationCity: "",
  visibility: "public",
  capacity: null,
  allowPlusOnes: false,
  maxPlusOnes: 1,
  rsvpEnabled: true,
  status: "draft",
  hasPassword: false,
  coverImageUrl: "",
  themeColor: DEFAULT_THEME,
  effect: "none",
  chipInUrl: "",
  chipInNote: "",
};

const inputClass =
  "h-12 w-full rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none disabled:opacity-50";

/** ISO timestamp → the "YYYY-MM-DDTHH:mm" a datetime-local input wants (browser tz). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

/**
 * Create / edit event form, core fields (task 2.2a). One client component for
 * both flows — `mode` picks the server action. The password field is three-state
 * on edit (keep / set / clear); the hash is never sent to the client, so the
 * input only ever carries a new plaintext, hashed server-side.
 */
export function EventForm({ mode, defaults }: { mode: "create" | "edit"; defaults?: EventDefaults }) {
  const t = useTranslations("eventForm");
  const d = defaults ?? BLANK;
  const action = mode === "create" ? createEvent : updateEvent;
  const [state, formAction, pending] = useActionState(action, INITIAL);

  const [dateTbd, setDateTbd] = useState(d.dateTbd);
  const [allowPlusOnes, setAllowPlusOnes] = useState(d.allowPlusOnes);
  const [clearPassword, setClearPassword] = useState(false);
  const [themeColor, setThemeColor] = useState<ThemeKey>(d.themeColor);

  const publishLabel =
    mode === "create"
      ? t("publishEvent")
      : d.status === "published"
        ? t("saveChanges")
        : t("publish");
  const draftLabel = mode === "create" ? t("saveAsDraft") : t("moveToDraft");

  return (
    <form action={formAction} className="flex flex-col gap-10">
      {mode === "edit" && <input type="hidden" name="event_id" value={d.id} />}

      {/* The basics */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionBasics")}</SectionLabel>
        <div className="flex flex-col gap-2">
          <label htmlFor="title" className="text-sm text-muted">
            {t("eventNameLabel")}
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            maxLength={120}
            defaultValue={d.title}
            placeholder={t("eventNamePlaceholder")}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="description" className="text-sm text-muted">
            {t("descriptionLabel")}
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            maxLength={4000}
            defaultValue={d.description}
            placeholder={t("descriptionPlaceholder")}
            className="w-full rounded-xl border border-line bg-surface-2 px-4 py-3 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
          />
        </div>
      </section>

      {/* Look — cover, theme color, effect */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionLook")}</SectionLabel>
        <CoverUploader eventId={mode === "edit" ? d.id : null} initialUrl={d.coverImageUrl} />

        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted">{t("themeColorLabel")}</span>
          <div className="flex flex-wrap gap-3">
            {THEME_SWATCHES.map((s) => (
              <label key={s.key} className="cursor-pointer">
                <input
                  type="radio"
                  name="theme_color"
                  value={s.key}
                  checked={themeColor === s.key}
                  onChange={() => setThemeColor(s.key)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  title={s.label}
                  style={{ backgroundColor: s.hex }}
                  className={`block size-9 rounded-full ring-2 ring-offset-2 ring-offset-ink transition peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-iris ${themeColor === s.key ? "ring-paper" : "ring-transparent"}`}
                />
                <span className="sr-only">{s.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="effect" className="text-sm text-muted">
            {t("effectLabel")} <span className="text-muted/60">{t("effectHint")}</span>
          </label>
          <select id="effect" name="effect" defaultValue={d.effect || "none"} className={inputClass}>
            {EFFECT_PRESETS.map((e) => (
              <option key={e.key} value={e.key}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* When */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionWhen")}</SectionLabel>
        <label className="flex items-center gap-3 text-paper">
          <input
            type="checkbox"
            name="date_tbd"
            checked={dateTbd}
            onChange={(e) => setDateTbd(e.target.checked)}
            className="size-4 accent-coral"
          />
          {t("dateTbd")}
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="starts_at" className="text-sm text-muted">
              {t("startsLabel")}
            </label>
            <input
              id="starts_at"
              name="starts_at"
              type="datetime-local"
              disabled={dateTbd}
              defaultValue={toLocalInput(d.startsAt)}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="ends_at" className="text-sm text-muted">
              {t("endsLabel")} <span className="text-muted/60">{t("optional")}</span>
            </label>
            <input
              id="ends_at"
              name="ends_at"
              type="datetime-local"
              disabled={dateTbd}
              defaultValue={toLocalInput(d.endsAt)}
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Where */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionWhere")}</SectionLabel>
        <div className="flex flex-col gap-2">
          <label htmlFor="location_city" className="text-sm text-muted">
            {t("cityLabel")} <span className="text-muted/60">{t("cityHint")}</span>
          </label>
          <input
            id="location_city"
            name="location_city"
            type="text"
            maxLength={120}
            defaultValue={d.locationCity}
            placeholder={t("cityPlaceholder")}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="location_text" className="text-sm text-muted">
            {t("addressLabel")} <span className="text-muted/60">{t("addressHint")}</span>
          </label>
          <input
            id="location_text"
            name="location_text"
            type="text"
            maxLength={500}
            defaultValue={d.locationText}
            placeholder={t("addressPlaceholder")}
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="location_url" className="text-sm text-muted">
            {t("mapLinkLabel")} <span className="text-muted/60">{t("optional")}</span>
          </label>
          <input
            id="location_url"
            name="location_url"
            type="url"
            maxLength={2000}
            defaultValue={d.locationUrl}
            placeholder="https://maps.app/…"
            className={inputClass}
          />
        </div>
      </section>

      {/* Who can come */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionWhoCanCome")}</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="capacity" className="text-sm text-muted">
              {t("capacityLabel")} <span className="text-muted/60">{t("optional")}</span>
            </label>
            <input
              id="capacity"
              name="capacity"
              type="number"
              min={1}
              step={1}
              defaultValue={d.capacity ?? ""}
              placeholder={t("capacityPlaceholder")}
              className={inputClass}
            />
          </div>
          {allowPlusOnes && (
            <div className="flex flex-col gap-2">
              <label htmlFor="max_plus_ones" className="text-sm text-muted">
                {t("plusOnesPerGuest")}
              </label>
              <input
                id="max_plus_ones"
                name="max_plus_ones"
                type="number"
                min={1}
                step={1}
                defaultValue={d.maxPlusOnes}
                className={inputClass}
              />
            </div>
          )}
        </div>
        <label className="flex items-center gap-3 text-paper">
          <input
            type="checkbox"
            name="allow_plus_ones"
            checked={allowPlusOnes}
            onChange={(e) => setAllowPlusOnes(e.target.checked)}
            className="size-4 accent-coral"
          />
          {t("allowPlusOnes")}
        </label>
        <label className="flex items-center gap-3 text-paper">
          <input type="checkbox" name="rsvp_enabled" defaultChecked={d.rsvpEnabled} className="size-4 accent-coral" />
          {t("collectRsvps")} <span className="text-sm text-muted">{t("collectRsvpsHint")}</span>
        </label>
      </section>

      {/* Chip in — display-only payment link */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionChipIn")}</SectionLabel>
        <p className="text-sm text-muted">{t("chipInBlurb")}</p>
        <div className="flex flex-col gap-2">
          <label htmlFor="chip_in_url" className="text-sm text-muted">
            {t("paymentLinkLabel")} <span className="text-muted/60">{t("optional")}</span>
          </label>
          <input
            id="chip_in_url"
            name="chip_in_url"
            type="url"
            maxLength={2000}
            defaultValue={d.chipInUrl}
            placeholder="https://venmo.com/u/you"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="chip_in_note" className="text-sm text-muted">
            {t("chipInNoteLabel")} <span className="text-muted/60">{t("optional")}</span>
          </label>
          <input
            id="chip_in_note"
            name="chip_in_note"
            type="text"
            maxLength={280}
            defaultValue={d.chipInNote}
            placeholder={t("chipInNotePlaceholder")}
            className={inputClass}
          />
        </div>
      </section>

      {/* Privacy */}
      <section className="flex flex-col gap-5">
        <SectionLabel>{t("sectionPrivacy")}</SectionLabel>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm text-muted">{t("whoCanFind")}</legend>
          <label className="flex items-start gap-3 text-paper">
            <input
              type="radio"
              name="visibility"
              value="public"
              defaultChecked={d.visibility === "public"}
              className="mt-1 size-4 accent-coral"
            />
            <span>
              {t("visibilityPublic")}
              <span className="block text-sm text-muted">{t("visibilityPublicHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-paper">
            <input
              type="radio"
              name="visibility"
              value="private"
              defaultChecked={d.visibility === "private"}
              className="mt-1 size-4 accent-coral"
            />
            <span>
              {t("visibilityPrivate")}
              <span className="block text-sm text-muted">{t("visibilityPrivateHint")}</span>
            </span>
          </label>
        </fieldset>

        {mode === "edit" && d.hasPassword && (
          <label className="flex items-center gap-3 text-paper">
            <input
              type="checkbox"
              name="clear_password"
              checked={clearPassword}
              onChange={(e) => setClearPassword(e.target.checked)}
              className="size-4 accent-coral"
            />
            {t("removePassword")}
          </label>
        )}
        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-sm text-muted">
            {d.hasPassword ? t("setNewPassword") : t("addPassword")}{" "}
            <span className="text-muted/60">{d.hasPassword ? t("passwordKeepHint") : t("optional")}</span>
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            disabled={clearPassword}
            placeholder={d.hasPassword ? "••••••••" : t("passwordPlaceholder")}
            className={inputClass}
          />
          {d.hasPassword && <p className="text-xs text-muted">{t("passwordProtected")}</p>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-4 border-t border-line pt-6">
        <button
          type="submit"
          name="intent"
          value="publish"
          disabled={pending}
          className="h-12 rounded-xl bg-coral px-6 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
        >
          {pending ? t("saving") : publishLabel}
        </button>
        <button
          type="submit"
          name="intent"
          value="draft"
          disabled={pending}
          className="h-12 rounded-xl border border-line px-6 font-semibold text-paper transition hover:bg-surface-2 disabled:opacity-60"
        >
          {draftLabel}
        </button>
        {state.status === "success" && (
          <span role="status" className="text-sm text-iris">
            {state.message}
          </span>
        )}
        {state.status === "error" && (
          <span role="alert" className="text-sm text-coral">
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
