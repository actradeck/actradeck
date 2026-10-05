/**
 * PreToolUse 用 command 型 hook shim — transport 失敗を **exit 2 (block)** に変える adapter
 * (ADR 0016 `docs/adr/0016-pretooluse-command-shim-fail-closed.md`・Triangle ADR 01a108aa)。
 *
 * ## なぜ要るか
 * Claude Code の HTTP フックは、接続失敗・非 2xx・timeout をすべて **non-blocking** として扱う
 * (上流 hooks docs: "Non-2xx status: non-blocking error, execution continues" / "Connection failure:
 * non-blocking error" / "HTTP hooks can't signal a blocking error through status codes alone")。
 * つまり daemon が止まっている・token が合わない・応答が壊れている間、承認ゲートは**無信号で外れる**
 * (SEC-FC-3)。command フックの exit 2 は上流が blocking として設計した唯一の経路で
 * ("Exit 2's block is the one outcome JSON can't override")、PreToolUse では tool 呼び出しを止める。
 *
 * ## 契約 (この shim がすること・しないこと)
 * stdin の hook JSON (上限 {@link HOOK_SHIM_MAX_INPUT_BYTES} = daemon の受信上限と同値) を読み、
 * `POST <endpoint>` へ {@link HOOK_SHIM_TOKEN_HEADER} 付きで転送する。結果は 3 通りだけ:
 * - 2xx + JSON object の body → body を **逐語** (再整形しない) で stdout へ書き exit 0
 *   (allow / deny / `{}` の意味論は daemon が決め、HTTP フック時代と byte-equivalent)。
 * - 2xx + 空 body → 無出力で exit 0 (no opinion)。
 * - **それ以外すべて** → stderr に固定語彙 + exit 2。判定できないものは block (床・fail-closed)。
 *   cause は closed enum {@link HookShimCause}。
 *
 * `--on-unreachable allow` (kill-switch) のときだけ、transport 系の失敗 (`bad_args` 以外) を
 * 「無出力 exit 0」= HTTP フック時代と同じ素通りへ戻す。**`bad_args` と未知の `--on-unreachable` 値は
 * 常に block** (設定の誤りで黙って gate が外れる経路を作らない)。
 *
 * しないこと: 分類器・policy・allowlist を持たない (2 本目のゲート定義は drift の発生源)。daemon の
 * 応答を解釈し直さない (JSON object かどうかだけ見る)。ログ・カウンタ・一時ファイルを書かない (無状態)。
 *
 * ## NO-RAW
 * stderr に出すのは cause・検証済み endpoint (loopback URL・秘密でない)・復旧コマンド・kill-switch 名
 * だけ。token 値・env 値・request body・response body・OS のエラーメッセージは出さない (OS の
 * message はパスや値を含みうるため、cause へ写像した後は捨てる)。endpoint と scope は検証を通った
 * ものしか表示しない (検証前の argv を echo すると、誤って args に置かれた秘密を書き出しうる)。
 *
 * ## runtime 依存
 * `node:*` のみ (event-model / redaction も import しない)。CC がフックごとに spawn するので起動を軽く
 * 保ち、daemon の dist と独立に壊れにくくする。deadline は event-model の `shimDeadlineMsFor` で
 * 導出した値を settings の args で受け取る (三段順序: 承認待ち < shim deadline < CC hook timeout)。
 */
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * daemon が照合する認証ヘッダ名。`settings-injection.ts` の `HOOK_TOKEN_HEADER` と同値でなければ
 * ならない (runtime import できないので INV-HOOK-SHIM-FAIL-CLOSED が一致を pin する)。
 */
export const HOOK_SHIM_TOKEN_HEADER = "X-ActraDeck-Hook-Token";

/**
 * stdin の上限 (bytes)。daemon の受信上限 (`hook-receiver.ts` の `HOOK_MAX_BODY_BYTES`) と同値。
 * 超過は daemon へ送っても切断されるだけなので、shim 側で `input_too_large` として block する。
 */
export const HOOK_SHIM_MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** daemon 応答の上限 (bytes)。承認応答は数百 bytes であり、これを超えるものは壊れた応答とみなす。 */
export const HOOK_SHIM_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * `--deadline-ms` の上限。CC のフック既定 timeout (600s) を超える deadline は CC に先に殺されて
 * 素通りになりうるため受け付けない (`bad_args`)。実際の値は `shimDeadlineMsFor` が決める。
 */
