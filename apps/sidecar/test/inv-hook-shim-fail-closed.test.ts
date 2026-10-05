/**
 * INV-HOOK-SHIM-FAIL-CLOSED — PreToolUse command shim は daemon に届かない/応答が壊れている/設定が
 * 誤っているとき **exit 2 (block)** し、届いた 2xx JSON object だけを **逐語**で通す
 * (ADR 0016 `docs/adr/0016-pretooluse-command-shim-fail-closed.md`・Triangle ADR 01a108aa・SEC-FC-3)。
 *
 * ## なぜ実プロセスか
 * 上流 Claude Code が見るのは shim プロセスの **exit code と stdout/stderr の bytes** だけである。
 * in-process の関数戻り値が正しくても、main の結線 (exit code の伝搬・stdout の逐語書き出し・
 * stdin の読み取り・import 時に走らないガード) が壊れていれば gate は外れる。よって主 describe は
 * `src/hook-shim.ts` を **tsx で実プロセスとして起動**し (dist の鮮度に依存しない・変異が即反映される)、
 * 子の exit code / stdout bytes / stderr を表駆動で assert する (memory cross-process-test-needs-real-processes)。
 * 同じ表を in-process (`runHookShim`) にも流す parity describe はカバレッジ計測と、実プロセス側の
 * 結線だけが壊れたときの切り分け用 (どちらが RED かで main 結線か本体かが分かる)。
 *
 * ## NO-RAW
 * token 形の偽値を token file / env / request body (stdin) / response body / argv (endpoint の
 * userinfo・query) へ注入し、stderr と stdout (2xx 逐語ケース以外) に **不在** を assert する。
 * 各 negative には **同一リテラルの POSITIVE 対**を併設する: token と request body は daemon 側で
 * 実際に受け取ったこと (= 値が shim を通った)、response body の偽値は 2xx 逐語ケースの stdout に
 * 現れること (= 値が shim まで届いた)、固定文言は stderr に存在すること。
 *
 * ## 実行証跡
 * 表駆動ループの計測 callback 末尾でカウンタを加算し、file top-level の afterAll で表の件数と照合する
 * (`it.skip` 化・早期 return・加算行削除で RED)。CI 側の二段目は
 * `scripts/ci/assert-inv-ran.mjs --suite sidecar-hook-shim`。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  shimDeadlineMsFor,
  stripComments,
} from "@actradeck/event-model";

import { HOOK_MAX_BODY_BYTES } from "../src/hook-receiver.js";
import {
  HOOK_SHIM_CAUSES,
  HOOK_SHIM_MAX_DEADLINE_MS,
  HOOK_SHIM_MAX_INPUT_BYTES,
  HOOK_SHIM_TOKEN_HEADER,
  type HookShimCause,
  parseHookShimArgs,
  runHookShim,
} from "../src/hook-shim.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import { tsxBin } from "./helpers/lock-test-support.js";

const SHIM_SRC = fileURLToPath(new URL("../src/hook-shim.ts", import.meta.url));

// ---- NO-RAW の偽値 (token 形・チャネルごとに別値で、どこから漏れたか分かるようにする) ----
const FAKE_TOKEN_FILE = "adtok_FILE_7f3a9c1e5b2d4086a1c3e5f7092b4d6f";
const FAKE_TOKEN_ENV = "adtok_ENV_c4e6a8b0d2f41357a9cbedf0123456789";
const FAKE_REQ_SECRET = "adsec_REQBODY_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const FAKE_RESP_SECRET = "adsec_RESPBODY_f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1";
const FAKE_ARGV_SECRET = "adtok_ARGV_0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6";
const TOKEN_ENV_NAME = "ACTRADECK_TEST_SHIM_TOKEN";
/** stdout に出てはいけない偽値 (response の偽値は 2xx 逐語ケースでは出るのが正しいので別扱い)。 */
const NEVER_ON_STDOUT = [FAKE_TOKEN_FILE, FAKE_TOKEN_ENV, FAKE_REQ_SECRET, FAKE_ARGV_SECRET];
/** stderr に出てはいけない偽値 (全チャネル)。 */
const NEVER_ON_STDERR = [...NEVER_ON_STDOUT, FAKE_RESP_SECRET];

