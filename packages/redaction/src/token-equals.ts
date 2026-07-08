/**
 * 定数時間トークン比較 (タイミング攻撃耐性・SEC) — **repo 単一出所** (TDA-5 sweep・decision 019f38b9 系)。
 *
 * 素の `provided !== expected` は不一致位置で早期 return しタイミング side-channel を残すため、
 * 同長比較は node:crypto.timingSafeEqual で行う。以前は同型 helper が 5 箇所
 * (sidecar ws-client / hook-receiver・backend ingestion-server / realtime-server / safety-demo-driver)
 * に手書きコピーされていた — 全コピーを本関数へ寄せる (security-gate-reuse-canonical-parser)。
 *
 * 意味論 (fail-safe deny・全既存コピーの非弱化和):
 *  - `provided` が非文字列 / 空文字列 → false (無認証 peer / 欠落 token の注入遮断)。
 *  - `expected` が空文字列 → false (未設定 token で照合しない。旧コピーの一部は空==空を true に
 *    しえたが、その縮退は認証ゲートとして無意味なため厳格化 — 全呼出し元は非空 expected を保証済)。
 *  - 長さ不一致 → 先行 false (timingSafeEqual は同長前提。長さは秘密でない前提のトークン運用)。
 *
 * node:crypto 依存のため **browser (webui) からは import しない**こと (本パッケージは
 * sidecar / backend 専用・webui バンドル非混入の依存方向を維持)。
 */
import { timingSafeEqual } from "node:crypto";

export function tokenEquals(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  // defense-in-depth (SEC-1/QA-1/QA-1R・裁定 019f3ed6)。2 枝で falsifiability が異なる:
  //  - typeof 枝: 型を欠いた caller の undefined/null expected を throw (Buffer.from が TypeError)
  //    でなく clean deny にする — INV-TOKEN-EQUALS の undefined/null assert で **falsifiable**。
  //  - 空 string 枝: provided 非空保証 + 下の長さ不一致でも同じ false に落ちるため**単独では
  //    falsify 不能** (冗長・意味論の document)。全既存 caller は非空 string expected を保証済。
  if (typeof expected !== "string" || expected.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
