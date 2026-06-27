/**
 * 通知（承認待ち / stalled / 失敗）の純ロジック + 発火エンジン — 強み(a)・webui 完結.
 *
 * 設計（task 019ecd41 ブリーフ準拠）:
 *  - **観測された作業状態の遷移エッジのみ**を通知する（LLM の思考ではない・plan.md KPI）。
 *    standing(継続中) な真値の再通知はしない（一覧の常時強調が担う）。
 *  - **list-level 非秘匿情報のみ**を本文に載せる: session ラベル(session_id 短縮) + repo@branch
 *    or cwd + state + カテゴリ i18n。command / secret / kind / current_action 生値は載せない
 *    （INV-NOTIFY-NO-LEAK / INV-REDACTION の表示版）。
 *  - state の終端値(failed/interrupted)は `@actradeck/event-model` の T1 enum を出所とする
 *    （リテラル直書きしない）。completed(正常終了) は通知しない。
 *  - **Service Worker (background-closed 配信) は実装しない**（MVP 範囲外）。タブが開いている間の
 *    `window.Notification` のみ。バックグラウンドのタブ(document.hidden=true)で発火する。
 *
 * 表示層・純ロジック: realtime/bff/backend を value-import しない（token-isolation）。
 * event-model からは type-only + T1 enum 値(TERMINAL_STATES)のみを取り込む。
 */
import { TERMINAL_STATES } from "@actradeck/event-model";

import { shortSessionId } from "./wall-display";

import type { MessageKey } from "./i18n/messages";
import type { SessionListItem } from "../realtime/contract";

/** 通知カテゴリ。localStorage 設定・dedup キー・i18n に共通で使う closed-enum。 */
export type NotificationCategory = "approval" | "stalled" | "failed";

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "approval",
  "stalled",
  "failed",
] as const;

/**
 * 失敗とみなす終端 state 集合。**completed は含めない**（正常終了は通知しない）。
 * T1 の TERMINAL_STATES (= completed/failed/interrupted) から completed を除いて導出する
 * （リテラル "failed"/"interrupted" を直書きしない・単一出所）。`SessionListItem.state` は
 * `string | undefined` のため Set<string> に正規化して照合する。
 */
const COMPLETED_STATE = "completed";
export const FAILED_STATES: ReadonlySet<string> = new Set(
  TERMINAL_STATES.filter((s) => s !== COMPLETED_STATE),
);

/** UI が `window.Notification` へ渡すための、純粋な通知仕様（i18n 解決前）。 */
export interface NotificationSpec {
  /** カテゴリ（dedup キーの一部・i18n の選択にも使う）。 */
  readonly category: NotificationCategory;
  /** 対象 session（dedup キーの一部）。 */
  readonly sessionId: string;
  /** タイトル文言の i18n キー。 */
  readonly titleKey: MessageKey;
  /** 本文文言の i18n キー。 */
  readonly bodyKey: MessageKey;
  /**
   * i18n params（**list-level 非秘匿のみ**）。session ラベル / location / state は
   * すべて placeholder 経由で渡す（INV-I18N-NO-RAW-CJK）。生 command/secret は入れない。
   */
  readonly params: Readonly<Record<string, string>>;
  /** dedup / cooldown キー = `${sessionId}:${category}`（標準化のため公開）。 */
  readonly key: string;
}

export interface ComputeNotificationsOptions {
  /** カテゴリ別の有効/無効（設定）。未指定カテゴリは false 扱い（安全側）。 */
  readonly categories: Readonly<Record<NotificationCategory, boolean>>;
}

/** dedup/cooldown のためのキー生成（単一出所）。 */
export function notificationKey(sessionId: string, category: NotificationCategory): string {
  return `${sessionId}:${category}`;
}

/**
 * session ラベル（session_id 短縮）。一覧の他箇所(SessionList/Inbox/Wall)と同じ短縮へ委譲する
 * (TDA-1: shortSessionId 単一出所)。session_id は機微でない識別子なので本文に載せてよい。
 */
function sessionLabel(sessionId: string): string {
  return shortSessionId(sessionId);
}