/** PreToolUse の hook JSON (request body)。秘密形の値を含める。 */
const HOOK_INPUT = Buffer.from(
  JSON.stringify({
    session_id: "s-shim",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `curl -H 'Authorization: token ${FAKE_REQ_SECRET}' https://x` },
  }),
);

/**
 * 2xx の逐語ケースで返す body。わざと空白・改行・キー順を JSON.stringify と変えておく
 * (shim が parse→stringify で再整形すると bytes が変わって RED になる)。
 */
const ALLOW_BODY = Buffer.from(
  `{ "hookSpecificOutput" : { "permissionDecision":"allow",  "hookEventName": "PreToolUse",\n` +
    `  "permissionDecisionReason": "ok ${FAKE_RESP_SECRET}" } }\n`,
);
const DENY_BODY = Buffer.from(
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",` +
    `"permissionDecisionReason":"denied by operator \\u00e9"}}`,
);

type Behavior =
  | { readonly kind: "none" } // listener 無し (bind して即 close した port)
  | {
      readonly kind: "respond";
      readonly status: number;
      readonly body: Buffer;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: "destroy" } // body を受け取った後、応答せずに socket を destroy
  | { readonly kind: "truncate" } // Content-Length より短い本文を送って socket を destroy
  | { readonly kind: "hang" }; // 応答しない (deadline 超過用)

interface ArgSpec {
  endpoint?: string | undefined;
  event?: string | undefined;
  deadlineMs?: string | undefined;
  tokenFile?: string | undefined;
  tokenEnv?: string | undefined;
  onUnreachable?: string | undefined;
  scope?: string | undefined;
  extra?: readonly string[];
}

interface Ctx {
  readonly port: number;
  readonly tokenFile: string;
  readonly dir: string;
}

interface Case {
  readonly name: string;
  readonly server: Behavior;
  /** 既定の args (token file + 実導出 deadline + scope user) を上書きする。 */
  readonly args?: (ctx: Ctx) => ArgSpec;
  readonly stdin?: Buffer;
  readonly env?: Readonly<Record<string, string>>;
  /** 成功時の期待 stdout (undefined = 無出力)。cause を持つケースでは使わない。 */
  readonly stdout?: Buffer | undefined;
  /** 失敗ケースの期待 cause。undefined = exit 0 の成功ケース。 */
  readonly cause?: HookShimCause | undefined;
  /** daemon が token と body を受け取ったはずのケース (POSITIVE 対の対象)。 */
  readonly reachesServer: boolean;
}

/** 既定 deadline は**実際に settings へ焼かれる導出値** (bad_args にならないことも同時に固定する)。 */
const DERIVED_DEADLINE_MS = String(shimDeadlineMsFor(DEFAULT_APPROVAL_TIMEOUT_MS));
const SHORT_DEADLINE_MS = "400";

function defaultSpec(ctx: Ctx): ArgSpec {
  return {
    endpoint: `http://127.0.0.1:${ctx.port}/hook`,
    event: "PreToolUse",
    deadlineMs: DERIVED_DEADLINE_MS,
    tokenFile: ctx.tokenFile,
    scope: "user",
  };
}

function toArgv(spec: ArgSpec): string[] {
  const out: string[] = [];
  const push = (flag: string, v: string | undefined): void => {
    if (v !== undefined) out.push(flag, v);
  };
  push("--endpoint", spec.endpoint);
  push("--event", spec.event);
  push("--deadline-ms", spec.deadlineMs);
  push("--token-file", spec.tokenFile);
  push("--token-env", spec.tokenEnv);
  push("--on-unreachable", spec.onUnreachable);
  push("--scope", spec.scope);
  out.push(...(spec.extra ?? []));
  return out;
}

const ok200 = (body: Buffer): Behavior => ({
  kind: "respond",
  status: 200,
  body,
  headers: { "Content-Type": "application/json" },
});

