"use client";

import { useActionState, useState } from "react";

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
  const d = defaults ?? BLANK;
  const action = mode === "create" ? createEvent : updateEvent;
  const [state, formAction, pending] = useActionState(action, INITIAL);

  const [dateTbd, setDateTbd] = useState(d.dateTbd);
  const [allowPlusOnes, setAllowPlusOnes] = useState(d.allowPlusOnes);
  const [clearPassword, setClearPassword] = useState(false);

  const publishLabel =
    mode === "create" ? "Publish event" : d.status === "published" ? "Save changes" : "Publish";
  const draftLabel = mode === "create" ? "Save as draft" : "Move to draft";

  return (
    <form action={formAction} className="flex flex-col gap-10">
      {mode === "edit" && <input type="hidden" name="event_id" value={d.id} />}

      {/* The basics */}
      <section className="flex flex-col gap-5">
        <SectionLabel>The basics</SectionLabel>
        <div className="flex flex-col gap-2">
          <label htmlFor="title" className="text-sm text-muted">
            Event name
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            maxLength={120}
            defaultValue={d.title}
            placeholder="Rooftop birthday"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="description" className="text-sm text-muted">
            What&apos;s the plan?
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            maxLength={4000}
            defaultValue={d.description}
            placeholder="Drinks, a playlist, and a view. Come through."
            className="w-full rounded-xl border border-line bg-surface-2 px-4 py-3 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
          />
        </div>
      </section>

      {/* When */}
      <section className="flex flex-col gap-5">
        <SectionLabel>When</SectionLabel>
        <label className="flex items-center gap-3 text-paper">
          <input
            type="checkbox"
            name="date_tbd"
            checked={dateTbd}
            onChange={(e) => setDateTbd(e.target.checked)}
            className="size-4 accent-coral"
          />
          Date to be decided
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="starts_at" className="text-sm text-muted">
              Starts
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
              Ends <span className="text-muted/60">(optional)</span>
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
        <SectionLabel>Where</SectionLabel>
        <div className="flex flex-col gap-2">
          <label htmlFor="location_city" className="text-sm text-muted">
            City <span className="text-muted/60">— shown before anyone RSVPs</span>
          </label>
          <input
            id="location_city"
            name="location_city"
            type="text"
            maxLength={120}
            defaultValue={d.locationCity}
            placeholder="Brooklyn, NY"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="location_text" className="text-sm text-muted">
            Full address <span className="text-muted/60">— revealed only after RSVP</span>
          </label>
          <input
            id="location_text"
            name="location_text"
            type="text"
            maxLength={500}
            defaultValue={d.locationText}
            placeholder="123 Rooftop Ave, Apt 5"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="location_url" className="text-sm text-muted">
            Map or venue link <span className="text-muted/60">(optional)</span>
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
        <SectionLabel>Who can come</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="capacity" className="text-sm text-muted">
              Capacity <span className="text-muted/60">(optional)</span>
            </label>
            <input
              id="capacity"
              name="capacity"
              type="number"
              min={1}
              step={1}
              defaultValue={d.capacity ?? ""}
              placeholder="No limit"
              className={inputClass}
            />
          </div>
          {allowPlusOnes && (
            <div className="flex flex-col gap-2">
              <label htmlFor="max_plus_ones" className="text-sm text-muted">
                Plus-ones per guest
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
          Let guests bring a plus-one
        </label>
        <label className="flex items-center gap-3 text-paper">
          <input type="checkbox" name="rsvp_enabled" defaultChecked={d.rsvpEnabled} className="size-4 accent-coral" />
          Collect RSVPs <span className="text-sm text-muted">— turn off to just share the details</span>
        </label>
      </section>

      {/* Privacy */}
      <section className="flex flex-col gap-5">
        <SectionLabel>Privacy</SectionLabel>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm text-muted">Who can find this event</legend>
          <label className="flex items-start gap-3 text-paper">
            <input
              type="radio"
              name="visibility"
              value="public"
              defaultChecked={d.visibility === "public"}
              className="mt-1 size-4 accent-coral"
            />
            <span>
              Public
              <span className="block text-sm text-muted">Anyone with the link can see it and RSVP.</span>
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
              Private
              <span className="block text-sm text-muted">Only people you send the link to. Never publicly listed.</span>
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
            Remove the current password
          </label>
        )}
        <div className="flex flex-col gap-2">
          <label htmlFor="password" className="text-sm text-muted">
            {d.hasPassword ? "Set a new password" : "Add a password"}{" "}
            <span className="text-muted/60">{d.hasPassword ? "(leave blank to keep current)" : "(optional)"}</span>
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            disabled={clearPassword}
            placeholder={d.hasPassword ? "••••••••" : "Guests type this to see the details"}
            className={inputClass}
          />
          {d.hasPassword && <p className="text-xs text-muted">This event is password protected.</p>}
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
          {pending ? "Saving…" : publishLabel}
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
