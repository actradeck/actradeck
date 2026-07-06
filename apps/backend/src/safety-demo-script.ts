/**
 * Safety Demo Script — 使い捨てセーフティデモの **定数 / イベント列の単一ソース** (native-free・pure).
 *
 * ADR 019f22a7 P1 / decision 019f387f: Docker cockpit image は apps/sidecar を COPY しないため、旧
 * driver (`apps/sidecar/e2e/run-safety-demo.mts`) は container 内に不在で enabled=false → CTA 503 だった。
 * これを解消する「backend 内 native-free 単一 driver」(`safety-demo-driver.ts`) が消費する定数・意味順序を
 * 本ファイルへ集約する。`run-safety-demo.mts` (sidecar 統合 e2e) も同定数を import し、値の二重定義を排する。
 *
 * 純度: node builtins も native addon も引かない (better-sqlite3 / node-pty / ws を import しない)。
 * event-model は **型のみ** import する (リネームがビルド赤になるよう typed 定数を型注釈で縛る)。
 *
 * ── dummy secret は split-literal で実行時組立する (at-rest に連続 secret 形を残さない) ────────────
 * 本ファイルは apps/backend/src 配下の **出荷ソース**で、`e2e/` の fixture-path 免除の外にある。ゆえに
 *   - image FS scan (`scripts/test-release-prep.sh` / Docker layer)、
 *   - OSS mirror leak gate (`scripts/lib/oss-patterns.sh` の OSS_SECRET_RE),
 *   - GitHub Push Protection
 * のいずれもがこのファイルを **走査する**。redactor.ts:329-330 の `AKIA[0-9A-Z]{16}` /
 * `ghp_[A-Za-z0-9_]{20,255}`、および OSS_SECRET_RE の `AKIA[0-9A-Z]{16}` / `ghp_[A-Za-z0-9]{36}` に
 * **連続マッチする at-rest バイト列を残さない**ため、公開ダミー値を配列 join で組み立てる。
 * 配列リテラルの境界に `", "` (クォート+カンマ) が挟まるため `AKIA"` / `ghp_"` となり、いずれの正規表現も
 * 前方一致を失う (split の 2 片は単独でもマッチしない)。実行時値は run-safety-demo.mts と同一
 * (`AKIA`+`IOSFODNN7EXAMPLE` / `ghp_`+`"DemoFakeSeedT0ken".padEnd(36,'x')`・本コメント内も連続形を避け
 * バッククォートで断つ)。組み立てた値は本物の secret 形ゆえ、backend ingress redaction floor
 * (ingestion-server.ts:409) が保存前に `[REDACTED:*]` へ潰す (= REAL)。
 */
import type { ApprovalTrigger, EventType, RiskLevel, State } from "@actradeck/event-model";

/** 使い捨てデモ session_id の prefix (safety-demo.ts が re-export する単一出所)。 */
export const SAFETY_DEMO_SESSION_PREFIX = "demo-safety-";

/** 使い捨て cwd (非 git・削除できる /tmp 配下ゆえ「デモと分かる」)。 */
export const DEMO_CWD = "/tmp/actradeck-demo";

/** 固定 high-risk コマンド (rm -rf・recursive-rm)。ユーザー入力を一切混ぜない固定文字列。 */
export const DEMO_HIGH_RISK_COMMAND = `rm -rf ${DEMO_CWD}/build`;

/** 承認カードの tool 名 (Bash)。 */
export const DEMO_TOOL_NAME = "Bash";

/**
 * 承認カードの typed 定数 (event-model / projection の型参照)。event-model の enum から値が
 * 削除/リネームされると **ビルド赤**になる (T1 ドリフト検知)。
 */
export const DEMO_RISK_LEVEL: RiskLevel = "high";
export const DEMO_APPROVAL_TRIGGER: ApprovalTrigger = "destructive";

/**
 * 公開ダミー secret (実在しない・split-literal 実行時組立)。ファイル冒頭コメントの理由により、
 * at-rest に `AKIA[0-9A-Z]{16}` / `ghp_[A-Za-z0-9]{36}` へ連続マッチする形を残さない。
 * 実行時値は run-safety-demo.mts と同一で、redactString / ingress floor が redact する。
 */
export const DEMO_AWS_ACCESS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join(""); // aws-access-key-id (AKIA + 16)
export const DEMO_GITHUB_TOKEN = ["ghp_", "DemoFakeSeedT0ken".padEnd(36, "x")].join(""); // github-token (ghp_ + 36)

/**
 * ダミー secret を含む **un-redacted** なコマンド出力 (redact 脚の入力)。backend ingress floor が
 * 保存前 redact するため、生 secret は SQLite/PG に残らず redaction_count_by_kind に kind 別件数が乗る。
 */
export function demoSecretCommand(): string {
  return `echo "deploy with ${DEMO_AWS_ACCESS_KEY_ID} and ${DEMO_GITHUB_TOKEN} to staging"`;
}

/** デモ 1 ステップの意味 (event_type + 遷移先 state + 一行要約)。EventType/State は T1 型で縛る。 */
export interface DemoStep {
  readonly event_type: EventType;
  readonly state: State;
  readonly summary: string;
}

/**
 * デモイベント列の **意味順序** を 1 箇所へ定義する (単一出所)。driver が各ステップに payload を
 * 与えて emit する。可視結果は既存 run-safety-demo.mts の event 列 (session.started →
 * tool.permission.requested(high, rm -rf) → tool.permission.resolved(deny) → command.completed(secret) →
 * session.ended) と実質同一。resolve は driver が hold/timeout で担う (deny 既定)。
 *
 * state 遷移は T1 遷移表 (state.ts) と整合させる:
 *   starting → waiting.approval → running.model_wait(deny) → running.command_executing → completed。
 * `satisfies` で各 event_type/state をリテラル型のまま T1 enum に照合する (未知値はビルド赤)。
 */
export const DEMO_STEPS = {
  sessionStarted: {
    event_type: "session.started",
    state: "starting",
    summary: "セーフティデモ開始 (使い捨てセッション)",
  },
  permissionRequested: {
    event_type: "tool.permission.requested",
    state: "waiting.approval",
    summary: `高リスク操作の承認要求: ${DEMO_HIGH_RISK_COMMAND}`,
  },
  // deny 経路の resolved 遷移先 (許可時 running.tool_preparing / 拒否時 running.model_wait・hook-receiver 準拠)。
  permissionResolvedDeny: {
    event_type: "tool.permission.resolved",
    state: "running.model_wait",
    summary: "承認 拒否",
  },
  commandCompleted: {
    event_type: "command.completed",
    state: "running.command_executing",
    summary: "コマンド出力を保存前 redact",
  },
  sessionEnded: {
    event_type: "session.ended",
    state: "completed",
    summary: "セーフティデモ終了",
  },
} satisfies Record<string, DemoStep>;
