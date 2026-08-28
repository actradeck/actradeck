/**
 * observability-counters-wire — 縮退カウンタ (非負整数のみ) を sidecar→backend→endpoint へ運ぶ
 * wire 射影 + 受信検証 + 集約の **正準実装** (T1・単一出所・TDA-V9-7 landing)。
 *
 * 背景 (TDA-V9-7・2026-08-27 v0.9 bundle full 監査 L): 縮退を数えるだけで **読取り路が無い**
 * カウンタが 2 つ (どちらも「>0 = 要調査」の診断信号) 未配線のまま残っていた:
 *  - sidecar `ApprovalBridge.unstableRequestIdCount` (SEC-R4-4 で「runtime 側 consumer 未配線」と開示)
 *    — redaction ルールと承認 request_id 採番形の衝突で採番が mangle された延べ数。
 *  - backend `ApprovalReconciler.nonRetirableSkipCount` (SEC-R5-2 landing) — 正準にも known-legacy にも
 *    一致しない DB pending を合成 skip した延べ数。
 * 「観測可能」を運用上達成するには既存の read-only 集約面 (`GET /realtime/readiness`) へ載せる必要がある。
 * sidecar 側の値は信頼境界 (sidecar→backend) を越えるため、agent_visibility (ADR 019f1972 §2b) と同じ
 * 「wire 型 + 射影 + 受信検証 + 集約を 1 箇所に集約して各ティアが共有」構造にする
 * (security-gate-reuse-canonical-parser・手書きミラー禁止)。
 *
 * NO-RAW 契約 (security.md): wire/endpoint に載るのは **非負安全整数のみ**。request_id 原文・
 * session_id・cwd・パス・token は表現不能 (closed shape の parse が余剰 field を構造的に落とす)。
 * カウンタは「何件あったか」だけを運び「何が」は一切運ばない (原文非依存)。
 *
 * fail-safe 意味論 (false positive を作らない方向へ倒す):
 *  - 非 object → **undefined** (「この daemon は counters 未報告」= 集約から除外)。例外は投げない。
 *  - object だが field が非負安全整数でない (負数 / 小数 / NaN / Infinity / string / bigint / 欠落)
 *    → **0 へ縮退** (asBool→false と同流儀。奇形 wire から件数をでっち上げない)。
 *  - 集約は sum fold (延べ数の意味論を保つ)・空配列 → 0。合計は安全整数域で飽和させる。
 *
 * 純粋・依存ゼロ・fs/net 非アクセス ＝ browser/edge でも安全。
 */

/**
 * hello frame 上の field 名。正直な scope (approval-reconcile-wire の TDA-R2-3 と同じ):
 * 送信側 (`buildDaemonCountersHelloFields`) はこの定数を消費するが、受信側 (backend HelloFrame) は
 * 型付き named field で読むため、構造的な単一出所は **検証・射影ロジック**であり field 名の改名 drift は
 * 両側のテスト (sidecar egress-handshake / backend inv-agent-readiness) のリテラル pin が赤化で防ぐ。
 */
export const DAEMON_COUNTERS_FIELD = "daemon_counters";

/** daemon (sidecar) が hello に相乗りさせる縮退カウンタ (NO-RAW・非負安全整数のみ)。 */
export interface DaemonCountersWire {
  /**
   * `ApprovalBridge.unstableRequestIdCount`: redaction に mangle された承認 request_id 採番の
   * **延べ観測数** (0 が正常。>0 は redaction ルールと採番形の衝突 = 要調査)。
   */
  readonly unstableRequestIdCount: number;
}

/**
 * `GET /realtime/readiness` が公開する縮退カウンタ集約 (NO-RAW・非負安全整数のみ)。
 * daemon 由来 (sum fold) と backend 由来 (reconciler ローカル値) を 1 つの closed shape に束ねる。
 */