/** 主表。`allow` 変種は下で自動生成する (transport 失敗 → exit 0 無出力 / bad_args → 依然 block)。 */
const BASE_CASES: readonly Case[] = [
  // ---- transport 失敗 ----
  {
    name: "listener 無し (接続拒否)",
    server: { kind: "none" },
    cause: "unreachable",
    reachesServer: false,
  },
  {
    name: "403 (token 不一致)",
    server: { kind: "respond", status: 403, body: Buffer.from(`{"error":"${FAKE_RESP_SECRET}"}`) },
    cause: "unauthorized",
    reachesServer: true,
  },
  {
    name: "401",
    server: { kind: "respond", status: 401, body: Buffer.from("no") },
    cause: "unauthorized",
    reachesServer: true,
  },
  {
    name: "500",
    server: { kind: "respond", status: 500, body: Buffer.from(`boom ${FAKE_RESP_SECRET}`) },
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "302 (redirect は追わない)",
    server: {
      kind: "respond",
      status: 302,
      body: Buffer.alloc(0),
      headers: { Location: "http://127.0.0.1:1/hook" },
    },
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "2xx text (JSON でない)",
    server: { kind: "respond", status: 200, body: Buffer.from(`plain ${FAKE_RESP_SECRET}`) },
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "2xx JSON array (object でない)",
    server: ok200(Buffer.from(`["${FAKE_RESP_SECRET}"]`)),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "2xx JSON null",
    server: ok200(Buffer.from("null")),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "2xx 不正 UTF-8 の JSON",
    server: ok200(
      Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
    ),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "応答待ち中に server が socket を destroy",
    server: { kind: "destroy" },
    cause: "unreachable",
    reachesServer: true,
  },
  {
    name: "2xx 本文の途中で切断 (truncate)",
    server: { kind: "truncate" },
    cause: "unreachable",
    reachesServer: true,
  },
  {
    name: "deadline 超過 (server が応答しない)",
    server: { kind: "hang" },
    args: (ctx) => ({ ...defaultSpec(ctx), deadlineMs: SHORT_DEADLINE_MS }),
    cause: "deadline",
    reachesServer: true,
  },
  {
    name: "stdin が上限 +1 byte",
    server: ok200(Buffer.from("{}")),
    stdin: Buffer.alloc(HOOK_SHIM_MAX_INPUT_BYTES + 1, 0x20),
    cause: "input_too_large",
    reachesServer: false,
  },
  {
    name: "token file 不在",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), tokenFile: join(ctx.dir, "missing.token") }),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    // root でも読めない形 (chmod 000 は root に効かない): path がディレクトリ。
    name: "token file 読取不可 (ディレクトリ)",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), tokenFile: join(ctx.dir, "token-dir") }),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token file が空",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), tokenFile: join(ctx.dir, "empty.token") }),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token env 未設定",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), tokenFile: undefined, tokenEnv: TOKEN_ENV_NAME }),
    cause: "token_unavailable",
    reachesServer: false,
  },
  // ---- 引数不正 (allow 変種でも block のまま) ----
  {
    name: "非 loopback endpoint",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), endpoint: `http://10.255.255.1:${ctx.port}/hook` }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "https endpoint",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), endpoint: `https://127.0.0.1:${ctx.port}/hook` }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint に userinfo (偽値入り)",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({
      ...defaultSpec(ctx),
      endpoint: `http://u:${FAKE_ARGV_SECRET}@127.0.0.1:${ctx.port}/hook`,
    }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint に query (偽値入り)",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({
      ...defaultSpec(ctx),
      endpoint: `http://127.0.0.1:${ctx.port}/hook?t=${FAKE_ARGV_SECRET}`,
    }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "未知の --on-unreachable 値",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), onUnreachable: "maybe" }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--event が PreToolUse 以外",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), event: "PermissionRequest" }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--token-file と --token-env の両方",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), tokenEnv: TOKEN_ENV_NAME }),
    env: { [TOKEN_ENV_NAME]: FAKE_TOKEN_ENV },
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--deadline-ms が上限超過",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), deadlineMs: String(HOOK_SHIM_MAX_DEADLINE_MS + 1) }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--deadline-ms が 0",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), deadlineMs: "0" }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "未知の flag",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), extra: ["--verbose", "1"] }),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "未知の --scope 値 (偽値)",
    server: ok200(Buffer.from("{}")),
    args: (ctx) => ({ ...defaultSpec(ctx), scope: FAKE_ARGV_SECRET }),
    cause: "bad_args",
    reachesServer: false,
  },
  // ---- 成功 (daemon の判断を逐語で通す) ----
  {
    name: "2xx {}",
    server: ok200(Buffer.from("{}")),
    stdout: Buffer.from("{}"),
    reachesServer: true,
  },
  {
    name: "2xx allow JSON (逐語)",
    server: ok200(ALLOW_BODY),
    stdout: ALLOW_BODY,
    reachesServer: true,
  },
  {
    name: "2xx deny JSON (逐語)",
    server: ok200(DENY_BODY),
    stdout: DENY_BODY,
    reachesServer: true,
  },
  { name: "2xx 空 body (no opinion)", server: ok200(Buffer.alloc(0)), reachesServer: true },
  {
    name: "token env 経由で 2xx deny",
    server: ok200(DENY_BODY),
    args: (ctx) => ({ ...defaultSpec(ctx), tokenFile: undefined, tokenEnv: TOKEN_ENV_NAME }),
    env: { [TOKEN_ENV_NAME]: FAKE_TOKEN_ENV },
    stdout: DENY_BODY,
    reachesServer: true,
  },
  {
    name: "stdin がちょうど上限 (daemon と同値まで転送する)",
    server: ok200(Buffer.from("{}")),
    stdin: Buffer.alloc(HOOK_SHIM_MAX_INPUT_BYTES, 0x20),
    stdout: Buffer.from("{}"),
    reachesServer: true,
  },
  {
    name: "--on-unreachable block の明示",
    server: ok200(DENY_BODY),
    args: (ctx) => ({ ...defaultSpec(ctx), onUnreachable: "block" }),
    stdout: DENY_BODY,
    reachesServer: true,
  },
];

