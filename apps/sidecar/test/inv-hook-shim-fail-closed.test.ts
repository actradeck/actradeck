/**
 * INV-HOOK-SHIM-FAIL-CLOSED — PreToolUse command shim は daemon に届かない/応答が壊れている/設定が
 * 誤っているとき **exit 2 (block)** し、daemon が返した 200 JSON object だけを **逐語**で通す
 * (ADR 0016 `docs/adr/0016-pretooluse-command-shim-fail-closed.md`・Triangle ADR 01a108aa・
 * R1 裁定 01a10c76・SEC-FC-3)。
 *
 * ## なぜ実プロセスか
 * 上流 Claude Code が見るのは shim プロセスの **exit code と stdout/stderr の bytes** だけである。
 * in-process の関数戻り値が正しくても、entry の結線 (exit code の伝搬・stdout の逐語書き出しと
 * 書込み失敗・stdin の読み取り) が壊れていれば gate は外れる。よって主 describe は entry
 * `src/hook-shim.ts` を **tsx で実プロセスとして起動**し (dist の鮮度に依存しない・変異が即反映される)、
 * 子の exit code / stdout bytes / stderr を表駆動で assert する (memory cross-process-test-needs-real-processes)。
 * 同じ表を in-process (`runHookShim`) にも流す parity describe はカバレッジ計測と、entry の結線だけが
 * 壊れたときの切り分け用 (どちらが RED かで結線か本体かが分かる)。
 *
 * ## 表の軸
 * 失敗源 (transport / 応答の形 / stdin / token / 引数) × token の取得方法 (file / env) ×
 * `--on-unreachable` (block / allow) × 成功 (200 JSON の逐語転送)。env と allow の変種は基底行から
 * 生成する (QA-HS-1 / QA-HS-3)。
 *
 * ## stderr (SEC-HS-3)
 * exit 2 の stderr は Claude 本体に deny 理由として渡るので、cause と固定文だけ。期待値は
 * **全文の逐語一致**で固定し (product 側の定数を import せず test 側に文面を書く)、加えて gate を外す
 * 手順の語彙 (停止・再起動コマンド・kill-switch 名・endpoint) が無いことを negative で見る。各 negative
 * には同一リテラルの POSITIVE 対がある (argv に載せた値の搬送カウンタ・実 CLI の語彙)。
 *
 * ## NO-RAW
 * token 形の偽値を token file / env / request body (stdin) / response body / argv (endpoint の
 * userinfo・query・path、未知 flag の値) へ注入し、stderr と stdout (逐語ケース以外) に **不在** を
 * assert する。POSITIVE 対: token と request body は daemon 側で実際に受け取ったこと、response body の
 * 偽値は逐語ケースの stdout に現れること、argv の偽値は shim に渡したこと (搬送カウンタ)。
 *
 * ## 実行証跡
 * 表駆動ループの計測 callback 末尾でカウンタを加算し、file top-level の afterAll で表の件数と照合する
 * (`it.skip` 化・早期 return・加算行削除で RED)。CI 側の二段目は
 * `scripts/ci/assert-inv-ran.mjs --suite sidecar-hook-shim`。
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  MIN_APPROVAL_TIMEOUT_MS,
  shimDeadlineMsFor,
  stripComments,
} from "@actradeck/event-model";

import { isUsableHookToken, parseDaemonArgs } from "../src/daemon-cli.js";
import { HOOK_MAX_BODY_BYTES, HookReceiver } from "../src/hook-receiver.js";
import {
  HOOK_SHIM_CAUSES,
  HOOK_SHIM_MAX_DEADLINE_MS,
  HOOK_SHIM_MAX_INPUT_BYTES,
  HOOK_SHIM_MAX_RESPONSE_BYTES,
  HOOK_SHIM_MAX_TOKEN_FILE_BYTES,
  HOOK_SHIM_MAX_TOKEN_LENGTH,
  HOOK_SHIM_TOKEN_HEADER,
  type HookShimCause,
  parseHookShimArgs,
  runHookShim,
} from "../src/hook-shim-core.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import { HOOK_TOKEN_ENV_VAR } from "../src/settings-merge.js";
import { tsxBin } from "./helpers/lock-test-support.js";

/** CC が起動する entry (判定なしで常に main を走らせる・SEC-HS-2)。 */
const SHIM_ENTRY = fileURLToPath(new URL("../src/hook-shim.ts", import.meta.url));
const SHIM_CORE = fileURLToPath(new URL("../src/hook-shim-core.ts", import.meta.url));

