/**
 * path-scope — project-scope 封じ込めの **正準 JS 実装** (T1・単一出所).
 *
 * ActraDeck の「cwd 前方一致スコープ」(env `ACTRADECK_PROJECT_SCOPE`) を判定する prefix-containment を
 * 1 箇所へ集約する。複数ティアが同一契約で再解釈すると drift が連続バイパス源になる
 * (security-gate-reuse-canonical-parser) ため、危険判定 (resolve 封じ込め) で再利用される本ロジックは
 * 手書きコピーを禁止し本モジュールを共有する:
 *  - backend `project-scope.ts`: list 絞り込みの入口 + resolve endpoint の **入力 path** lexical gate。
 *  - sidecar `approval-bridge.getPolicyConfigForPath`: 解決済 **git root** の scope 再照合 (SEC-1・二段封じ込め)。
 *
 * 純粋・依存ゼロ (node:path 非使用) ＝ browser/edge でも安全。fs アクセスは一切しない (lexical のみ)。
 * realpath/symlink の物理解決は呼び元の責務 (sidecar は `git rev-parse --show-toplevel` の物理 root を渡す)。
 *
 * 意味論 (TDA-6/QA-5・decision 019f0f2f で SQL 側 cwdScopeClause と整合):
 *  - scope 空 → **無制限** (default-off・後方互換)。
 *  - candidate が prefix と完全一致、または `prefix/...` 配下のみ true (兄弟ディレクトリは false)。
 *  - `..`/`.`/重複スラッシュ/末尾スラッシュは canonical 化してから比較 (`/scope/../etc` の traversal を畳む)。
 *  - 非 string / 空 / NUL 含み / 非絶対 (先頭 `/` でない) は **false** (安全側・拒否)。
 *  - root scope `["/"]` は **退化設定**: candidate が `"/"` 完全一致のときのみ true (SQL も exact `/` ＋
 *    `LIKE '//%'` で同様に制限的)。「無制限」が目的なら scope を空にする (env 未設定)。両者制限的で整合。
 */

/**
 * POSIX 絶対パスを canonical 化する (fs 非アクセス・純 lexical)。`.`/`..`/重複スラッシュを畳み、
 * 末尾スラッシュを除去する。`..` が root を越える分は破棄する (`/a/../../b` → `/b`)。相対パスも畳むが
 * 本モジュールの判定は絶対パス前提 (相対は呼び元で false 判定)。
 */
export function normalizeScopePath(p: string): string {
  const isAbs = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      // 絶対パスで root を越える ".." は破棄する。
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return isAbs ? "/" + joined : joined;
}

/**
 * `candidate` が `scope` (cwd 前方一致 prefix 群) の封じ込め内かを判定する。意味論はモジュール doc 参照。
 * 危険判定 (resolve 封じ込め) で使うため安全側に倒す: 無効入力は false。
 */
export function isPathWithinScope(candidate: unknown, scope: readonly string[]): boolean {
  if (scope.length === 0) return true; // scope off → 制限なし (default-off)。
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (candidate.includes("\0")) return false;
  if (!candidate.startsWith("/")) return false; // 絶対パスのみ (相対は cwd 依存で曖昧)。
  const p = normalizeScopePath(candidate);
  for (const prefixRaw of scope) {
    if (typeof prefixRaw !== "string" || !prefixRaw.startsWith("/")) continue; // 不正 prefix は無視。
    const prefix = normalizeScopePath(prefixRaw);
    // prefix==="/" のとき `prefix + "/"` は "//" となり normalize 済 candidate には決して前方一致しない。
    // よって root scope は candidate==="/" のみ true (SQL と同じく制限的・退化設定)。
    if (p === prefix || p.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * `sanitizeRepoLabel` が除去する制御文字 (0x00-0x1F, 0x7F) の正準 regex。`String.prototype.replace` は
 * global regex の lastIndex を毎回リセットするため module スコープで使い回しても状態を持たない (挙動同一)。
 * eslint-disable を **const 定義の直前 1 行**へ固定し、prettier のメソッドチェーン折り返しでカバー対象が
 * ずれて no-control-regex が誤発火するのを防ぐ (round-3 commit gate で顕在化した directive ずれの恒久修正)。
 */
// eslint-disable-next-line no-control-regex -- 制御文字 (0x00-0x1F,0x7F) を表示ラベルから除去する意図的な範囲。
const REPO_LABEL_CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

/**
 * repo_label を **表示用 basename** へサニタイズする正準実装 (SEC-4 / SEC-R2-1・decision 019f0f2f/019f0f64)。
 * client 由来の自由文字列 (絶対パス / secret 様文字列) を at-rest policy.json + UI へ持ち込ませないため、
 * path 区切り (`/` `\`) の最終 segment へ畳み、制御文字 (改行/復帰/NUL/0x00-0x1F,0x7F) を除去し 64 字へ cap する。
 * 空になれば undefined (label を載せない)。backend ingress (realtime-server set route) と sidecar の NO-RAW
 * 境界 (relay set / store load) が**同一実装を共有**し、単層 sanitize の drift を防ぐ
 * (security-gate-reuse-canonical-parser・SEC-R2-1 が指摘した backend 単層を sidecar まで二重防御化)。
 * 非 string / 空入力は undefined。
 */
export function sanitizeRepoLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const lastSeg = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = lastSeg.replace(REPO_LABEL_CONTROL_CHARS_RE, "").trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}