/**
 * `--on-unreachable allow` 変種: transport 失敗 (bad_args 以外) は exit 0 無出力 = HTTP フック時代と
 * 同じ素通り、bad_args は kill-switch でも block のまま。args を上書きしていて既に
 * `--on-unreachable` を指定しているケース (未知値) は変種を作らない。
 */
const ALLOW_CASES: readonly Case[] = BASE_CASES.filter((c) => c.cause !== undefined)
  .filter((c) => c.args === undefined || c.args(DUMMY_CTX()).onUnreachable === undefined)
  .map((c) => ({
    ...c,
    name: `[allow] ${c.name}`,
    args: (ctx: Ctx) => ({ ...(c.args ?? defaultSpec)(ctx), onUnreachable: "allow" }),
    cause: c.cause === "bad_args" ? "bad_args" : undefined,
    stdout: undefined,
  }));

function DUMMY_CTX(): Ctx {
  return { port: 1, tokenFile: "/nonexistent", dir: "/nonexistent" };
}

const CASES: readonly Case[] = [...BASE_CASES, ...ALLOW_CASES];

// ---- server ----
interface Seen {
  token: string | undefined;
  body: Buffer;
}

async function startServer(behavior: Behavior): Promise<{
  port: number;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = req.headers[HOOK_TOKEN_HEADER.toLowerCase()];
      seen.push({ token: Array.isArray(raw) ? raw[0] : raw, body: Buffer.concat(chunks) });
      switch (behavior.kind) {
        case "respond":
          res.writeHead(behavior.status, behavior.headers ?? {});
          res.end(behavior.body);
          return;
        case "destroy":
          req.socket.destroy();
          return;
        case "truncate":
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
          res.write('{"hookSpecificOutput":');
          setTimeout(() => req.socket.destroy(), 20);
          return;
        default:
          return; // hang: 応答しない
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const close = (): Promise<void> =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  if (behavior.kind === "none") await close(); // 接続拒否される port を作る
  return { port, seen, close: behavior.kind === "none" ? async () => undefined : close };
}

// ---- 実行 ----
interface Outcome {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * 起動した shim の後始末 (孤児を残さない)。
 *
 * tsx の CLI は shim 本体を**子の node** として起動する (孫)。CLI の pid だけを kill しても孫は
 * 残り、systemd --user 等へ付け替わって deadline (既定導出 315s) まで生き続ける。変異や assert 失敗で
 * test が timeout すると `close` を待つ Promise ごと放置されるので、正常終了に頼らず
 * **プロセスグループ単位** (`detached: true` で新グループ・`process.kill(-pgid, "SIGKILL")`) で止め、
 * グループと観測できた全子孫の pid が `ESRCH` であることを assert する
 * (前例: inv-approval-fail-closed.test.ts の crash-chain worker・QA-FC-R2-1)。
 */
const spawnedAll: number[] = [];
let spawnedThisTest: number[] = [];
/**
 * afterEach の**後半**で閉じる server。保留ケースは server を test 内で閉じない: 閉じると接続断で
 * shim が `unreachable` として自分で exit し、後始末の kill が無くても緑になる (変異で実測)。
 */
let closeAfterCleanup: Array<() => Promise<void>> = [];

/** Linux の /proc から子孫 pid を集める (/proc が無い環境では空 = グループ検査だけになる)。 */
function descendantsOf(pid: number): number[] {
  const out: number[] = [];
  const walk = (p: number): void => {
    const path = `/proc/${p}/task/${p}/children`;
    if (!existsSync(path)) return;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const tok of text.trim().split(/\s+/)) {
      const c = Number(tok);
      if (Number.isInteger(c) && c > 0) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(pid);
  return out;
}

function isGone(target: number): boolean {
  try {
    process.kill(target, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** グループを SIGKILL で止める (既に居なければ何もしない)。 */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* 既に終了 */
  }
}

/** グループ (-pgid) と各 pid が ESRCH になるまで待ち、残れば名指しで落とす。 */
async function expectAllGone(pgid: number, pids: readonly number[]): Promise<void> {
  const targets = [-pgid, pgid, ...pids];
  for (let i = 0; i < 300 && !targets.every(isGone); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const alive = targets.filter((t) => !isGone(t));
  expect(alive, `shim processes survived cleanup (group ${pgid})`).toEqual([]);
}

/** 1 本の shim を新しいプロセスグループで起動し、後始末の対象に登録する。 */
function spawnShim(argv: readonly string[], env: Readonly<Record<string, string>>) {
  // 親 env を継承しない (偽 token env が既定で漏れ込まない・必要な PATH だけ渡す)。
  const child = spawn(tsxBin, [SHIM_SRC, ...argv], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid !== undefined) {
    spawnedAll.push(child.pid);
    spawnedThisTest.push(child.pid);
  }
  return child;
}

afterEach(async () => {
  const groups = spawnedThisTest;
  spawnedThisTest = [];
  const closers = closeAfterCleanup;
  closeAfterCleanup = [];
  try {
    // 全グループを先に止める (1 つの assert 失敗で残りの kill を飛ばさない)。子孫は kill の前に採る。
    const observed = groups.map((pgid) => ({ pgid, descendants: descendantsOf(pgid) }));
    for (const { pgid } of observed) killGroup(pgid);
    for (const { pgid, descendants } of observed) await expectAllGone(pgid, descendants);
  } finally {
    for (const close of closers) await close();
  }
});

function runProcess(
  argv: readonly string[],
  stdin: Buffer,
  env: Readonly<Record<string, string>>,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawnShim(argv, env);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.stdin.on("error", () => undefined); // 上限超過で shim が先に終われば EPIPE になる
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.end(stdin);
  });
}

async function runInProcess(
  argv: readonly string[],
  stdin: Buffer,
  env: Readonly<Record<string, string>>,
): Promise<Outcome> {
  const r = await runHookShim(argv, { stdin: Readable.from([stdin]), env });
  return { code: r.exitCode, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? "" };
}

let workDir = "";
let tokenFilePath = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "actradeck-hook-shim-"));
  tokenFilePath = join(workDir, "hook.token");
  writeFileSync(tokenFilePath, `${FAKE_TOKEN_FILE}\n`, { mode: 0o600 });
  writeFileSync(join(workDir, "empty.token"), "", { mode: 0o600 });
  mkdirSync(join(workDir, "token-dir"));
});

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