export const HOOK_SHIM_MAX_DEADLINE_MS = 600_000;

/** token file / env の値の上限 (chars)。ヘッダ値として扱える長さに制限する。 */
const MAX_TOKEN_LENGTH = 1024;

/** 失敗理由の closed enum。stderr に出してよい唯一の分類語彙。 */
export const HOOK_SHIM_CAUSES = [
  "unreachable",
  "unauthorized",
  "bad_response",
  "deadline",
  "input_too_large",
  "token_unavailable",
  "bad_args",
] as const;
export type HookShimCause = (typeof HOOK_SHIM_CAUSES)[number];

/** `--scope` の closed enum (`agentmon daemon start --scope` と同じ語彙)。 */
const SCOPES = new Set(["project-local", "project", "user"]);

/** shim が受け付ける唯一の event (ADR 0016: PermissionRequest は exit 2 非 honor のため HTTP 維持)。 */
const SUPPORTED_EVENT = "PreToolUse";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** endpoint の path に許す文字。表示する値を絞り、args に紛れた秘密を echo しないため。 */
const ENDPOINT_PATH_RE = /^\/[A-Za-z0-9/_-]{0,63}$/;

/** env 名の形 (POSIX の識別子)。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** ヘッダ値に載せられる token の形 (可視 ASCII のみ・CR/LF/制御文字を拒否)。 */
const TOKEN_VALUE_RE = /^[\x21-\x7e]+$/;

const EXIT_ALLOW = 0;
const EXIT_BLOCK = 2;

interface ShimArgs {
  readonly endpoint: URL;
  readonly displayEndpoint: string;
  readonly deadlineMs: number;
  readonly token:
    | { readonly kind: "file"; readonly path: string }
    | {
        readonly kind: "env";
        readonly name: string;
      };
  readonly onUnreachable: "block" | "allow";
  readonly scope: string | undefined;
}

/** shim の入出力 (main は process に結線し、テストは in-process で同じ関数を通す)。 */
export interface HookShimIo {
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** shim の結果。`stdout` は 2xx JSON の逐語 bytes のときだけ定義される。 */
export interface HookShimResult {
  readonly exitCode: 0 | 2;
  readonly stdout?: Buffer;
  readonly stderr?: string;
}

class ShimFailure extends Error {
  readonly reason: HookShimCause;
  constructor(reason: HookShimCause) {
    super(reason);
    this.reason = reason;
  }
}

function fail(cause: HookShimCause): never {
  throw new ShimFailure(cause);
}

/**
 * endpoint を検証する。http + loopback + 資格情報・query・fragment 無し + path 文字種限定。
 * 1 つでも外れたら `bad_args` (非 loopback へ token と hook JSON を送らない)。
 */
function parseEndpoint(raw: string): { url: URL; display: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("bad_args");
  }
  if (url.protocol !== "http:") fail("bad_args");
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) fail("bad_args");
  if (url.username !== "" || url.password !== "") fail("bad_args");
  if (url.search !== "" || url.hash !== "") fail("bad_args");
  if (raw.includes("?") || raw.includes("#")) fail("bad_args"); // 空 query / 空 fragment も拒否
  if (!ENDPOINT_PATH_RE.test(url.pathname)) fail("bad_args");
  return { url, display: `${url.protocol}//${url.host}${url.pathname}` };
}

function parseDeadline(raw: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) fail("bad_args");
  const n = Number(raw);
  if (n > HOOK_SHIM_MAX_DEADLINE_MS) fail("bad_args");
  return n;
}

const VALUE_FLAGS = new Set([
  "--endpoint",
  "--event",
  "--deadline-ms",
  "--token-file",
  "--token-env",
  "--on-unreachable",
  "--scope",
]);

/**
 * argv を厳格に解析する。未知の flag・値欠落・重複・未知の値はすべて `bad_args`
 * (曖昧な設定で gate が外れる/別物へ送る経路を作らない)。
 */
