/**
 * Managed Codex 起動コマンドの **単一出所** (SEC-2/TDA-3 sweep 019f397c)。
 *
 * 以前は同じコマンド文字列が SessionList の readiness `<code>`・SessionDetail の nonManaged
 * tooltip (i18n `detail.captureMode.nonManaged.codexHint`)・docs に別掲され、`scripts/actradeck`
 * や `codex` サブコマンドの rename で drift する余地があった。rename-sensitive な **prefix**
 * (`./scripts/actradeck codex`) をここへ集約し、webui の 2 表示面が共有する。
 *
 * 表示のローカライズ (`"<task>"` / `"<タスク>"`) は i18n 各カタログの literal 側に残す
 * (prefix は locale 非依存・placeholder 語は locale 依存)。
 *
 * **docs 側の別掲は grep 対象** (TS 定数を import できないため): rename 時は次も更新する —
 *   docs/README / docs/attach-mode.md / docs/getting-started.md 等の "scripts/actradeck codex"。
 */
export const MANAGED_CODEX_PREFIX = "./scripts/actradeck codex";

/** SessionList の readiness hint が `<code>` 表示するフルコマンド (英語 placeholder)。 */
export const MANAGED_CODEX_CMD = `${MANAGED_CODEX_PREFIX} "<task>"`;