function expectedTokenFor(spec: ArgSpec, env: Readonly<Record<string, string>>): string {
  return spec.tokenEnv !== undefined ? (env[spec.tokenEnv] ?? "") : FAKE_TOKEN_FILE;
}

async function check(c: Case, run: typeof runProcess): Promise<void> {
  const srv = await startServer(c.server);
  try {
    const ctx: Ctx = { port: srv.port, tokenFile: tokenFilePath, dir: workDir };
    const spec = (c.args ?? defaultSpec)(ctx);
    const env = c.env ?? {};
    const stdin = c.stdin ?? HOOK_INPUT;
    const argv = toArgv(spec);
    if (argv.some((a) => a.includes(FAKE_ARGV_SECRET))) executed.argvSecretCases += 1;
    const started = Date.now();
    const r = await run(argv, stdin, env);
    const elapsed = Date.now() - started;

    if (c.cause === undefined) {
      // 成功 / allow 変種: exit 0・stderr 無し・stdout は期待 bytes と逐語一致 (無出力含む)。
      expect(r.code, `${c.name}: exit code (stderr=${r.stderr})`).toBe(0);
      expect(r.stderr, c.name).toBe("");
      expect(r.stdout.equals(c.stdout ?? Buffer.alloc(0)), `${c.name}: stdout bytes`).toBe(true);
    } else {
      // block: exit 2・stdout 無出力・stderr の cause が closed enum の期待値と一致。
      expect(r.code, `${c.name}: exit code`).toBe(2);
      expect(r.stdout.length, `${c.name}: stdout must be empty on block`).toBe(0);
      const causes = [...r.stderr.matchAll(/cause=([a-z_]+)/g)].map((m) => m[1]);
      expect(causes, `${c.name}: stderr cause`).toEqual([c.cause]);
      // POSITIVE (固定文言の存在)
      expect(r.stderr).toContain("actradeck hook-shim: blocked PreToolUse");
      expect(r.stderr).toContain("agentmon daemon stop");
      if (c.cause === "bad_args") {
        // 検証前の argv (endpoint / scope) を echo しない。
        expect(r.stderr).not.toContain("endpoint:");
        expect(r.stderr).not.toContain("--scope");
        expect(r.stderr).toContain("agentmon daemon start");
      } else {
        expect(r.stderr).toContain(`endpoint: http://127.0.0.1:${srv.port}/hook`);
        expect(r.stderr).toContain("agentmon daemon start --scope user");
        expect(r.stderr).toContain("--on-unreachable allow");
      }
    }

    // NO-RAW: 偽値は stderr のどこにも出ない / stdout には response の逐語以外で出ない。
    for (const secret of NEVER_ON_STDERR)
      expect(r.stderr, `${c.name}: stderr leak`).not.toContain(secret);
    const stdoutText = r.stdout.toString("utf8");
    for (const secret of NEVER_ON_STDOUT)
      expect(stdoutText, `${c.name}: stdout leak`).not.toContain(secret);
    if (c.stdout === undefined || !c.stdout.includes(FAKE_RESP_SECRET)) {
      expect(stdoutText, `${c.name}: response body leak`).not.toContain(FAKE_RESP_SECRET);
    } else {
      // POSITIVE 対: response の偽値は逐語ケースでは届いている (= 上の negative は到達可能な値を見ている)。
      expect(stdoutText).toContain(FAKE_RESP_SECRET);
    }

    // POSITIVE 対 (token / request body): daemon が実際に受け取ったこと。
    if (c.reachesServer) {
      expect(srv.seen.length, `${c.name}: daemon reached once`).toBe(1);
      const seen = srv.seen[0];
      expect(seen?.token, `${c.name}: token header`).toBe(expectedTokenFor(spec, env));
      expect(seen?.body.equals(stdin), `${c.name}: request body forwarded verbatim`).toBe(true);
      if (stdin === HOOK_INPUT) expect(seen?.body.toString("utf8")).toContain(FAKE_REQ_SECRET);
    } else {
      expect(srv.seen.length, `${c.name}: daemon must not be reached`).toBe(0);
    }

    // deadline は実際に deadline 付近で切れている (CC の timeout まで待たない)。
    if (spec.deadlineMs === SHORT_DEADLINE_MS) expect(elapsed).toBeLessThan(10_000);
  } finally {
    await srv.close();
  }
}