/**
 * 「どこで動いているか」表示（memory: wall-show-working-directory）。
 * repo@branch を優先し、無ければ cwd、いずれも無ければ空文字（params 側で吸収）。
 * これらは list-level の非秘匿メタ（projection 由来）であり command/secret ではない。
 */
function locationLabel(item: SessionListItem): string {
  if (item.repo) return item.branch ? `${item.repo}@${item.branch}` : item.repo;
  if (item.cwd) return item.cwd;
  return "";
}

/**
 * カテゴリ → i18n キー（title/body）。body は **state + カテゴリ + ラベル** のみで構成し、
 * current_action / command を一切参照しない（no-leak）。
 */
const CATEGORY_KEYS: Record<NotificationCategory, { title: MessageKey; body: MessageKey }> = {
  approval: { title: "notification.approval.title", body: "notification.approval.body" },
  stalled: { title: "notification.stalled.title", body: "notification.stalled.body" },
  failed: { title: "notification.failed.title", body: "notification.failed.body" },
};

function buildSpec(category: NotificationCategory, curr: SessionListItem): NotificationSpec {
  const keys = CATEGORY_KEYS[category];
  return {
    category,
    sessionId: curr.session_id,
    titleKey: keys.title,
    bodyKey: keys.body,
    params: {
      session: sessionLabel(curr.session_id),
      // state は list-level の正規化状態（非秘匿）。未確定は dash 相当の "—"。
      state: curr.state ?? "—",
      // location は repo@branch or cwd（非秘匿メタ）。空なら "—"。
      location: locationLabel(curr) || "—",
    },
    key: notificationKey(curr.session_id, category),
  };
}

/**
 * 純関数: prev→curr の **遷移エッジ**を検出し NotificationSpec[] を返す（副作用なし）。
 *
 * 検出するエッジ（いずれも false/非該当 → true/該当 への立ち上がりのみ）:
 *  - approval: `!prev?.needs_attention && curr.needs_attention`
 *  - stalled:  `!prev?.stalled_suspected && curr.stalled_suspected`
 *  - failed:   curr.state が FAILED_STATES(failed/interrupted) かつ prev.state がそれ以外
 *
 * prev=undefined（初回観測）は「直前=偽」とみなす。これにより snapshot 直後に既に true の
 * session が一斉発火するのを **呼び出し側**（マネージャ）が snapshot 経路を通さないことで防ぐ
 * （delta.list のみを通す。下記 createNotificationEngine 参照）。
 *
 * 各カテゴリは opts.categories で個別に無効化できる（無効なら spec を出さない）。
 */