// ---- NO-RAW の偽値 (token 形・チャネルごとに別値で、どこから漏れたか分かるようにする) ----
const FAKE_TOKEN_FILE = "adtok_FILE_7f3a9c1e5b2d4086a1c3e5f7092b4d6f";
const FAKE_TOKEN_ENV = "adtok_ENV_c4e6a8b0d2f41357a9cbedf0123456789";
const FAKE_REQ_SECRET = "adsec_REQBODY_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const FAKE_RESP_SECRET = "adsec_RESPBODY_f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1";
const FAKE_ARGV_SECRET = "adtok_ARGV_0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6";
const TOKEN_ENV_NAME = "ACTRADECK_TEST_SHIM_TOKEN";
/** daemon の `isUsableHookToken` の境界 (許可文字全種・最短 32 / 最長 1024)。 */
const USABLE_TOKEN_MIN = "Az09._~+/=-" + "b".repeat(21);
const USABLE_TOKEN_MAX = "Az09._~+/=-" + "c".repeat(1013);
/** stdout に出てはいけない偽値 (response の偽値は逐語ケースでは出るのが正しいので別扱い)。 */
const NEVER_ON_STDOUT = [FAKE_TOKEN_FILE, FAKE_TOKEN_ENV, FAKE_REQ_SECRET, FAKE_ARGV_SECRET];
/** stderr に出てはいけない偽値 (全チャネル)。 */
const NEVER_ON_STDERR = [...NEVER_ON_STDOUT, FAKE_RESP_SECRET];

/**
 * block 時の stderr の固定文 (cause 行の次の行)。product の定数を import せずここに書く:
 * 文面を変える編集はこの test の更新を強制する。
 */
const BLOCK_SENTENCE =
  "This tool call was blocked because ActraDeck could not get an approval decision for it. " +
  "Ask the user to check the ActraDeck daemon; do not change ActraDeck settings or processes yourself.";
const expectedStderr = (cause: HookShimCause): string =>
  `actradeck hook-shim: blocked PreToolUse (cause=${cause})\n${BLOCK_SENTENCE}\n`;

/**
 * stderr に出てはいけない「gate を外す/迂回する手順」の語彙 (SEC-HS-3)。POSITIVE 対は
 * `ARGV_CARRIED` (argv に載せて shim に渡した) と、結合 describe の実 CLI 語彙の test。
 */
const GATE_VOCAB_NEVER_ON_STDERR = [
  "agentmon",
  "daemon start",
  "daemon stop",
  "--scope",
  "--on-unreachable",
  "127.0.0.1",
  "endpoint",
  "/hook",
];
/** argv に載ることを数える語 (上の negative の POSITIVE 対)。 */
const ARGV_CARRIED = ["--on-unreachable", "127.0.0.1", "endpoint", "/hook", FAKE_ARGV_SECRET];

/** PreToolUse の hook JSON (request body)。秘密形の値を含める。 */
const HOOK_INPUT = Buffer.from(
  JSON.stringify({
    session_id: "s-shim",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `curl -H 'Authorization: token ${FAKE_REQ_SECRET}' https://x` },
  }),
);
/** 早期失敗でも stdin を読み切ることを見る大きな入力 (書き手側の EPIPE・SEC-HS-10)。 */
const BIG_INPUT = Buffer.alloc(1024 * 1024, 0x20);

/**
 * 逐語ケースで返す body。わざと空白・改行・キー順を JSON.stringify と変えておく
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
/** ちょうど `bytes` bytes の JSON object (応答上限の境界)。 */
function jsonObjectOfSize(bytes: number): Buffer {
  return Buffer.from(`{"a":"${"x".repeat(bytes - 8)}"}`);
}

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
  extra?: readonly string[] | undefined;
}

interface Ctx {
  readonly port: number;
  readonly dir: string;
}

interface Case {
  readonly name: string;
  readonly server: Behavior;
  /** 既定の args (token file + 実導出 deadline) を上書きする。 */
  readonly args?: ((ctx: Ctx) => ArgSpec) | undefined;
  readonly stdin?: Buffer | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** 成功時の期待 stdout。cause を持つケースでは使わない。 */
  readonly stdout?: Buffer | undefined;
  /** 失敗ケースの期待 cause。undefined = exit 0 のケース。 */
  readonly cause?: HookShimCause | undefined;
  /** daemon が token と body を受け取ったはずのケース (POSITIVE 対の対象)。 */
  readonly reachesServer: boolean;
  /** daemon が受け取るはずの token (省略時は args から決める)。 */
  readonly expectedToken?: string | undefined;
  /** 経過時間の下限・上限 (ms)。deadline の相対境界と、塞がらないことの確認に使う。 */
  readonly minElapsedMs?: number | undefined;
  readonly maxElapsedMs?: number | undefined;
  /** 実プロセスだけで流す (in-process で変異が詰まると worker ごと止まるもの)。 */
  readonly processOnly?: boolean | undefined;
  /** 変種の生成元にする (env = token を env から読む版 / allow = kill-switch 版)。 */
  readonly envVariant?: boolean | undefined;
  readonly allowVariant?: boolean | undefined;
}

/** 既定 deadline は**実際に settings へ焼かれる導出値** (bad_args にならないことも同時に固定する)。 */
const DERIVED_DEADLINE_MS = String(shimDeadlineMsFor(DEFAULT_APPROVAL_TIMEOUT_MS));
const SHORT_DEADLINE_MS = 600;

function tok(ctx: Ctx, name: string): string {
  return join(ctx.dir, name);
}

function defaultSpec(ctx: Ctx): ArgSpec {
  return {
    endpoint: `http://127.0.0.1:${ctx.port}/hook`,
    event: "PreToolUse",
    deadlineMs: DERIVED_DEADLINE_MS,
    tokenFile: tok(ctx, "hook.token"),
  };
}