/**
 * 実行証跡は **file top-level** の afterAll で照合する。describe 内の afterAll は、その describe の
 * test が全部 skip されると vitest が呼ばない (変異 `it` → `it.skip` で実測: 内側 afterAll では
 * 素通りした)。top-level なら結合 describe の test が 1 本でも走れば呼ばれる。
 */
const executed = { process: 0, inProcess: 0, argvSecretCases: 0, hold: 0 };
afterAll(() => {
  expect(executed.process, "every table case must have run (real process)").toBe(CASES.length);
  expect(executed.inProcess, "every table case must have run (in-process)").toBe(CASES.length);
  expect(executed.hold, "the hold case must have run").toBe(1);
  // 起動した全 shim (正常終了・timeout・失敗のどれでも) のグループが残っていない。
  // 件数の下限: 表 × 実プロセス + 保留ケース 1 本 (空振りで恒真にならない)。
  expect(spawnedAll.length).toBeGreaterThanOrEqual(CASES.length + 1);
  expect(spawnedAll.filter((pgid) => !isGone(-pgid))).toEqual([]);
  // POSITIVE 対 (argv の偽値): 偽値を argv に載せたケースが実際に shim へ渡っている。
  expect(executed.argvSecretCases).toBeGreaterThanOrEqual(12);
});

