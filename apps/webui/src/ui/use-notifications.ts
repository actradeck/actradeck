"use client";

/**
 * useNotifications — 通知設定 + 発火エンジンを React 状態へ橋渡しするフック（強み(a)・webui 完結）.
 *
 * 責務:
 *  - 設定（enabled + カテゴリ別）を localStorage 永続で保持（SSR 安全・既定 false）。
 *  - 安定した NotificationEngine を 1 つ保持し、list delta ごとに `notify(prev, curr)` を呼ばせる。
 *    発火条件（enabled ∧ permission==="granted" ∧ document.hidden ∧ cooldown）はエンジンが判定。
 *  - **permission 要求は必ずユーザー操作起点**（`requestEnable`）。mount/page load では呼ばない。
 *
 * notifier は注入可能（既定 = browserNotifier()）。テストは fake notifier を渡して決定的に検証する。
 * Service Worker（background-closed 配信）は実装しない（MVP 外）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "./LocaleProvider";
import {
  defaultNotificationSettings,
  persistNotificationSettings,
  readNotificationSettings,
  type NotificationSettings,
} from "./notification-settings";
import {
  browserNotifier,
  createNotificationEngine,
  type NotificationCategory,
  type Notifier,
  type NotifyContext,
} from "./notifications";

import type { SessionListItem } from "../realtime/contract";

export interface UseNotificationsOptions {
  /** notifier 注入（既定 = browserNotifier()）。SSR/テストで差し替える。 */
  readonly notifier?: Notifier | undefined;
  /** cooldown（ミリ秒）。既定はエンジン既定。 */
  readonly cooldownMs?: number;
}

export interface UseNotificationsResult {
  readonly settings: NotificationSettings;
  /** 現在の Notification 許可状態（"unsupported" = Notification 不在）。 */
  readonly permission: NotificationPermission | "unsupported";
  /**
   * list delta（prev→curr）を 1 件処理。条件を満たせば通知を発火する（副作用）。
   * use-realtime の handleFrame(delta.list) から呼ぶ。snapshot 経路では呼ばない
   * （初回 snapshot で既に true の session を一斉発火させないため）。
   */
  readonly notify: (prev: SessionListItem | undefined, curr: SessionListItem) => void;
  /**
   * ユーザー操作起点の有効化。permission が未確認なら requestPermission を呼び（**ここでだけ**）、
   * 結果に応じて enabled を設定する。denied のままなら enabled=false に留める。
   */
  readonly requestEnable: () => Promise<void>;
  /** 全体トグルの無効化（permission には触れない）。 */
  readonly disable: () => void;
  /** カテゴリ別トグル。 */
  readonly setCategory: (category: NotificationCategory, value: boolean) => void;
}

export function useNotifications(opts: UseNotificationsOptions = {}): UseNotificationsResult {
  const { t } = useLocale();
  // 既定は false（SSR ハイドレーション一致のため初期は default、mount 後に永続値を反映）。
  const [settings, setSettings] = useState<NotificationSettings>(defaultNotificationSettings);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );

  // notifier は mount 後に確定（SSR では window 不在）。注入があればそれを優先。
  const notifierRef = useRef<Notifier | undefined>(undefined);

  // 設定 / locale を最新で読むための ref（エンジンは 1 度だけ作り、毎回最新を参照する）。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    // mount 後に永続設定を反映（許可要求はしない）。
    setSettings(readNotificationSettings());
    const n = opts.notifier ?? browserNotifier();
    notifierRef.current = n;
    setPermission(n ? n.permission : "unsupported");
  }, [opts.notifier]);

  // 安定したエンジン（locale/settings/notifier は実行時の最新を ref/getter 越しに読む）。
  const engine = useMemo(() => {
    const engineOpts: Parameters<typeof createNotificationEngine>[0] = {
      // notifier は handleListDelta 実行時の最新（mount 後/注入差し替え）を使うため getter で渡す。
      get notifier() {
        return notifierRef.current;
      },
      translate: (key, params) => tRef.current(key, params),
    };
    if (opts.cooldownMs !== undefined) {
      (engineOpts as { cooldownMs?: number }).cooldownMs = opts.cooldownMs;
    }
    return createNotificationEngine(engineOpts);
  }, [opts.cooldownMs]);

  const notify = useCallback(
    (prev: SessionListItem | undefined, curr: SessionListItem) => {
      const s = settingsRef.current;
      const ctx: NotifyContext = {
        enabled: s.enabled,
        categories: s.categories,
        documentHidden: typeof document !== "undefined" ? document.hidden : false,
        nowMs: Date.now(),
      };
      engine.handleListDelta(prev, curr, ctx);
    },
    [engine],
  );

  const update = useCallback((next: NotificationSettings) => {
    setSettings(next);
    persistNotificationSettings(next);
  }, []);

  const requestEnable = useCallback(async () => {
    const n = notifierRef.current;
    if (!n) return; // 非対応は silent（prompt も出さない）。
    let perm = n.permission;
    if (perm === "default") {
      // ★ permission 要求はこのユーザー操作ハンドラからのみ（mount では呼ばない）。
      perm = await n.requestPermission();
      setPermission(perm);
    } else {
      setPermission(perm);
    }
    if (perm === "granted") {
      // 既存カテゴリ設定が全 false なら、有効化時に全カテゴリを既定 on にする（最小操作で機能する）。
      const cur = settingsRef.current;
      const anyCategory =
        cur.categories.approval || cur.categories.stalled || cur.categories.failed;
      update({
        enabled: true,
        categories: anyCategory ? cur.categories : { approval: true, stalled: true, failed: true },
      });
    } else {
      // denied のままは有効化しない（安全側）。
      update({ ...settingsRef.current, enabled: false });
    }
  }, [update]);

  const disable = useCallback(() => {
    update({ ...settingsRef.current, enabled: false });
  }, [update]);

  const setCategory = useCallback(
    (category: NotificationCategory, value: boolean) => {
      const cur = settingsRef.current;
      update({ ...cur, categories: { ...cur.categories, [category]: value } });
    },
    [update],
  );

  return { settings, permission, notify, requestEnable, disable, setCategory };
}