export function computeNotifications(
  prev: SessionListItem | undefined,
  curr: SessionListItem,
  opts: ComputeNotificationsOptions,
): NotificationSpec[] {
  const out: NotificationSpec[] = [];
  const cats = opts.categories;

  if (cats.approval && !prev?.needs_attention && curr.needs_attention) {
    out.push(buildSpec("approval", curr));
  }
  if (cats.stalled && !prev?.stalled_suspected && curr.stalled_suspected) {
    out.push(buildSpec("stalled", curr));
  }
  if (cats.failed) {
    const currFailed = curr.state !== undefined && FAILED_STATES.has(curr.state);
    const prevFailed = prev?.state !== undefined && FAILED_STATES.has(prev.state);
    if (currFailed && !prevFailed) out.push(buildSpec("failed", curr));
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 発火エンジン（注入 notifier・cooldown・無害縮退）
// ───────────────────────────────────────────────────────────────────────────

/**
 * `window.Notification` の最小抽象。既定実装は browser の Notification、テストは fake を注入する。
 * permission は読み取り専用で公開し、エンジンは granted のときのみ show を呼ぶ。
 */
export interface Notifier {
  /** 現在の許可状態。"default"(未確認) / "granted" / "denied"。 */
  readonly permission: NotificationPermission;
  /** 1 件表示する。title + 任意 options(body/tag)。失敗は呼び元が握る。 */
  show(title: string, options: { readonly body: string; readonly tag: string }): void;
  /** ユーザー操作起点でのみ呼ぶ許可要求。 */
  requestPermission(): Promise<NotificationPermission>;
}

/** browser の `window.Notification` を Notifier として薄くラップ（不在環境では生成しない）。 */
export function browserNotifier(): Notifier | undefined {
  if (typeof window === "undefined") return undefined;
  const Ctor = window.Notification;
  if (typeof Ctor !== "function") return undefined;
  return {
    get permission() {
      return Ctor.permission;
    },
    show(title, options) {
      // tag を使い OS 側でも同一キーの古い通知を新しいもので置き換える（storm 抑制の二重化）。
      new Ctor(title, { body: options.body, tag: options.tag });
    },
    requestPermission() {
      return Ctor.requestPermission();
    },
  };
}

/** エンジンへ各 delta で渡す環境スナップショット（テストで決定的に注入できる）。 */
export interface NotifyContext {
  /** 通知機能全体の有効化（設定トグル）。 */
  readonly enabled: boolean;
  /** カテゴリ別有効化（設定）。 */
  readonly categories: Readonly<Record<NotificationCategory, boolean>>;
  /** タブが非表示か（document.hidden）。表示中は発火しない。 */
  readonly documentHidden: boolean;
  /** 単調増加のミリ秒時刻（cooldown 判定用・Date.now 等）。 */
  readonly nowMs: number;
}

/** 同一 (session, category) キーの連発を抑える既定 cooldown（ミリ秒）。 */
export const DEFAULT_COOLDOWN_MS = 10_000;

export interface NotificationEngine {
  /**
   * 1 つの list delta（prev→curr）を処理し、条件を満たすカテゴリだけ通知を発火する。
   * 発火した spec を返す（テスト/可観測性用。発火しなければ空配列）。
   */
  handleListDelta(
    prev: SessionListItem | undefined,
    curr: SessionListItem,
    ctx: NotifyContext,
  ): NotificationSpec[];
}

export interface CreateNotificationEngineOptions {
  /** notifier 注入（既定 = browserNotifier()）。不在/undefined なら一切発火しない（無害縮退）。 */
  readonly notifier?: Notifier | undefined;
  /** i18n 解決関数（locale 束縛済み t）。spec→実文言へ。 */
  readonly translate: (key: MessageKey, params?: Record<string, string | number>) => string;
  /** cooldown（ミリ秒）。既定 DEFAULT_COOLDOWN_MS。 */
  readonly cooldownMs?: number;
}

/**
 * 発火エンジンを生成する。発火条件は **enabled ∧ permission==="granted" ∧ documentHidden**
 * （ブリーフ準拠）。Notifier 不在 / permission!=="granted" は throw せず silent（無害縮退）。
 *
 * dedup/storm 防止: (session_id, category) のエッジのみ computeNotifications が出す。さらに同一
 * キーの cooldown 内連発を本エンジンが抑制する（standing true の再通知はそもそもエッジでないため出ない）。
 */
export function createNotificationEngine(
  opts: CreateNotificationEngineOptions,
): NotificationEngine {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  // key -> 最後に発火した時刻(ms)。cooldown 判定に使う。
  const lastFiredAt = new Map<string, number>();

  return {
    handleListDelta(prev, curr, ctx) {
      // 全体無効 / 非表示でない（タブ前面）なら何もしない。
      if (!ctx.enabled) return [];
      if (!ctx.documentHidden) return [];

      const notifier = opts.notifier;
      // Notifier 不在（SSR / 非対応ブラウザ）は silent（prompt も出さない）。
      if (!notifier) return [];
      // 許可済みのときだけ発火。default/denied は silent（requestPermission を勝手に呼ばない）。
      if (notifier.permission !== "granted") return [];

      const specs = computeNotifications(prev, curr, { categories: ctx.categories });
      const fired: NotificationSpec[] = [];
      for (const spec of specs) {
        const last = lastFiredAt.get(spec.key);
        if (last !== undefined && ctx.nowMs - last < cooldownMs) continue; // cooldown 中は抑制。
        lastFiredAt.set(spec.key, ctx.nowMs);
        try {
          notifier.show(opts.translate(spec.titleKey, spec.params), {
            body: opts.translate(spec.bodyKey, spec.params),
            tag: spec.key,
          });
          fired.push(spec);
        } catch {
          // show 失敗（ブラウザ制約等）は無視。reconnect storm/例外伝播を防ぐ。
        }
      }
      return fired;
    },
  };
}