describe("INV-HOOK-SHIM-FAIL-CLOSED: 実 shim プロセス (exit code / stdout bytes / stderr cause)", () => {
  for (const c of CASES) {
    it(c.name, { timeout: 30_000 }, async () => {
      await check(c, runProcess);
      executed.process += 1;
    });
  }
});

describe("INV-HOOK-SHIM-FAIL-CLOSED: 承認保留中の shim と後始末", () => {
  /**
   * daemon が承認を握っている間 (応答しない間)、shim は導出 deadline (315s) まで待ち続け、先に
   * 諦めない (諦めると承認待ち中に block = operator の承認が効かない)。同時にこれは「test が先に
   * 終わったとき shim が生きている」形そのもので、afterEach がグループごと止めて孫の node まで
   * ESRCH を確認する (後始末の kill を消すと afterEach が RED)。
   */
  it("承認保留中は導出 deadline まで待ち続ける (先に exit しない)・後始末が孫まで止める", async () => {
    const srv = await startServer({ kind: "hang" });
    // server は afterEach が shim を止めて ESRCH を確認した**後**に閉じる (上の closeAfterCleanup)。
    closeAfterCleanup.push(srv.close);
    const ctx: Ctx = { port: srv.port, tokenFile: tokenFilePath, dir: workDir };
    const child = spawnShim(toArgv(defaultSpec(ctx)), {});
    let exited = false;
    child.on("exit", () => (exited = true));
    child.stdin.on("error", () => undefined);
    child.stdin.end(HOOK_INPUT);
    for (let i = 0; i < 1000 && srv.seen.length === 0 && !exited; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(srv.seen.length, "the shim reached the daemon").toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(exited, "the shim must keep waiting while the daemon holds the approval").toBe(false);
    // POSITIVE: 本体は孫の node (tsx CLI の子) であり、後始末はその pid も対象に含む。
    if (process.platform === "linux" && child.pid !== undefined) {
      expect(descendantsOf(child.pid).length).toBeGreaterThanOrEqual(1);
    }
    executed.hold += 1;
  });
});

describe("INV-HOOK-SHIM-FAIL-CLOSED: in-process parity (同じ表を runHookShim に流す)", () => {
  for (const c of CASES) {
    it(c.name, { timeout: 30_000 }, async () => {
      await check(c, runInProcess);
      executed.inProcess += 1;
    });
  }
});

describe("INV-HOOK-SHIM-FAIL-CLOSED: daemon / 単一出所との結合", () => {
  it("token ヘッダ名は daemon が照合する HOOK_TOKEN_HEADER と同値", () => {
    expect(HOOK_SHIM_TOKEN_HEADER).toBe(HOOK_TOKEN_HEADER);
  });

  it("stdin 上限は daemon の受信上限と同値 (4MB)", () => {
    expect(HOOK_SHIM_MAX_INPUT_BYTES).toBe(HOOK_MAX_BODY_BYTES);
    expect(HOOK_SHIM_MAX_INPUT_BYTES).toBe(4 * 1024 * 1024);
  });

  it("shimDeadlineMsFor の値域はすべて shim の --deadline-ms で受理され、CC の既定 600s を超えない", () => {
    expect(HOOK_SHIM_MAX_DEADLINE_MS).toBeLessThanOrEqual(600_000);
    for (const approval of [DEFAULT_APPROVAL_TIMEOUT_MS, MAX_APPROVAL_TIMEOUT_MS, 1, Number.NaN]) {
      const deadline = shimDeadlineMsFor(approval);
      expect(deadline).toBeLessThanOrEqual(HOOK_SHIM_MAX_DEADLINE_MS);
      const parsed = parseHookShimArgs([
        "--endpoint",
        "http://127.0.0.1:1/hook",
        "--event",
        "PreToolUse",
        "--deadline-ms",
        String(deadline),
        "--token-env",
        TOKEN_ENV_NAME,
      ]);
      expect(parsed.deadlineMs).toBe(deadline);
      expect(parsed.onUnreachable).toBe("block"); // 省略時の既定は block
    }
  });

  it("loopback 3 形 (127.0.0.1 / localhost / [::1]) は受理する", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const parsed = parseHookShimArgs([
        "--endpoint",
        `http://${host}:4242/hook`,
        "--event",
        "PreToolUse",
        "--deadline-ms",
        "1000",
        "--token-env",
        TOKEN_ENV_NAME,
      ]);
      expect(parsed.displayEndpoint).toBe(`http://${host}:4242/hook`);
    }
  });

  it("表の構成: ケース名は相異・allow 変種は transport 失敗の全件 + bad_args を覆う", () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
    // allow 変種のうち block のまま残るのは bad_args だけ (transport 失敗は素通りへ戻る)。
    const allowBlocked = ALLOW_CASES.filter((c) => c.cause !== undefined).map((c) => c.cause);
    expect(new Set(allowBlocked)).toEqual(new Set(["bad_args"]));
    const transportBase = BASE_CASES.filter(
      (c) => c.cause !== undefined && c.cause !== "bad_args",
    ).length;
    expect(ALLOW_CASES.filter((c) => c.cause === undefined).length).toBe(transportBase);
    expect(transportBase).toBeGreaterThanOrEqual(15);
  });

  it("cause の closed enum は 7 語で固定 (stderr に出してよい分類語彙)", () => {
    expect([...HOOK_SHIM_CAUSES].sort()).toEqual(
      [
        "bad_args",
        "bad_response",
        "deadline",
        "input_too_large",
        "token_unavailable",
        "unauthorized",
        "unreachable",
      ].sort(),
    );
    // 表は enum の全語を少なくとも 1 回ずつ実プロセスで踏む。
    const exercised = new Set(BASE_CASES.map((c) => c.cause).filter((x) => x !== undefined));
    expect([...exercised].sort()).toEqual([...HOOK_SHIM_CAUSES].sort());
  });

  it("runtime import は node:* のみ (event-model / redaction / 相対 import を持たない)", () => {
    const src = stripComments(readFileSync(SHIM_SRC, "utf8"));
    const specifiers = [
      ...src.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...src.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((m) => m[1] ?? "");
    // POSITIVE: 走査は実際に import を拾っている (空振りで恒真にならない)。
    expect(specifiers).toContain("node:http");
    for (const s of specifiers) expect(s, `import ${s}`).toMatch(/^node:/);
  });
});
