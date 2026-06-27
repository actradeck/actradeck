/**
 * 通知設定の localStorage 永続（強み(a)・webui 完結）.
 *
 * キー = `actradeck.notifications`。値は `{ enabled, categories:{approval,stalled,failed} }`。
 * SSR / localStorage 不在 / 壊れ値は **既定（全 false）** へ安全縮退する（架空状態を作らない）。
 * 既定が全 false なのは「ユーザーがトグルで明示有効化するまで通知しない」ため（mount で許可要求もしない）。
 */
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "./notifications";

export interface NotificationSettings {
  /** 通知機能全体の有効化。 */
  readonly enabled: boolean;
  /** カテゴリ別有効化。 */
  readonly categories: Readonly<Record<NotificationCategory, boolean>>;
}

const STORAGE_KEY = "actradeck.notifications";

/** 既定（全 false）。明示有効化前は何もしない。 */
export function defaultNotificationSettings(): NotificationSettings {
  return {
    enabled: false,
    categories: { approval: false, stalled: false, failed: false },
  };
}

function coerceCategories(raw: unknown): Record<NotificationCategory, boolean> {
  const out: Record<NotificationCategory, boolean> = {
    approval: false,
    stalled: false,
    failed: false,
  };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const c of NOTIFICATION_CATEGORIES) {
      if (obj[c] === true) out[c] = true;
    }
  }
  return out;
}

/** localStorage から設定を読む（不在/壊れ値は既定）。 */
export function readNotificationSettings(): NotificationSettings {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return defaultNotificationSettings();
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultNotificationSettings();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return defaultNotificationSettings();
    const obj = parsed as Record<string, unknown>;
    return {
      enabled: obj["enabled"] === true,
      categories: coerceCategories(obj["categories"]),
    };
  } catch {
    return defaultNotificationSettings();
  }
}

/** localStorage へ設定を保存（失敗は無視・セッション内 state は保持される）。 */
export function persistNotificationSettings(settings: NotificationSettings): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 永続失敗（プライベートモード等）は無視。
  }
}
