/**
 * On-demand git diff 本文プロバイダ (ADR 019ea4ba 段階2 D2-B).
 *
 * 設計の核心 (INV-DETAIL-REDACTION-TRANSPARENCY / INV-DETAIL-DIFF-SIZE):
 *  - diff 本文は **秘匿の塊**。常時 push せず・SQLite に at-rest 永続せず、UI の明示要求時のみ
 *    生成して返す (pull-only)。先行 ADR 019e8e5d の「diff 本文非送出」を round-trip 経路でも維持し、
 *    git-watcher は引き続きメトリクスのみ emit する (本文は本プロバイダの別経路)。
 *  - 生成した diff 文字列は **必ず redactDeep を透過**してから返す (sink.emit と同じ唯一の choke
 *    point `redactor` を使う)。raw diff を WS/SQLite/HTTP 応答のいずれにも出さない。
 *  - サイズ切詰めは **redaction の後**に行う (truncation-before-redaction の逆: 先に切ると
 *    MAX 境界を跨ぐ secret が断片化して未マスク残留しうる)。1 ファイル 64KB / 全体 256KB 上限で、
 *    超過したら `[DIFF-TRUNCATED:n]` マーカーを **redact 済み本文の後ろ**に付す。
 *
 * 取得コマンド (git-watcher と同一の保守的セット):
 *   git diff --no-ext-diff --unified=3
 *   git diff --cached --no-ext-diff --unified=3
 *
 * ⚠️ ここは security-engineer の独立監査対象 (diff 本文 = 最高リスク表面)。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildChildEnv } from "./child-env.js";
import { countRedactionMarkers, redactString } from "./redactor.js";

const execFileAsync = promisify(execFile);

/** 1 ファイル diff の上限 (bytes 相当 = 文字長)。超過は per-file 切詰め。 */
export const MAX_FILE_DIFF = 64 * 1024;
/** 全体 diff の上限 (bytes 相当 = 文字長)。超過は全体切詰め。 */
export const MAX_TOTAL_DIFF = 256 * 1024;

/** diff 応答 (redaction 済み・サイズ規律適用済み)。 */
export interface DiffResult {
  /** redaction 済み diff 本文 (生 diff は決してここに入らない)。 */
  readonly body: string;
  /** いずれかの段階 (per-file / total) で切詰めが起きたか。 */
  readonly truncated: boolean;
  /**
   * redaction が秘匿を検出したか (`[REDACTED:` マーカーの出現)。**秘匿値そのものは出さない**。
   * 右ペイン secret_detected の出所 (件数/bool のみ)。
   */
  readonly secretDetected: boolean;
  /**
   * 検出した `[REDACTED:*]` マーカー件数 (bool の補助。値は含まない)。
   *
   * TDA-3 (名前衝突の明示・別スコープ): NormalizedEvent.redaction_count
   * (packages/event-model/src/event.ts) とは**別物**。こちら (DiffResult.redactionCount →
   * UI では `body.diff.redaction_count`) は **pull した 1 つの diff 本文限定**の件数 (diff スコープ)。
   * あちらは **1 event** の件数で projection が session 単位 secret_redaction_count へ畳む。
   * 同名だがスコープが異なる独立フィールドである。
   */
  readonly redactionCount: number;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      // SEC-1: git 子も allowlist env で起動する。全 env 継承だと悪意ある repo の
      // core.fsmonitor / .gitattributes textconv 等が INGEST_TOKEN / ACTRADECK_* を exfil できる。
      // git は provider cred 不要 (extra なし)。GIT_* も BASE 非列挙で遮断。
      env: buildChildEnv(),
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * 1 ファイル分の diff (先頭の `diff --git` ヘッダで区切る) ごとに redaction を適用し、
 * **redaction の後**に per-file 上限 (MAX_FILE_DIFF) で切詰める。
 *
 * 切詰めを per-file 単位でも行う理由: 1 つの巨大ファイル diff が全体上限を食い潰して
 * 他ファイルの差分を見えなくするのを防ぐ。各 file chunk を独立に redact→truncate するため、
 * 境界跨ぎ secret は redactString 内の PRE_REDACT_SLICE が保持してからマスクする。
 */
function splitFileChunks(rawDiff: string): string[] {
  if (rawDiff.length === 0) return [];
  // `diff --git` 行で分割 (先頭の前置きはそのまま 1 chunk に含める)。
  const parts: string[] = [];
  const lines = rawDiff.split("\n");
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      parts.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) parts.push(current.join("\n"));
  return parts;
}

/**
 * 生 diff を「ファイル単位で redact → per-file 切詰め → 結合 → 全体切詰め」する純関数。
 * I/O を持たないため単体テスト・mutation で直接検証できる (INV-DETAIL-DIFF-SIZE)。
 *
 * 順序契約 (絶対): **redact が必ず truncate より前**。先に切ると秘匿が断片化して漏れる。
 */
export function redactAndTruncateDiff(rawDiff: string): DiffResult {
  let truncated = false;
  const redactedChunks: string[] = [];
  for (const chunk of splitFileChunks(rawDiff)) {
    // (1) redact 先 (choke point)。
    const redacted = redactString(chunk);
    // (2) redact 済みに対して per-file 上限を適用 (truncation-after-redaction)。
    if (redacted.length > MAX_FILE_DIFF) {
      const cut = redacted.length - MAX_FILE_DIFF;
      redactedChunks.push(`${redacted.slice(0, MAX_FILE_DIFF)}\n[DIFF-TRUNCATED:${cut}]`);
      truncated = true;
    } else {
      redactedChunks.push(redacted);
    }
  }
  let body = redactedChunks.join("\n");
  // (3) 全体上限を適用 (やはり redact 済みに対して)。
  if (body.length > MAX_TOTAL_DIFF) {
    const cut = body.length - MAX_TOTAL_DIFF;
    body = `${body.slice(0, MAX_TOTAL_DIFF)}\n[DIFF-TRUNCATED:${cut}]`;
    truncated = true;
  }
  // secret_detected: redaction マーカーの出現を bool/件数で観測 (秘匿値そのものは含めない)。
  // 件数化は共有 util (countRedactionMarkers / REDACTION_MARKER_RE) を唯一参照する (DRY)。
  const redactionCount = countRedactionMarkers(body);
  return { body, truncated, secretDetected: redactionCount > 0, redactionCount };
}

/**
 * 指定 repo の作業ツリー + index diff を生成し、redaction choke 透過 + サイズ規律を適用して返す。
 * repoRoot が空 / git 管理外なら空 diff (空文字 body) を返す。
 */
export async function generateRedactedDiff(repoRoot: string): Promise<DiffResult> {
  if (repoRoot.length === 0) return emptyDiffResult();
  const [diff, cached] = await Promise.all([
    git(repoRoot, ["diff", "--no-ext-diff", "--unified=3"]),
    git(repoRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3"]),
  ]);
  // staged / unstaged を順に連結 (順序は固定: working → index)。
  const combined = cached.length > 0 ? `${diff}${diff.length > 0 ? "\n" : ""}${cached}` : diff;
  return redactAndTruncateDiff(combined);
}

function emptyDiffResult(): DiffResult {
  return { body: "", truncated: false, secretDetected: false, redactionCount: 0 };
}