function withSpec(patch: (ctx: Ctx) => ArgSpec): (ctx: Ctx) => ArgSpec {
  return (ctx) => ({ ...defaultSpec(ctx), ...patch(ctx) });
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
  out.push(...(spec.extra ?? []));
  return out;
}

const ok200 = (body: Buffer): Behavior => ({
  kind: "respond",
  status: 200,
  body,
  headers: { "Content-Type": "application/json" },
});
const OK_EMPTY_OBJECT = ok200(Buffer.from("{}"));

/** 主表。env / allow の変種は下で生成する。 */
const BASE_CASES: readonly Case[] = [
  // ---- transport (token は読めている) ----
  {
    name: "listener 無し (接続拒否)",
    server: { kind: "none" },
    cause: "unreachable",
    reachesServer: false,
    envVariant: true,
    allowVariant: true,
  },
  {
    name: "403 (token 不一致)",
    server: { kind: "respond", status: 403, body: Buffer.from(`{"error":"${FAKE_RESP_SECRET}"}`) },
    cause: "unauthorized",
    reachesServer: true,
    envVariant: true,
    allowVariant: true,
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
    envVariant: true,
    allowVariant: true,
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
    name: "204 (daemon は返さない形)",
    server: { kind: "respond", status: 204, body: Buffer.alloc(0) },
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "201 + JSON object (200 以外の 2xx)",
    server: { kind: "respond", status: 201, body: DENY_BODY },
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "200 text (JSON でない)",
    server: { kind: "respond", status: 200, body: Buffer.from(`plain ${FAKE_RESP_SECRET}`) },
    cause: "bad_response",
    reachesServer: true,
    envVariant: true,
  },
  {
    name: "200 JSON array (object でない)",
    server: ok200(Buffer.from(`["${FAKE_RESP_SECRET}"]`)),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "200 JSON null",
    server: ok200(Buffer.from("null")),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "200 不正 UTF-8 の JSON",
    server: ok200(
      Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
    ),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "200 BOM 付き deny JSON",
    server: ok200(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), DENY_BODY])),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "200 空 body (daemon は返さない形)",
    server: ok200(Buffer.alloc(0)),
    cause: "bad_response",
    reachesServer: true,
    allowVariant: true,
  },
  {
    name: "200 JSON object が応答上限 +1 byte",
    server: ok200(jsonObjectOfSize(HOOK_SHIM_MAX_RESPONSE_BYTES + 1)),
    cause: "bad_response",
    reachesServer: true,
  },
  {
    name: "応答待ち中に server が socket を destroy",
    server: { kind: "destroy" },
    cause: "unreachable",
    reachesServer: true,
    envVariant: true,
  },
  {
    name: "200 本文の途中で切断 (truncate)",
    server: { kind: "truncate" },
    cause: "unreachable",
    reachesServer: true,
  },
  {
    name: "deadline 超過 (server が応答しない)",
    server: { kind: "hang" },
    args: withSpec(() => ({ deadlineMs: String(SHORT_DEADLINE_MS) })),
    cause: "deadline",
    reachesServer: true,
    minElapsedMs: SHORT_DEADLINE_MS,
    maxElapsedMs: SHORT_DEADLINE_MS + 8_000,
    envVariant: true,
    allowVariant: true,
  },
  // ---- stdin ----
  {
    name: "stdin が上限 +1 byte",
    server: OK_EMPTY_OBJECT,
    stdin: Buffer.alloc(HOOK_SHIM_MAX_INPUT_BYTES + 1, 0x20),
    cause: "input_too_large",
    reachesServer: false,
    allowVariant: true,
  },
  // ---- token ----
  {
    name: "token file 不在",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "missing.token") })),
    cause: "token_unavailable",
    reachesServer: false,
    allowVariant: true,
  },
  {
    name: "token file 不在 + 1MB の stdin (読み切ってから exit)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "missing.token") })),
    stdin: BIG_INPUT,
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token file がディレクトリ",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "token-dir") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token file が空",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "empty.token") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    // SEC-HS-1: writer の無い FIFO。O_NONBLOCK が無いと open が threadpool を塞ぎ、deadline 後も
    // exit できない (CC の timeout = 素通り)。導出 deadline (315s) のまま、すぐ終わることを見る。
    name: "token file が FIFO (塞がらずに即 block)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "fifo.token") })),
    cause: "token_unavailable",
    reachesServer: false,
    maxElapsedMs: 5_000,
    processOnly: true,
  },
  {
    name: "token file が symlink (O_NOFOLLOW)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "symlink.token") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token file が 0644 (group / other が読める)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "open.token") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token file が上限 +1 byte",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "big.token") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token が上限 +1 字",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "long.token") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token に空白を含む",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ tokenFile: tok(ctx, "space.token") })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  {
    name: "token env 未設定",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ tokenFile: undefined, tokenEnv: TOKEN_ENV_NAME })),
    cause: "token_unavailable",
    reachesServer: false,
  },
  // ---- 引数不正 (allow 変種でも block のまま) ----
  {
    name: "非 loopback endpoint",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `http://10.255.255.1:${ctx.port}/hook` })),
    cause: "bad_args",
    reachesServer: false,
    allowVariant: true,
  },
  {
    name: "引数不正 + 1MB の stdin (読み切ってから exit)",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ event: "PostToolUse" })),
    stdin: BIG_INPUT,
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "https endpoint",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `https://127.0.0.1:${ctx.port}/hook` })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "localhost endpoint (daemon は 127.0.0.1 に bind)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `http://localhost:${ctx.port}/hook` })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "[::1] endpoint",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `http://[::1]:${ctx.port}/hook` })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint に userinfo (偽値入り)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({
      endpoint: `http://u:${FAKE_ARGV_SECRET}@127.0.0.1:${ctx.port}/hook`,
    })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint に query (偽値入り)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({
      endpoint: `http://127.0.0.1:${ctx.port}/hook?t=${FAKE_ARGV_SECRET}`,
    })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint に空の query",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `http://127.0.0.1:${ctx.port}/hook?` })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint の path が /hook 以外",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `http://127.0.0.1:${ctx.port}/hook/x` })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint の path に token 形の値 (偽値入り)",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ endpoint: `http://127.0.0.1:${ctx.port}/${FAKE_ARGV_SECRET}` })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint に port が無い",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ endpoint: "http://127.0.0.1/hook" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint の port が 0",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ endpoint: "http://127.0.0.1:0/hook" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "endpoint の port が 65536",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ endpoint: "http://127.0.0.1:65536/hook" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "未知の --on-unreachable 値",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ onUnreachable: "maybe" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--event が PreToolUse 以外",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ event: "PermissionRequest" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--token-file と --token-env の両方",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ tokenEnv: TOKEN_ENV_NAME })),
    env: { [TOKEN_ENV_NAME]: FAKE_TOKEN_ENV },
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "token の出所が無い",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ tokenFile: undefined })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--token-file が相対 path",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ tokenFile: "hook.token" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--token-env の名前が識別子でない",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ tokenFile: undefined, tokenEnv: "1BAD" })),
    env: { "1BAD": FAKE_TOKEN_ENV },
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--deadline-ms が上限 +1",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ deadlineMs: String(HOOK_SHIM_MAX_DEADLINE_MS + 1) })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--deadline-ms が 0",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ deadlineMs: "0" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--deadline-ms が小数",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ deadlineMs: "1500.5" })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "未知の flag",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ extra: ["--verbose", "1"] })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "廃止した --scope (偽値入り)",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ extra: ["--scope", FAKE_ARGV_SECRET] })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "--endpoint の重複",
    server: OK_EMPTY_OBJECT,
    args: withSpec((ctx) => ({ extra: ["--endpoint", `http://127.0.0.1:${ctx.port}/hook`] })),
    cause: "bad_args",
    reachesServer: false,
  },
  {
    name: "末尾の flag に値が無い",
    server: OK_EMPTY_OBJECT,
    args: withSpec(() => ({ extra: ["--on-unreachable"] })),
    cause: "bad_args",
    reachesServer: false,
  },
  // ---- 成功 (daemon の判断を逐語で通す・allow 変種も同じ bytes) ----
  { name: "200 {}", server: OK_EMPTY_OBJECT, stdout: Buffer.from("{}"), reachesServer: true },
  {
    name: "200 allow JSON (逐語)",
    server: ok200(ALLOW_BODY),
    stdout: ALLOW_BODY,
    reachesServer: true,
  },
  {
    name: "200 deny JSON (逐語)",
    server: ok200(DENY_BODY),
    stdout: DENY_BODY,
    reachesServer: true,
    envVariant: true,
  },
  {
    name: "stdin がちょうど上限 (daemon と同値まで転送する)",
    server: OK_EMPTY_OBJECT,
    stdin: Buffer.alloc(HOOK_SHIM_MAX_INPUT_BYTES, 0x20),
    stdout: Buffer.from("{}"),
    reachesServer: true,
  },
  {
    name: "200 JSON object がちょうど応答上限 (逐語)",
    server: ok200(jsonObjectOfSize(HOOK_SHIM_MAX_RESPONSE_BYTES)),
    stdout: jsonObjectOfSize(HOOK_SHIM_MAX_RESPONSE_BYTES),
    reachesServer: true,
  },
  {
    name: "--on-unreachable block の明示",
    server: ok200(DENY_BODY),
    args: withSpec(() => ({ onUnreachable: "block" })),
    stdout: DENY_BODY,
    reachesServer: true,
  },
  {
    name: "env token が daemon の最短形 (許可文字全種・32 字)",
    server: ok200(DENY_BODY),
    args: withSpec(() => ({ tokenFile: undefined, tokenEnv: TOKEN_ENV_NAME })),
    env: { [TOKEN_ENV_NAME]: USABLE_TOKEN_MIN },
    expectedToken: USABLE_TOKEN_MIN,
    stdout: DENY_BODY,
    reachesServer: true,
  },
  {
    name: "env token が daemon の最長形 (1024 字)",
    server: ok200(DENY_BODY),
    args: withSpec(() => ({ tokenFile: undefined, tokenEnv: TOKEN_ENV_NAME })),
    env: { [TOKEN_ENV_NAME]: USABLE_TOKEN_MAX },
    expectedToken: USABLE_TOKEN_MAX,
    stdout: DENY_BODY,
    reachesServer: true,
  },
  {
    name: "env 名が daemon の HOOK_TOKEN_ENV_VAR",
    server: ok200(DENY_BODY),
    args: withSpec(() => ({ tokenFile: undefined, tokenEnv: HOOK_TOKEN_ENV_VAR })),
    env: { [HOOK_TOKEN_ENV_VAR]: FAKE_TOKEN_ENV },
    stdout: DENY_BODY,
    reachesServer: true,
  },
];

