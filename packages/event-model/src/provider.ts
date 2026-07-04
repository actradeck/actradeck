/**
 * Provider / Source enums (plan.md §6・ADR 019f2d2c #6a 公開取込コントラクト).
 *
 * provider 固有のイベント形状 (Claude Code hooks / Codex App Server) は
 * 正規化層で吸収し、ここでは「どの CLI 由来か」(provider=WHO) と
 * 「どの取り込み経路か」(source=HOW) だけを安定して固定する。
 * UI へ provider 固有形状を素通ししない。
 *
 * 次元の非対称原則 (ADR 019f2d2c D1/D2):
 * - provider = WHO → **slug 開放** (第三者ツールが自分の識別子で /ingest できる公開契約)。
 * - source   = HOW → **closed enum** (取込経路は有限・直 POST は単一の "external" 値で正確)。
 * - event_type = 意味 → **closed 維持** (未知 type は状態機械の遷移を静かに欠落させる
 *   correctness ホール。正規化はアダプタ側の責務。event-type.ts 参照)。
 */
import { z } from "zod";

/**
 * 既知の provider (WHO)。意味論・既存コードの分岐はこの 2 値に閉じる。
 * slug 開放 (下記) 後も定数として保持し、コード内の「既知 provider か」判定に使う
 * (KNOWN 判定は表示・分岐ヒント用であって、未知 slug も pipeline を貫通する)。
 *
 * TDA-2': `KnownProvider` 型 / `isKnownProvider()` は **意味論分岐の初回消費者が現れるまで
 * production 未使用の前方互換 API** である。現状 backend/projection/webui は provider を
 * opaque string として pass-through し値で分岐しない (未知 slug graceful の根拠)。将来
 * 「claude_code/codex 固有の扱い」を足す最初の実装がこの narrow を消費するための seam として置く。
 */
export const KNOWN_PROVIDERS = ["claude_code", "codex"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/**
 * provider slug 正規表現 (ADR 019f2d2c D1)。
 * 小文字英字始まり + `[a-z0-9_-]`・全体 1〜32 文字。
 *
 * **regex は charset/長さの有界化であって secret 検出ではない** (正直な限界):
 * - 許可文字は小文字英数 + `_` `-` のみ・全体 ≤32 文字 → 空白 / 大文字 / 記号 / パス区切り /
 *   引用符 / 長い文字列を含めないため、**大半の実 secret・生パス・生コマンドは長さ/大文字/記号で
 *   弾かれる**。ただし ≤32 字の小文字英数トークン (例 `sk_live_abcdef`) は valid slug として通る
 *   ので、「secret を運べない」とは断定しない (これは有界化であり秘匿判定ではない)。
 * - fail-safe reject: 非 slug は parse で弾かれ **保存も表示もされない**。
 *
 * これにより「未知 provider を受理して pipeline を貫通させる」開放性と、
 * 「UI/at-rest に空白/大文字/記号/長い危険文字列を持ち込ませない」有界性を両立する
 * (秘匿値の意味判定は redaction 層の責務であって provider slug 規則の責務ではない)。
 */
export const PROVIDER_SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * イベントを発生させた開発エージェント CLI (WHO)。
 * slug で開放 (ADR 019f2d2c D1)。既知値 (`claude_code` / `codex`) の意味論は不変で、
 * 未知 slug (例 `my_tool`) も受理され pipeline を貫通する。
 * 正準 slug 判定はこの単一 zod schema のみ (backend/webui/sidecar に手書きコピーを作らない)。
 */
export const Provider = z
  .string()
  .regex(PROVIDER_SLUG_RE, "provider must be a slug matching ^[a-z][a-z0-9_-]{0,31}$");
export type Provider = z.infer<typeof Provider>;

/**
 * 与えられた provider が既知 (KNOWN_PROVIDERS) かを判定し型を narrow する。
 * 意味論分岐 (claude_code / codex 固有の扱い) が必要な箇所でのみ使う。
 *
 * TDA-2': **前方互換 API・production 未使用**。現状の consumer (backend/projection/webui) は
 * provider を値で分岐せず opaque string として扱うため、この narrow の呼び出し元は現状テストのみ。
 * 意味論分岐の初回実装が現れたらここを消費する (それまでは seam として保持)。
 */
export function isKnownProvider(provider: string): provider is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * 取り込み経路 (HOW)。closed enum を維持する (ADR 019f2d2c D2)。
 * - hooks: Claude Code hooks (HTTP) — Phase 2 の初期スライス。
 * - app_server: Codex App Server (JSON-RPC) — 後続スライス。
 * - rollout: Codex TUI rollout JSONL passive tail — Codex Attach Phase A。
 * - sdk: SDK streaming connector — 後続スライス。
 * - external: 第三者アダプタが公開契約に沿って /ingest へ直 POST する経路
 *   (ADR 019f2d2c D2・#6a 公開取込コントラクト)。単一値で「外部直取込」を意味的に正確に表す
 *   (slug 化すると経路詐称を許し drift するため source は開放しない)。
 */
export const Source = z.enum(["hooks", "app_server", "rollout", "sdk", "external"]);
export type Source = z.infer<typeof Source>;
