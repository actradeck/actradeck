/**
 * INV-APPROVAL-FAIL-CLOSED ヘルパ (test only・vitest 非対象 = .mts): 本番 attach daemon と同じく
 * **unhandledRejection / uncaughtException のハンドラを持たない**子プロセスで、実 HookReceiver +
 * 実 ApprovalBridge を listen する (SEC-FC-1 の再現環境)。
 *
 * sink は `tool.permission.resolved` の emit で throw する。最初に出た承認カードは 100ms 後に
 * 「operator」が allow で解決する。応答を書いた**後**に resolved の emit が失敗するので、
 * 失敗経路が同じ応答へ二度目の書込を試みると `ERR_HTTP_HEADERS_SENT` が未処理 rejection になり、
 * このプロセスは落ちる (= 並走中の承認待ちが接続断で返り、上流契約上ツールが承認なしで実行される)。
 *
 * 起動後、標準出力へ次の行を出し、kill されるまで生き続ける (テストが前提を assert する・QA-FC-R2-2):
 * - `PID <n>`: 本 worker 自身の pid (tsx CLI の pid とは別。終了確認に使う・QA-FC-R2-1)。
 * - `NETS <n>`: unhandledRejection + uncaughtException の listener 数 (0 であること = 本番 daemon と同条件)。
 * - `UNHANDLED <mode>`: `--unhandled-rejections` の指定 (無ければ `default`)。`warn` / `none` だと落ちない。
 * - `PORT <n>`: listen したポート。
 * - `THROW`: resolved の emit で throw するたびに 1 行。
 */
import { ApprovalBridge } from "../../src/approval-bridge.js";
import { HookReceiver } from "../../src/hook-receiver.js";
import type { EventSink } from "../../src/sink.js";

const bridge = new ApprovalBridge({ timeoutMs: 1500 });
let approvedFirst = false;
const sink = {
  emit(ev: { event_type: string; payload: { request_id?: string } }) {
    if (ev.event_type === "tool.permission.resolved") {
      process.stdout.write("THROW\n");
      throw new Error("resolved sink failure");
    }
    if (ev.event_type === "tool.permission.requested" && !approvedFirst) {
      approvedFirst = true;
      const id = ev.payload.request_id;
      if (id !== undefined) setTimeout(() => bridge.resolve(id, "allow", "operator"), 100);
    }
    return ev;
  },
} as unknown as EventSink;

const unhandledFlag = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)]
  .map((a) => /^--unhandled-rejections=(.+)$/.exec(a)?.[1])
  .find((v) => v !== undefined);
const nets =
  process.listenerCount("unhandledRejection") + process.listenerCount("uncaughtException");
process.stdout.write(`PID ${process.pid}\nNETS ${nets}\nUNHANDLED ${unhandledFlag ?? "default"}\n`);

const receiver = new HookReceiver({ sink, approvalBridge: bridge });
const port = await receiver.listen();
process.stdout.write(`PORT ${port}\n`);
setInterval(() => {}, 1 << 30);
