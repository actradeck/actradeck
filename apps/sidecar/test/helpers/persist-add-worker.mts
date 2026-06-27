/**
 * QA-3 ヘルパ (test only・vitest 非対象 = .mts): 別プロセスから ApprovalAllowlistStore.add を
 * 1 回呼ぶワーカー。inv-approval-allowlist-store.test.ts が **複数プロセスを並走**させ、
 * withFileLock のプロセス間直列化 (lost-update 防止) を実証するために spawn する。
 *
 * 入力は env で受ける (STORE_PATH / SIG / SCOPE / TTL_MS / NOW)。実 fs・実 store で副作用は
 * すべて os.tmpdir 配下 (呼び元がパスを与える)。
 */
import { ApprovalAllowlistStore } from "../../src/approval-allowlist-store.js";

const path = process.env.STORE_PATH;
const signature = process.env.SIG;
if (path === undefined || signature === undefined) {
  process.stderr.write("persist-add-worker: STORE_PATH and SIG are required\n");
  process.exit(2);
}

const repoScope = process.env.SCOPE ?? "scope0000001";
const ttlMs = Number(process.env.TTL_MS ?? 3_600_000);
const now = Number(process.env.NOW ?? Date.now());

const store = new ApprovalAllowlistStore({ path });
store.add({ signature, repoScope, risk: "medium", ttlMs, now });
process.exit(0);