export interface ReadinessCountersWire extends DaemonCountersWire {
  /**
   * `ApprovalReconciler.nonRetirableSkipCount`: 正準にも known-legacy にも一致しない DB pending を
   * 合成 skip した **延べ数** (0 が正常。>0 は at-rest id が宣言と割れている = 要調査)。
   * backend ローカル値ゆえ wire (hello) には載らない — endpoint 応答でのみ合流する。
   */
  readonly nonRetirableSkipCount: number;
}

/** 全 counter が 0 の中立値 (未報告 daemon 集合 / 受信不能時の安全形)。 */
export const ZERO_DAEMON_COUNTERS: DaemonCountersWire = { unstableRequestIdCount: 0 };

/**
 * 非負安全整数へ縮退する (NO-RAW・fail-safe)。
 * 負数 / 小数 / NaN / Infinity / 非 number / 安全整数域外は **0** (奇形から件数を作らない)。
 */
function asCount(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** 合計を安全整数域で飽和させる (延べ数の加算が精度を失う域へ出ない)。 */
function addSaturating(a: number, b: number): number {
  const sum = a + b;
  return sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum;
}

/**
 * hello frame へ相乗りさせる counters field を構築する (sidecar ws-client 用・単一出所)。
 * `counters === undefined` (provider 未配線 / bridge 未生成 / observe-only daemon) → field 自体を
 * 載せない (受信側は「未報告」= 集約から除外・後方互換)。載せる値は射影済み非負整数のみ。
 */
export function buildDaemonCountersHelloFields(
  counters: DaemonCountersWire | undefined,
): Record<string, unknown> {
  if (counters === undefined) return {};
  return {
    [DAEMON_COUNTERS_FIELD]: { unstableRequestIdCount: asCount(counters.unstableRequestIdCount) },
  };
}

/**
 * hello frame (untrusted・信頼境界 sidecar→backend) の `daemon_counters` を検証射影する正準パーサ。
 * 既知 counter のみ抽出し **余剰 field を構造的に落とす** (NO-RAW by construction: buggy/adversarial
 * daemon が追加 field へパス・secret を詰めても parse 境界で消える)。
 * 非 object → undefined (未報告扱い・非 throw)。field 不正 → 0 へ縮退 (安全側)。
 */
export function parseDaemonCountersWire(raw: unknown): DaemonCountersWire | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  return { unstableRequestIdCount: asCount(obj.unstableRequestIdCount) };
}

/**
 * 複数 daemon の report を counter ごと sum fold する (延べ数ゆえ OR でなく加算)。
 * 空配列 → 全 0 (誰も報告していない = 未観測・安全側)。
 */
export function aggregateDaemonCounters(
  reports: readonly DaemonCountersWire[],
): DaemonCountersWire {
  let unstableRequestIdCount = 0;
  for (const r of reports) {
    unstableRequestIdCount = addSaturating(
      unstableRequestIdCount,
      asCount(r.unstableRequestIdCount),
    );
  }
  return { unstableRequestIdCount };
}

/**
 * daemon 集約値と backend ローカル値を readiness 応答の closed shape へ合流させる (正準射影)。
 * 両値とも非負安全整数へ射影する (呼び出し側の型を信用しない・endpoint は最終出口)。
 */
export function buildReadinessCounters(
  daemon: DaemonCountersWire,
  nonRetirableSkipCount: unknown,
): ReadinessCountersWire {
  return {
    unstableRequestIdCount: asCount(daemon.unstableRequestIdCount),
    nonRetirableSkipCount: asCount(nonRetirableSkipCount),
  };
}

/**
 * endpoint 応答 (untrusted な read 境界: webui / 外部 consumer) の `counters` を検証射影する。
 * 既知 2 counter のみ抽出し余剰 field を落とす。欠落/奇形は 0 へ縮退 (last-known を汚さない)。
 */
export function parseReadinessCountersWire(raw: unknown): ReadinessCountersWire {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { unstableRequestIdCount: 0, nonRetirableSkipCount: 0 };
  }
  const obj = raw as Record<string, unknown>;
  return {
    unstableRequestIdCount: asCount(obj.unstableRequestIdCount),
    nonRetirableSkipCount: asCount(obj.nonRetirableSkipCount),
  };
}
