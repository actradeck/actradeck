"use client";

/**
 * 通知設定の小型 UI（AppHeader 常設操作）.
 *
 * - 「通知を有効化」ボタンは **ユーザー操作起点**で permission を要求する（mount では呼ばない）。
 * - 有効化後はカテゴリ別（承認/stalled/失敗）のネイティブ checkbox を出す。
 * - permission が denied / 非対応のときは状態を伝え、要求を繰り返さない（無害縮退）。
 *
 * 実発火ロジックは use-notifications / notifications.ts が握る（この層は設定の入出力のみ）。
 */
import { useId } from "react";

import { Button } from "./kit";
import { useLocale } from "./LocaleProvider";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "./notifications";
import type { UseNotificationsResult } from "./use-notifications";
import type { MessageKey } from "./i18n/messages";

const CATEGORY_LABEL_KEY: Record<NotificationCategory, MessageKey> = {
  approval: "notification.category.approval",
  stalled: "notification.category.stalled",
  failed: "notification.category.failed",
};

export interface NotificationToggleProps {
  readonly notifications: UseNotificationsResult;
}

export function NotificationToggle({ notifications }: NotificationToggleProps) {
  const { t } = useLocale();
  const { settings, permission, requestEnable, disable, setCategory } = notifications;
  const groupId = useId();

  // 非対応ブラウザ: 状態だけ示し、操作は出さない（prompt も出さない）。
  if (permission === "unsupported") {
    return (
      <div className="ad-notify-toggle" data-testid="notify-toggle" data-state="unsupported">
        <span className="ad-notify-toggle__status">{t("notification.unsupported")}</span>
      </div>
    );
  }

  const denied = permission === "denied";

  return (
    <div
      className="ad-notify-toggle"
      data-testid="notify-toggle"
      data-enabled={settings.enabled}
      data-permission={permission}
    >
      {!settings.enabled ? (
        <Button
          kind="ghost"
          size="sm"
          iconStart="warning"
          data-testid="notify-enable"
          disabled={denied}
          title={denied ? t("notification.denied.title") : t("notification.enable.title")}
          onClick={() => {
            // ★ permission 要求はこのクリックハンドラ経由でのみ発生する。
            void requestEnable();
          }}
        >
          {denied ? t("notification.denied") : t("notification.enable")}
        </Button>
      ) : (
        <>
          <Button
            kind="ghost"
            size="sm"
            iconStart="warning"
            data-testid="notify-disable"
            title={t("notification.disable.title")}
            onClick={disable}
          >
            {t("notification.disable")}
          </Button>
          <fieldset
            className="ad-notify-toggle__cats"
            aria-label={t("notification.categories.aria")}
          >
            {NOTIFICATION_CATEGORIES.map((cat) => {
              const id = `${groupId}-${cat}`;
              return (
                <label key={cat} htmlFor={id} className="ad-notify-toggle__cat">
                  <input
                    id={id}
                    type="checkbox"
                    data-testid={`notify-cat-${cat}`}
                    checked={settings.categories[cat]}
                    onChange={(e) => setCategory(cat, e.currentTarget.checked)}
                  />
                  <span>{t(CATEGORY_LABEL_KEY[cat])}</span>
                </label>
              );
            })}
          </fieldset>
        </>
      )}
    </div>
  );
}