export function parseHookShimArgs(argv: readonly string[]): ShimArgs {
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !VALUE_FLAGS.has(flag)) fail("bad_args");
    if (value === undefined || seen.has(flag)) fail("bad_args");
    seen.set(flag, value);
  }
  const endpointRaw = seen.get("--endpoint");
  const event = seen.get("--event");
  const deadlineRaw = seen.get("--deadline-ms");
  const tokenFile = seen.get("--token-file");
  const tokenEnv = seen.get("--token-env");
  const onUnreachable = seen.get("--on-unreachable") ?? "block";
  const scope = seen.get("--scope");

  if (endpointRaw === undefined || event === undefined || deadlineRaw === undefined) {
    fail("bad_args");
  }
  if (event !== SUPPORTED_EVENT) fail("bad_args");
  if (onUnreachable !== "block" && onUnreachable !== "allow") fail("bad_args");
  if (scope !== undefined && !SCOPES.has(scope)) fail("bad_args");
  // token の出所は file か env のちょうど一方 (両方・どちらも無し は設定の誤り)。
  if ((tokenFile === undefined) === (tokenEnv === undefined)) fail("bad_args");
  if (tokenFile !== undefined && tokenFile.length === 0) fail("bad_args");
  if (tokenEnv !== undefined && !ENV_NAME_RE.test(tokenEnv)) fail("bad_args");

  const { url, display } = parseEndpoint(endpointRaw);
  return {
    endpoint: url,
    displayEndpoint: display,
    deadlineMs: parseDeadline(deadlineRaw),
    token:
      tokenFile !== undefined
        ? { kind: "file", path: tokenFile }
        : { kind: "env", name: tokenEnv as string },
    onUnreachable,
    scope,
  };
}

/** token file の上限 (bytes)。daemon が書く 0600 の小ファイル以外 (巨大ファイル・特殊ファイル) は拒否。 */
const MAX_TOKEN_FILE_BYTES = 4096;

/**
 * token を読む。読めない・形が合わないものはすべて `token_unavailable`。
 * 非同期で読む: FIFO 等で open が詰まっても event loop を塞がず、deadline が先に発火して block する
 * (同期 read だと deadline が効かず CC の timeout = 素通りに落ちる)。
 */
async function readToken(args: ShimArgs, io: HookShimIo): Promise<string> {
  let raw: string | undefined;
  if (args.token.kind === "file") {
    try {
      const fh = await open(args.token.path, "r");
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.size > MAX_TOKEN_FILE_BYTES) fail("token_unavailable");
        raw = await fh.readFile("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      return fail("token_unavailable");
    }
  } else {
    raw = io.env[args.token.name];
  }
  if (raw === undefined) fail("token_unavailable");
  // daemon が書く token file は末尾改行つきでもよい。改行以外の空白は token の一部とみなさず拒否。
  const token = raw.replace(/\r?\n$/, "");
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !TOKEN_VALUE_RE.test(token)) {
    fail("token_unavailable");
  }
  return token;
}

async function readInput(stdin: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buf.length;
    if (size > HOOK_SHIM_MAX_INPUT_BYTES) fail("input_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** daemon への転送。結果は「逐語 stdout bytes / 空 (no opinion)」か ShimFailure。 */
function forward(
  args: ShimArgs,
  token: string,
  body: Buffer,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(
      args.endpoint,
      {
        method: "POST",
        agent: false,
        signal,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
          [HOOK_SHIM_TOKEN_HEADER]: token,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) {
          res.resume();
          reject(new ShimFailure("unauthorized"));
          return;
        }
        if (status < 200 || status > 299) {
          res.resume();
          reject(new ShimFailure("bad_response"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > HOOK_SHIM_MAX_RESPONSE_BYTES) {
            reject(new ShimFailure("bad_response"));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          // 本文の途中で切れた応答は完了扱いにしない (半端な JSON を通さない)。
          if (!res.complete) {
            reject(new ShimFailure("unreachable"));
            return;
          }
          const raw = Buffer.concat(chunks);
          if (raw.length === 0) {
            resolve(undefined);
            return;
          }
          let parsed: unknown;
          try {
            // fatal: 不正な UTF-8 を置換文字で黙って直さない (逐語転送する bytes と解釈が一致する)。
            parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
          } catch {
            reject(new ShimFailure("bad_response"));
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            reject(new ShimFailure("bad_response"));
            return;
          }
          resolve(raw);
        });
        // 本文の途中で切れた (socket destroy 等) 応答: 'end' が来ずに 'error' / 'close' で終わる。
        // 既に resolve 済みなら reject は no-op。2 つは意図的に冗長 (どちらか一方で truncate ケースは
        // block になることを変異で実測済み・INV が固定するのは「両方を消すと RED」まで)。片方だけを
        // 消す編集は INV では検出されない。
        res.on("error", () => reject(new ShimFailure("unreachable")));
        res.on("close", () => {
          if (!res.complete) reject(new ShimFailure("unreachable"));
        });
      },
    );
    req.on("error", () => {
      reject(new ShimFailure(signal.aborted ? "deadline" : "unreachable"));
    });
    req.end(body);
  });
}