/** env 変種: token を env (FAKE_TOKEN_ENV) から読む版 (QA-HS-3)。 */
const ENV_CASES: readonly Case[] = BASE_CASES.filter((c) => c.envVariant === true).map((c) => ({
  ...c,
  name: `[env] ${c.name}`,
  args: (ctx: Ctx) => ({
    ...(c.args ?? defaultSpec)(ctx),
    tokenFile: undefined,
    tokenEnv: TOKEN_ENV_NAME,
  }),
  env: { [TOKEN_ENV_NAME]: FAKE_TOKEN_ENV },
  expectedToken: FAKE_TOKEN_ENV,
}));

/**
 * `--on-unreachable allow` 変種: daemon とのやり取りの失敗は exit 0 無出力 (HTTP フック時代と同じ
 * 素通り)、bad_args は kill-switch でも block のまま、200 JSON は block と同じ bytes を転送する
 * (allow で deny を捨てない・QA-HS-1)。成功行は全行、失敗行は `allowVariant` の行と env 変種から作る。
 */
const ALLOW_CASES: readonly Case[] = [...BASE_CASES, ...ENV_CASES]
  .filter((c) => c.cause === undefined || c.allowVariant === true || c.name.startsWith("[env]"))
  .map((c) => ({
    ...c,
    name: `[allow] ${c.name}`,
    args: (ctx: Ctx) => ({ ...(c.args ?? defaultSpec)(ctx), onUnreachable: "allow" }),
    cause: c.cause === "bad_args" ? "bad_args" : undefined,
    stdout: c.cause === undefined ? c.stdout : undefined,
    // allow は deadline でも即座には終わらない (deadline まで待ってから素通り) ので下限は保つ。
    minElapsedMs: c.minElapsedMs,
  }));

