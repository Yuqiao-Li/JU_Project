"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { type ProfileFormState, updateProfile } from "./actions";

const INITIAL: ProfileFormState = { status: "idle" };

/**
 * Profile settings form (Step-10A task 7). The single name field IS the host's
 * nickname (display_name) — the public-username handle and its availability check
 * are retired (入口是局不是人, §5). WeChat + general contact are host-owned and
 * revealed to guests only after the event finalizes (double-blind).
 */
export function ProfileForm({
  initialDisplayName,
  initialWechatId,
  initialContact,
}: {
  initialDisplayName: string;
  initialWechatId: string;
  initialContact: string;
}) {
  const t = useTranslations("settings");
  const [state, formAction, pending] = useActionState(updateProfile, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="display_name" className="eyebrow">
          {t("nicknameLabel")}
        </label>
        <input
          id="display_name"
          name="display_name"
          type="text"
          required
          defaultValue={initialDisplayName}
          maxLength={80}
          placeholder={t("namePlaceholder")}
          className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="wechat_id" className="eyebrow">
          {t("wechatLabel")}
        </label>
        <input
          id="wechat_id"
          name="wechat_id"
          type="text"
          defaultValue={initialWechatId}
          maxLength={100}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t("wechatPlaceholder")}
          className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
        />
        <p className="text-xs text-muted">{t("wechatHint")}</p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="contact" className="eyebrow">
          {t("contactLabel")}
        </label>
        <input
          id="contact"
          name="contact"
          type="text"
          defaultValue={initialContact}
          maxLength={200}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t("contactPlaceholder")}
          className="h-12 rounded-xl border border-line bg-surface-2 px-4 text-paper placeholder:text-muted/60 focus:border-iris focus:outline-none"
        />
        <p className="text-xs text-muted">{t("contactHint")}</p>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="h-12 rounded-xl bg-coral px-6 font-semibold text-ink transition hover:brightness-105 disabled:opacity-60"
        >
          {pending ? t("saving") : t("save")}
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