/**
 * stderr の固定文言。入力から来る値は検証済みの endpoint と closed enum の scope だけ。
 * `bad_args` では endpoint も scope も信用できないので一切出さない。また `bad_args` は kill-switch
 * でも素通りにならない (設定の誤りで gate を外さない) ので、kill-switch の案内を出さず書き直しを促す。
 * exit 2 の stderr は CC が block 理由として Claude と利用者に見せる (上流 hooks docs)。
 */
export function formatHookShimStderr(
  cause: HookShimCause,
  context?: { readonly endpoint: string; readonly scope: string | undefined },
): string {
  const scopeSuffix = context?.scope !== undefined ? ` --scope ${context.scope}` : "";
  const lines = [`actradeck hook-shim: blocked PreToolUse (cause=${cause})`];
  if (cause === "bad_args" || context === undefined) {
    lines.push(
      "the ActraDeck PreToolUse hook entry is malformed; rewrite it: agentmon daemon start",
      "remove the gate: agentmon daemon stop",
    );
  } else {
    lines.push(
      `endpoint: ${context.endpoint}`,
      `recover: agentmon daemon start${scopeSuffix}`,
      `remove the gate: agentmon daemon stop${scopeSuffix}`,
      "or rewire with --on-unreachable allow to let calls through while the daemon is unreachable",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * shim 本体。process に触れない (exit / write は呼び出し側)。
 * 例外は投げない: 想定外の throw (cause を持たない失敗) は transport が完了しなかったものとして
 * `unreachable` に写像し、block へ倒す (unknown → 床)。
 */
export async function runHookShim(
  argv: readonly string[],
  io: HookShimIo,
): Promise<HookShimResult> {
  let args: ShimArgs;
  try {
    args = parseHookShimArgs(argv);
  } catch {
    // 引数が読めない = on-unreachable も信用できない → 常に block。
    return { exitCode: EXIT_BLOCK, stderr: formatHookShimStderr("bad_args") };
  }

  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ShimFailure("deadline"));
    }, args.deadlineMs);
    controller.signal.addEventListener("abort", () => clearTimeout(timer));
  });
  // 処理が先に決着した後で deadline の reject が unhandled にならないよう吸収しておく。
  deadline.catch(() => undefined);

  try {
    const work = (async () => {
      const token = await readToken(args, io);
      const input = await readInput(io.stdin);
      return forward(args, token, input, controller.signal);
    })();
    work.catch(() => undefined);
    const out = await Promise.race([work, deadline]);
    return out === undefined ? { exitCode: EXIT_ALLOW } : { exitCode: EXIT_ALLOW, stdout: out };
  } catch (e) {
    const cause: HookShimCause = e instanceof ShimFailure ? e.reason : "unreachable";
    if (args.onUnreachable === "allow") return { exitCode: EXIT_ALLOW };
    return {
      exitCode: EXIT_BLOCK,
      stderr: formatHookShimStderr(cause, { endpoint: args.displayEndpoint, scope: args.scope }),
    };
  } finally {
    controller.abort();
  }
}

/** 直接実行されたとき (`node dist/hook-shim.js …`) だけ process に結線する。import では走らない。 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void runHookShim(process.argv.slice(2), { stdin: process.stdin, env: process.env }).then(
    (result) => {
      const finish = (): void => {
        if (result.stderr !== undefined) {
          process.stderr.write(result.stderr, () => process.exit(result.exitCode));
        } else {
          process.exit(result.exitCode);
        }
      };
      if (result.stdout !== undefined) process.stdout.write(result.stdout, finish);
      else finish();
    },
    () => {
      // runHookShim は throw しない契約だが、万一の throw も block へ倒す (床)。
      process.stderr.write(formatHookShimStderr("unreachable"), () => process.exit(EXIT_BLOCK));
    },
  );
}