const CASES: readonly Case[] = [...BASE_CASES, ...ENV_CASES, ...ALLOW_CASES];
const IN_PROCESS_CASES: readonly Case[] = CASES.filter((c) => c.processOnly !== true);

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
  /** 書き手側 (= CC 役) の stdin 書込みエラー (EPIPE)。in-process では常に undefined。 */
  readonly stdinError: string | undefined;
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
    for (const t of text.trim().split(/\s+/)) {
      const c = Number(t);
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

/** 1 本の shim (entry) を新しいプロセスグループで起動し、後始末の対象に登録する。 */
function spawnShim(argv: readonly string[], env: Readonly<Record<string, string>>) {
  // 親 env を継承しない (偽 token env が既定で漏れ込まない・必要な PATH だけ渡す)。
  const child = spawn(tsxBin, [SHIM_ENTRY, ...argv], {
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
    let stdinError: string | undefined;
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    // shim が stdin を読み切らずに終わると EPIPE になる (SEC-HS-10 で assert する)。
    child.stdin.on("error", (e: NodeJS.ErrnoException) => (stdinError = e.code ?? e.message));
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
        stdinError,
      }),
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
  return {
    code: r.exitCode,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr ?? "",
    stdinError: undefined,
  };
}

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "actradeck-hook-shim-"));
  chmodSync(workDir, 0o700);
  const at = (name: string): string => join(workDir, name);
  writeFileSync(at("hook.token"), `${FAKE_TOKEN_FILE}\n`, { mode: 0o600 });
  writeFileSync(at("empty.token"), "", { mode: 0o600 });
  mkdirSync(at("token-dir"), { mode: 0o700 });
  execFileSync("mkfifo", ["-m", "600", at("fifo.token")]);
  symlinkSync(at("hook.token"), at("symlink.token"));
  writeFileSync(at("open.token"), `${FAKE_TOKEN_FILE}\n`, { mode: 0o644 });
  chmodSync(at("open.token"), 0o644); // umask に依存しない
  writeFileSync(at("big.token"), "a".repeat(HOOK_SHIM_MAX_TOKEN_FILE_BYTES + 1), { mode: 0o600 });
  writeFileSync(at("long.token"), "a".repeat(HOOK_SHIM_MAX_TOKEN_LENGTH + 1), { mode: 0o600 });
  writeFileSync(at("space.token"), `${FAKE_TOKEN_FILE} x\n`, { mode: 0o600 });
});

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

function expectedTokenFor(c: Case, spec: ArgSpec, env: Readonly<Record<string, string>>): string {
  if (c.expectedToken !== undefined) return c.expectedToken;
  return spec.tokenEnv !== undefined ? (env[spec.tokenEnv] ?? "") : FAKE_TOKEN_FILE;
}

