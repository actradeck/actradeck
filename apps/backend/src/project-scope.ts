/**
 * Project scope (cwd 前方一致 allowlist) — デモ/集中表示のための list 絞り込み。
 *
 * 目的: concierge 等で cockpit をライブ画面共有する際、観測済みの **他プロジェクト** の名前を
 * 露出させない。attach daemon は user-scope hook で同マシンの全 Claude Code / Codex セッションを
 * 観測するため、Live Wall / Board / Audit に意図しない repo 名 (cwd basename) が混ざる。
 * env `ACTRADECK_PROJECT_SCOPE` (カンマ区切りの cwd 前方一致 prefix) を設定すると、list 系クエリ
 * (realtime snapshot / approval inbox / audit range) を一致セッションのみへ絞る。
 * **既定は off (空) = 全件 (後方互換・現行挙動を一切変えない)**。
 *
 * 安全性 (narrows only):
 * - スコープは行を「除外」するだけで、新たな情報・原文を一切露出しない (redaction / leak 不変条件に中立)。
 * - スコープ ON 時、cwd NULL の行は除外する (= 未知は出さない fail-safe・default-deny)。
 * - prefix と完全一致、または prefix 配下 (`prefix` + `/...`) のみ通す。兄弟ディレクトリ
 *   (例 `/tmp/ad-demo` に対し `/tmp/ad-demo-other`) は通さない。LIKE メタ文字 (`% _ \`) は escape する。
 * - SQL は parameterized (`$N::text[]`)。値を文字列連結で埋めない (injection なし)。
 *
 * 境界 — これは **display hygiene であって authz 境界ではない** (SEC-1 / ADR 019e92ae):
 * - 適用先は **list 経路のみ** (listSnapshot / approvalsSnapshot / rangeReport)。目的は「画面共有時に
 *   一覧へ他プロジェクトが**偶発的に列挙**されるのを防ぐ」こと。
 * - by-id 直接取得 (detail / replay events / command output / diff / audit sessionSummary) は **意図的に
 *   gate しない**。ActraDeck の authz は単一信頼オペレータ前提 (REALTIME_TOKEN = full trust・ADR 019e92ae、
 *   per-session ACL は延期) ゆえ、token 保持者が out-of-scope な session_id を直接渡せば scope 外の
 *   cwd/repo/承認履歴を取得できる。**現行の脅威モデル (自分の画面を自分で共有・token は本人のみ保持) では
 *   leak ではない**。
 * - ⚠ 共有先が **非信頼の第三者** になる (閲覧者へ REALTIME_TOKEN や by-id URL を渡す) 運用へ変えるなら、
 *   by-id 経路にも scope を transitive 適用し、本件 severity を H へ昇格させること (reachability 走査必須)。
 */

/** env 値 (カンマ区切り) を prefix 配列へ。空 / undefined は `[]` (= scope なし)。 */
export function parseProjectScope(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** LIKE パターンのメタ文字を escape する (Postgres LIKE の default escape `\`)。 */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/**
 * cwd 前方一致スコープの SQL 述語 + パラメータを作る。
 * - scope 空 → no-op (`{ clause: "", params: [] }`; 呼び出し側は WHERE / AND を付けない)。
 * - 非空 → `(<col> = ANY($a::text[]) OR <col> LIKE ANY($b::text[]))`
 *   (col が NULL なら両辺 false で除外 = fail-safe)。
 *
 * @param column 例 `"s.cwd"`。
 * @param startParam 割り当てる最初の `$` 番号 (`$a`)。`$b = startParam + 1`。
 * @returns clause と、`pool.query` の values へ **この順で** spread する params (`[exact[], subdir[]]`)。
 */
export function cwdScopeClause(
  scope: readonly string[],
  column: string,
  startParam: number,
): { clause: string; params: string[][] } {
  if (scope.length === 0) return { clause: "", params: [] };
  const exact = [...scope];
  const subdir = scope.map((p) => `${escapeLike(p)}/%`);
  const a = startParam;
  const b = startParam + 1;
  return {
    clause: `(${column} = ANY($${a}::text[]) OR ${column} LIKE ANY($${b}::text[]))`,
    params: [exact, subdir],
  };
}