/**
 * 実行証跡は **file top-level** の afterAll で照合する。describe 内の afterAll は、その describe の
 * test が全部 skip されると vitest が呼ばない (変異 `it` → `it.skip` で実測: 内側 afterAll では
 * 素通りした)。top-level なら結合 describe の test が 1 本でも走れば呼ばれる。
 */
const executed = {
  process: 0,
  inProcess: 0,
  hold: 0,
  entry: 0,
  argvCarried: Object.fromEntries(ARGV_CARRIED.map((w) => [w, 0])) as Record<string, number>,
};
afterAll(() => {
  expect(executed.process, "every table case must have run (real process)").toBe(CASES.length);
  expect(executed.inProcess, "every table case must have run (in-process)").toBe(
    IN_PROCESS_CASES.length,
  );
  expect(executed.hold, "the hold case must have run").toBe(1);
  expect(executed.entry, "the entry wiring cases must have run").toBe(2);
  // 起動した全 shim (正常終了・timeout・失敗のどれでも) のグループが残っていない。
  // 件数の下限: 表 × 実プロセス + 保留 1 本 + entry 2 本 (空振りで恒真にならない)。
  expect(spawnedAll.length).toBeGreaterThanOrEqual(CASES.length + 3);
  expect(spawnedAll.filter((pgid) => !isGone(-pgid))).toEqual([]);
  // POSITIVE 対 (stderr の negative 語彙と argv の偽値): 同じ語を argv に載せて shim に渡している。
  for (const w of ARGV_CARRIED) {
    expect(executed.argvCarried[w], `argv carried "${w}"`).toBeGreaterThanOrEqual(2);
  }
});

async function check(c: Case, run: typeof runProcess): Promise<void> {
  const srv = await startServer(c.server);
  try {
    const ctx: Ctx = { port: srv.port, dir: workDir };
    const spec = (c.args ?? defaultSpec)(ctx);
    const env = c.env ?? {};
    const stdin = c.stdin ?? HOOK_INPUT;
    const argv = toArgv(spec);
    for (const w of ARGV_CARRIED) {
      if (argv.some((a) => a.includes(w)))
        executed.argvCarried[w] = (executed.argvCarried[w] ?? 0) + 1;
    }
    const started = Date.now();
    const r = await run(argv, stdin, env);
    const elapsed = Date.now() - started;

    if (c.cause === undefined) {
      // 成功 / allow の素通り: exit 0・stderr 無し・stdout は期待 bytes と逐語一致 (無出力含む)。
      expect(r.code, `${c.name}: exit code (stderr=${r.stderr})`).toBe(0);
      expect(r.stderr, c.name).toBe("");
      expect(r.stdout.equals(c.stdout ?? Buffer.alloc(0)), `${c.name}: stdout bytes`).toBe(true);
    } else {
      // block: exit 2・stdout 無出力・stderr は cause と固定文の全文一致 (SEC-HS-3)。
      expect(r.code, `${c.name}: exit code`).toBe(2);
      expect(r.stdout.length, `${c.name}: stdout must be empty on block`).toBe(0);
      expect(r.stderr, `${c.name}: stderr`).toBe(expectedStderr(c.cause));
      expect(r.stderr).toContain(`(cause=${c.cause})`);
      expect(r.stderr).toContain(BLOCK_SENTENCE);
    }
    // gate を外す手順の語彙は stderr に無い (POSITIVE 対は top-level afterAll の argv 搬送)。
    for (const w of GATE_VOCAB_NEVER_ON_STDERR) {
      expect(r.stderr, `${c.name}: stderr names "${w}"`).not.toContain(w);
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

    // POSITIVE 対 (token / request body): daemon が実際に受け取ったこと。env 行では env の偽値。
    if (c.reachesServer) {
      expect(srv.seen.length, `${c.name}: daemon reached once`).toBe(1);
      const seen = srv.seen[0];
      expect(seen?.token, `${c.name}: token header`).toBe(expectedTokenFor(c, spec, env));
      expect(seen?.body.equals(stdin), `${c.name}: request body forwarded verbatim`).toBe(true);
      if (stdin === HOOK_INPUT) expect(seen?.body.toString("utf8")).toContain(FAKE_REQ_SECRET);
    } else {
      expect(srv.seen.length, `${c.name}: daemon must not be reached`).toBe(0);
    }

    // 書き手側に EPIPE を起こさない (早期失敗でも stdin を読み切ってから exit・SEC-HS-10)。
    expect(r.stdinError, `${c.name}: writer saw an error on stdin`).toBeUndefined();

    // 経過時間: deadline の相対境界 (QA-HS-2) と、塞がらないこと (SEC-HS-1)。
    if (c.minElapsedMs !== undefined) expect(elapsed).toBeGreaterThanOrEqual(c.minElapsedMs);
    if (c.maxElapsedMs !== undefined) expect(elapsed).toBeLessThan(c.maxElapsedMs);
  } finally {
    await srv.close();
  }
}

describe("INV-HOOK-SHIM-FAIL-CLOSED: 実 shim プロセス (exit code / stdout bytes / stderr)", () => {
  for (const c of CASES) {
    it(c.name, { timeout: 30_000 }, async () => {
      await check(c, runProcess);
      executed.process += 1;
    });
  }
});

describe("INV-HOOK-SHIM-FAIL-CLOSED: entry (hook-shim.ts) の結線", () => {
  /**
   * SEC-HS-4: daemon の 200 deny を stdout へ書けないとき、exit 0 (= 書けなかった deny を捨てて実行)
   * にせず exit 2 (`output_failed`) にする。親が stdout の読み側を閉じて EPIPE を起こす。
   * allow でも同じ (kill-switch は daemon との失敗にだけ効く)。
   */
  for (const onUnreachable of ["block", "allow"] as const) {
    it(`stdout に書けないと 200 deny でも exit 2 (output_failed・${onUnreachable})`, async () => {
      const srv = await startServer(ok200(DENY_BODY));
      closeAfterCleanup.push(srv.close);
      const argv = toArgv({ ...defaultSpec({ port: srv.port, dir: workDir }), onUnreachable });
      const child = spawnShim(argv, {});
      child.stdout.destroy();
      const errChunks: Buffer[] = [];
      child.stderr.on("data", (b: Buffer) => errChunks.push(b));
      child.stdin.on("error", () => undefined);
      const closed = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
      child.stdin.end(HOOK_INPUT);
      const code = await closed;
      expect(srv.seen.length, "the shim reached the daemon").toBe(1);
      expect(code).toBe(2);
      expect(Buffer.concat(errChunks).toString("utf8")).toBe(expectedStderr("output_failed"));
      executed.entry += 1;
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
    const child = spawnShim(toArgv(defaultSpec({ port: srv.port, dir: workDir })), {});
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
  for (const c of IN_PROCESS_CASES) {
    it(c.name, { timeout: 30_000 }, async () => {
      await check(c, runInProcess);
      executed.inProcess += 1;
    });
  }

  /**
   * QA-HS-2: deadline の timer は渡した `--deadline-ms` **ちょうど**で張る。×1.05 (本番の 315s が
   * CC の 330s を超える) も ÷10 (承認待ち中に block) も、timer の遅延値と経過時間の両方で捕まえる。
   */
  it("deadline の timer は --deadline-ms ちょうどで張られ、その前には終わらない", async () => {
    const srv = await startServer({ kind: "hang" });
    const deadline = 1_200;
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const argv = toArgv({
        ...defaultSpec({ port: srv.port, dir: workDir }),
        deadlineMs: String(deadline),
      });
      const started = Date.now();
      const r = await runHookShim(argv, { stdin: Readable.from([HOOK_INPUT]), env: {} });
      const elapsed = Date.now() - started;
      const delays = spy.mock.calls.map((call) => call[1]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toBe(expectedStderr("deadline"));
      expect(delays).toContain(deadline);
      expect(elapsed).toBeGreaterThanOrEqual(deadline);
      expect(elapsed).toBeLessThan(deadline + 1_000);
    } finally {
      spy.mockRestore();
      await srv.close();
    }
  });
});

describe("INV-HOOK-SHIM-FAIL-CLOSED: daemon / 単一出所との結合", () => {
  it("token ヘッダ名は daemon が照合する HOOK_TOKEN_HEADER と同値", () => {
    expect(HOOK_SHIM_TOKEN_HEADER).toBe(HOOK_TOKEN_HEADER);
  });

  it("stdin 上限は daemon の受信上限と同値 (4MB)", () => {
    expect(HOOK_SHIM_MAX_INPUT_BYTES).toBe(HOOK_MAX_BODY_BYTES);
    expect(HOOK_SHIM_MAX_INPUT_BYTES).toBe(4 * 1024 * 1024);
  });

  it("token の上限は daemon の isUsableHookToken の上限と同値・境界 token は daemon も受理する", () => {
    expect(isUsableHookToken("a".repeat(HOOK_SHIM_MAX_TOKEN_LENGTH))).toBe(true);
    expect(isUsableHookToken("a".repeat(HOOK_SHIM_MAX_TOKEN_LENGTH + 1))).toBe(false);
    // 表の env 行が shim を通す境界 token は、daemon 側の規則でも有効 (片側だけの規則変更で RED)。
    expect(USABLE_TOKEN_MIN).toHaveLength(32);
    expect(USABLE_TOKEN_MAX).toHaveLength(1024);
    expect(isUsableHookToken(USABLE_TOKEN_MIN)).toBe(true);
    expect(isUsableHookToken(USABLE_TOKEN_MAX)).toBe(true);
  });

  it("--deadline-ms の上限は shimDeadlineMsFor の最大 (= MAX 承認待ち) と同値", () => {
    expect(HOOK_SHIM_MAX_DEADLINE_MS).toBe(shimDeadlineMsFor(MAX_APPROVAL_TIMEOUT_MS));
    expect(HOOK_SHIM_MAX_DEADLINE_MS).toBeLessThan(600_000); // CC の既定 timeout より前
  });

  /** 主張の範囲は下に列挙した 11 入力 (境界・小数・不正値) の実測に限る (QA-HS-6)。 */
  it("試した 11 入力の shimDeadlineMsFor はすべて --deadline-ms として受理される", () => {
    const inputs = [
      MIN_APPROVAL_TIMEOUT_MS,
      1.5,
      1_000.5,
      DEFAULT_APPROVAL_TIMEOUT_MS,
      DEFAULT_APPROVAL_TIMEOUT_MS + 0.5,
      MAX_APPROVAL_TIMEOUT_MS - 0.5,
      MAX_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS + 1,
      Number.NaN,
      -1,
      0,
    ];
    let checked = 0;
    for (const approval of inputs) {
      const deadline = shimDeadlineMsFor(approval);
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
      checked += 1;
    }
    expect(checked).toBe(inputs.length);
  });

  it("daemon (実 HookReceiver) の endpoint はそのまま --endpoint として受理される", async () => {
    const receiver = new HookReceiver({ sink: {} as never, approvalBridge: {} as never });
    await receiver.listen();
    try {
      expect(receiver.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/hook$/);
      const parsed = parseHookShimArgs([
        "--endpoint",
        receiver.endpoint,
        "--event",
        "PreToolUse",
        "--deadline-ms",
        "1000",
        "--token-env",
        HOOK_TOKEN_ENV_VAR,
      ]);
      expect(parsed.endpoint).toBe(receiver.endpoint);
    } finally {
      await receiver.close();
    }
  });

  /**
   * stderr の negative 語彙のうち argv に載らないもの (`agentmon` / `daemon start` / `daemon stop` /
   * `--scope`) の POSITIVE 対: 同じ語は実在する CLI の語彙である (= negative は実際の手順の綴りを見ている)。
   */
  it("stderr に出さない語は実在する CLI の語彙 (negative の POSITIVE 対)", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { bin: Record<string, string> };
    expect(Object.keys(pkg.bin)).toContain("agentmon");
    expect(parseDaemonArgs("daemon stop --scope user".split(" "), workDir).action).toBe("stop");
    expect(parseDaemonArgs("daemon start --scope user".split(" "), workDir).action).toBe("start");
    for (const w of ["agentmon", "daemon start", "daemon stop", "--scope"]) {
      expect(GATE_VOCAB_NEVER_ON_STDERR).toContain(w);
    }
  });

  it("表の構成: ケース名は相異・env / allow 変種の被覆", () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
    // allow 変種は成功行を全部覆い、block のまま残るのは bad_args だけ。
    const successBase = [...BASE_CASES, ...ENV_CASES].filter((c) => c.cause === undefined).length;
    expect(ALLOW_CASES.filter((c) => c.stdout !== undefined).length).toBe(successBase);
    const allowBlocked = ALLOW_CASES.filter((c) => c.cause !== undefined).map((c) => c.cause);
    expect(new Set(allowBlocked)).toEqual(new Set(["bad_args"]));
    // env 変種は token を読んだ後の失敗 4 cause と成功を含む。
    expect(new Set(ENV_CASES.map((c) => c.cause ?? "ok"))).toEqual(
      new Set(["unreachable", "unauthorized", "bad_response", "deadline", "ok"]),
    );
    // allow 変種は daemon とのやり取りの失敗 (bad_args 以外) を cause ごとに 1 本以上持つ。
    const allowFrom = new Set(
      [...BASE_CASES, ...ENV_CASES]
        .filter((c) => c.cause !== undefined && c.cause !== "bad_args")
        .filter((c) => ALLOW_CASES.some((a) => a.name === `[allow] ${c.name}`))
        .map((c) => c.cause),
    );
    expect(allowFrom).toEqual(
      new Set([
        "unreachable",
        "unauthorized",
        "bad_response",
        "deadline",
        "input_too_large",
        "token_unavailable",
      ]),
    );
  });

  it("cause の closed enum は 8 語で固定・表と entry の test が全語を実際に踏む", () => {
    expect([...HOOK_SHIM_CAUSES].sort()).toEqual(
      [
        "bad_args",
        "bad_response",
        "deadline",
        "input_too_large",
        "output_failed",
        "token_unavailable",
        "unauthorized",
        "unreachable",
      ].sort(),
    );
    // output_failed は entry の結線 test が踏む (表は runHookShim の結果なので出ない)。
    const exercised = new Set(BASE_CASES.map((c) => c.cause).filter((x) => x !== undefined));
    exercised.add("output_failed");
    expect([...exercised].sort()).toEqual([...HOOK_SHIM_CAUSES].sort());
  });

  it("runtime import: core は node:* のみ・entry は node:* と core のみ", () => {
    const specifiersOf = (file: string): string[] => {
      const src = stripComments(readFileSync(file, "utf8"));
      return [
        ...src.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...src.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ].map((m) => m[1] ?? "");
    };
    const core = specifiersOf(SHIM_CORE);
    // POSITIVE: 走査は実際に import を拾っている (空振りで恒真にならない)。
    expect(core).toContain("node:http");
    for (const s of core) expect(s, `core import ${s}`).toMatch(/^node:/);
    const entry = specifiersOf(SHIM_ENTRY);
    expect(entry).toContain("./hook-shim-core.js");
    for (const s of entry)
      expect(s, `entry import ${s}`).toMatch(/^(node:|\.\/hook-shim-core\.js$)/);
  });
});
