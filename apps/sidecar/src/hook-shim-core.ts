/**
 * PreToolUse 用 command 型 hook shim の本体 — transport 失敗を **exit 2 (block)** に変える adapter
 * (ADR 0016 `docs/adr/0016-pretooluse-command-shim-fail-closed.md`・Triangle ADR 01a108aa と
 * その R1 裁定 01a10c76 による改訂)。
 *
 * このファイルは **library** で、直接起動しても何もしない。CC が起動する entry は `hook-shim.ts`
 * (`dist/hook-shim.js`) で、そちらは判定なしで常に {@link runHookShim} を呼ぶ (SEC-HS-2: 旧版は
 * 1 ファイルで「直接起動されたか」を argv から判定しており、判定が偽になる起動形では何もせず exit 0
 * = gate が無音で外れた)。
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
 * stdin の hook JSON (上限 {@link HOOK_SHIM_MAX_INPUT_BYTES} = daemon の受信上限と同値) を読み切り、
 * `POST http://127.0.0.1:<port>/hook` へ {@link HOOK_SHIM_TOKEN_HEADER} 付きで転送する。結果は 2 通りだけ:
 * - **200 + JSON object の body** → body を **逐語** (再整形しない) で stdout へ書き exit 0
 *   (allow / deny / `{}` の意味論は daemon が決める)。daemon の応答はすべてこの形 (hook-receiver の
 *   `respond` は常に `JSON.stringify` した object を 200 で返す)。
 * - **それ以外すべて** → stderr に固定文 + exit 2。判定できないものは block (床・fail-closed)。
 *   200 以外の 2xx (204 等)・空 body・BOM 付き body・配列 / null / 非 JSON / 不正 UTF-8・応答上限
 *   超過も、daemon が返さない形なので block する (SEC-HS-7)。cause は closed enum {@link HookShimCause}。
 *
 * `--on-unreachable allow` (kill-switch) のときだけ、daemon とのやり取りの失敗 (`bad_args` 以外) を
 * 「無出力 exit 0」= HTTP フック時代と同じ素通りへ戻す。daemon が答えた 200 JSON は allow でも
 * そのまま転送する (deny を捨てない)。**`bad_args` と未知の `--on-unreachable` 値は常に block**
 * (設定の誤りで黙って gate が外れる経路を作らない)。stdout へ書けなかった場合 (`output_failed`・
 * entry 側) も mode によらず block する (書けなかった deny を捨てて exit 0 にしない・SEC-HS-4)。
 *
 * しないこと: 分類器・policy・allowlist を持たない (2 本目のゲート定義は drift の発生源)。daemon の
 * 応答を解釈し直さない (JSON object かどうかだけ見る)。ログ・カウンタ・一時ファイルを書かない (無状態)。
 *
 * ## stderr はモデルに届く (SEC-HS-3・R1 裁定で ADR を改訂)
 * exit 2 の stderr は CC が deny 理由として **Claude 本体に**渡す (上流 hooks docs)。よって stderr は
 * `cause=<closed enum>` と固定文だけにし、daemon の停止・再起動コマンド・kill-switch 名・endpoint を
 * **出さない** (出すと、一度 block されたエージェントが承認なしに gate を外す手順を受け取る)。
 * 復旧手順は operator 向けの経路 (docs / `agentmon daemon status`) にだけ置く。
 *
 * ## NO-RAW
 * stderr の内容は cause と固定文だけで、入力から来る値を一切含まない (token 値・env 値・request body・
 * response body・argv・endpoint・OS のエラーメッセージを出さない)。
 *
 * ## 終了できることの範囲 (SEC-HS-1 ≡ TDA-HS-1)
 * deadline で exit するには、libuv の threadpool に**終わらない操作が残っていない**ことが要る
 * (`process.exit` は threadpool の join を待つ)。token file は `O_NONBLOCK | O_NOFOLLOW` で開くので、
 * writer の無い FIFO でも open は即座に戻り、fstat で通常ファイル以外として `token_unavailable` に
 * なる (実プロセスで実測)。endpoint は IP リテラル `127.0.0.1` に固定したので名前解決 (threadpool の
 * getaddrinfo) も走らない。**残余**: 応答しないネットワーク FS (NFS の hard mount 等) 上の token file は
 * open / read がカーネル内で止まり (D-state)、O_NONBLOCK でも戻らない。その場合 shim は deadline 後も
 * 終了できず CC の timeout = 素通りになる (未実測・推論)。token file は daemon がローカルの
 * `~/.actradeck` 配下に置く前提 (T-B)。
 *
 * ## runtime 依存
 * `node:*` のみ (event-model / redaction も import しない)。CC がフックごとに spawn するので起動を軽く
 * 保ち、daemon の dist と独立に壊れにくくする。deadline は event-model の `shimDeadlineMsFor` で
 * 導出した値を settings の args で受け取る (三段順序: 承認待ち < shim deadline < CC hook timeout)。
 * daemon 側の定義との一致 (ヘッダ名・stdin 上限・deadline 上限・endpoint の形・token の形) は
 * INV-HOOK-SHIM-FAIL-CLOSED が結合 test で固定する (runtime import できないための複製)。
 */
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { isAbsolute } from "node:path";

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
 * `--deadline-ms` の上限 = `shimDeadlineMsFor(MAX_APPROVAL_TIMEOUT_MS)` (585s・SEC-HS-9)。導出の値域
 * より広く受けると、CC の既定 timeout (600s) と同時刻以降の deadline を受理してしまう (CC が先に
 * 殺す = 素通り)。値の一致は INV-HOOK-SHIM-FAIL-CLOSED が pin する。
 */
export const HOOK_SHIM_MAX_DEADLINE_MS = 585_000;

/** token file の上限 (bytes)。daemon が書く 0600 の小ファイル以外は拒否する。 */
export const HOOK_SHIM_MAX_TOKEN_FILE_BYTES = 4096;

/** token の上限 (chars)。daemon の `isUsableHookToken` の上限と同値。 */
export const HOOK_SHIM_MAX_TOKEN_LENGTH = 1024;

/**
 * 引数不正で終わるときに stdin を読み捨てる上限時間 (ms)。deadline が読めないので固定値を使う
 * (SEC-HS-10: 読み切らずに exit すると書き手側が EPIPE を受け、CC の版によっては non-blocking に
 * 化けうる)。CC の hook timeout より十分短い。
 */
export const HOOK_SHIM_BAD_ARGS_DRAIN_MS = 10_000;

/** 失敗理由の closed enum。stderr に出してよい唯一の分類語彙。 */
export const HOOK_SHIM_CAUSES = [
  "unreachable",
  "unauthorized",
  "bad_response",
  "deadline",
  "input_too_large",
  "token_unavailable",
  "bad_args",
  "output_failed",
] as const;
export type HookShimCause = (typeof HOOK_SHIM_CAUSES)[number];

/**
 * block 時に stderr へ出す固定文 (cause 行の次の行)。モデルに届くので、gate を外す手順・コマンド・
 * endpoint を含めない (SEC-HS-3)。
 */
export const HOOK_SHIM_BLOCK_MESSAGE =
  "This tool call was blocked because ActraDeck could not get an approval decision for it. " +
  "Ask the user to check the ActraDeck daemon; do not change ActraDeck settings or processes yourself.";

/** shim が受け付ける唯一の event (ADR 0016: PermissionRequest は exit 2 非 honor のため HTTP 維持)。 */
const SUPPORTED_EVENT = "PreToolUse";

/**
 * endpoint の唯一の形 (SEC-HS-6 / TDA-HS-6)。daemon の `HookReceiver.endpoint` が作る
 * `http://127.0.0.1:<port>/hook` に合わせる。`localhost` / `[::1]` は daemon が bind しない宛先
 * (別 listener が squat しうる) で、名前解決も threadpool を使うので受け付けない。
 */
const ENDPOINT_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/hook$/;

/** env 名の形 (POSIX の識別子)。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** ヘッダ値に載せられる token の形 (可視 ASCII のみ・CR/LF/空白/制御文字を拒否)。 */
const TOKEN_VALUE_RE = /^[\x21-\x7e]+$/;

const EXIT_ALLOW = 0;
const EXIT_BLOCK = 2;

interface ShimArgs {
  readonly endpoint: string;
  readonly deadlineMs: number;
  readonly token:
    | { readonly kind: "file"; readonly path: string }
    | { readonly kind: "env"; readonly name: string };
  readonly onUnreachable: "block" | "allow";
}

/** shim の入出力 (entry は process に結線し、テストは in-process で同じ関数を通す)。 */
export interface HookShimIo {
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** shim の結果。`stdout` は 200 JSON の逐語 bytes のときだけ定義される。 */
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

function parseEndpoint(raw: string): string {
  const m = ENDPOINT_RE.exec(raw);
  if (m === null || Number(m[1]) > 65_535) fail("bad_args");
  return raw;
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

  if (endpointRaw === undefined || event === undefined || deadlineRaw === undefined) {
    fail("bad_args");
  }
  if (event !== SUPPORTED_EVENT) fail("bad_args");
  if (onUnreachable !== "block" && onUnreachable !== "allow") fail("bad_args");
  // token の出所は file か env のちょうど一方 (両方・どちらも無し は設定の誤り)。
  if ((tokenFile === undefined) === (tokenEnv === undefined)) fail("bad_args");
  // 相対 path は CC の cwd (= project dir) 基準で解決されてしまう (SEC-HS-5)。
  if (tokenFile !== undefined && !isAbsolute(tokenFile)) fail("bad_args");
  if (tokenEnv !== undefined && !ENV_NAME_RE.test(tokenEnv)) fail("bad_args");

  return {
    endpoint: parseEndpoint(endpointRaw),
    deadlineMs: parseDeadline(deadlineRaw),
    token:
      tokenFile !== undefined
        ? { kind: "file", path: tokenFile }
        : { kind: "env", name: tokenEnv as string },
    onUnreachable,
  };
}

/**
 * token file を開くフラグ。`O_NONBLOCK`: writer の無い FIFO でも open が即座に戻る (SEC-HS-1)。
 * `O_NOFOLLOW`: 最終要素の symlink を辿らない (ELOOP → token_unavailable・SEC-HS-5)。
 * Windows 等で定数が無い環境では 0 (= 付けない) になる。
 */
const TOKEN_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * token を読む。読めない・形が合わないものはすべて `token_unavailable`。
 * file は「通常ファイル・group / other に権限が無い (0600 以下)・自分の uid が所有・
 * {@link HOOK_SHIM_MAX_TOKEN_FILE_BYTES} 以下」に限る (SEC-HS-5)。読むのは上限 +1 bytes までの
 * 固定長で、size 0 と申告する特殊ファイル (procfs 等) でも無界に読まない。stat と read は同じ fd。
 */
async function readToken(args: ShimArgs, io: HookShimIo): Promise<string> {
  let raw: string | undefined;
  if (args.token.kind === "file") {
    let fh;
    try {
      fh = await open(args.token.path, TOKEN_OPEN_FLAGS);
    } catch {
      return fail("token_unavailable");
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) fail("token_unavailable");
      if ((st.mode & 0o077) !== 0) fail("token_unavailable");
      // 所有者の検査は root で動くときだけ意味を持つ (非 root は他人の 0600 file をそもそも開けない)。
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid !== undefined && st.uid !== uid) fail("token_unavailable");
      // サイズは fstat の申告に頼らず、上限 +1 bytes までしか読まないことで抑える (procfs の
      // size 0 の file でも無界に読まない)。
      const buf = Buffer.alloc(HOOK_SHIM_MAX_TOKEN_FILE_BYTES + 1);
      let n = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, null);
        if (bytesRead === 0) break;
        n += bytesRead;
        if (n >= buf.length) break;
      }
      // 上限を超えた file は token の形 (≤ 1024 字・空白なし) でも必ず落ちるので、この検査は
      // 冗長 (変異しても exit code は変わらない・QA-HS-5)。読む量の上限を明示するために残す。
      if (n > HOOK_SHIM_MAX_TOKEN_FILE_BYTES) fail("token_unavailable");
      raw = buf.subarray(0, n).toString("utf8");
    } catch {
      return fail("token_unavailable");
    } finally {
      await fh.close().catch(() => undefined);
    }
  } else {
    raw = io.env[args.token.name];
  }
  if (raw === undefined) fail("token_unavailable");
  // daemon が書く token file は末尾改行つきでもよい。改行以外の空白は token の一部とみなさず拒否。
  const token = raw.replace(/\r?\n$/, "");
  if (
    token.length === 0 ||
    token.length > HOOK_SHIM_MAX_TOKEN_LENGTH ||
    !TOKEN_VALUE_RE.test(token)
  ) {
    fail("token_unavailable");
  }
  return token;
}

/**
 * stdin を EOF まで読む。上限を超えた分は**捨てながら読み続け**、EOF の後で `input_too_large` に
 * する (SEC-HS-10: 途中で exit すると書き手側が EPIPE を受ける)。読み切る時間は deadline が上限。
 */
async function readInput(stdin: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buf.length;
    if (size <= HOOK_SHIM_MAX_INPUT_BYTES) chunks.push(buf);
  }
  if (size > HOOK_SHIM_MAX_INPUT_BYTES) fail("input_too_large");
  return Buffer.concat(chunks);
}

/** 引数不正のとき、stdin を EOF か `maxMs` まで読み捨てる (SEC-HS-10)。失敗は無視する。 */
async function drainInput(stdin: AsyncIterable<Buffer | string>, maxMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const stop = new Promise<"stop">((resolve) => {
    timer = setTimeout(() => resolve("stop"), maxMs);
  });
  const it = stdin[Symbol.asyncIterator]();
  try {
    for (;;) {
      const r = await Promise.race([it.next(), stop]);
      if (r === "stop" || r.done === true) break;
    }
  } catch {
    // stdin の読取りエラーは無視する (どのみち block する)。
  } finally {
    clearTimeout(timer);
  }
}

/**
 * daemon への転送。結果は逐語 stdout bytes か ShimFailure。
 * 途中で切れた応答 (socket destroy・本文の途中切断) は応答本文の async iterator が throw するので、
 * 検知はその 1 経路だけで行う (TDA-HS-10)。
 */
async function forward(
  args: ShimArgs,
  token: string,
  body: Buffer,
  signal: AbortSignal,
): Promise<Buffer> {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
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
      resolve,
    );
    // 応答前の失敗 (接続拒否・応答待ち中の切断・deadline 後の abort)。応答後に来ても no-op。
    req.on("error", () => reject(new ShimFailure("unreachable")));
    req.end(body);
  });
  const status = res.statusCode ?? 0;
  if (status === 401 || status === 403) {
    res.resume();
    fail("unauthorized");
  }
  if (status !== 200) {
    res.resume();
    fail("bad_response");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const c of res as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > HOOK_SHIM_MAX_RESPONSE_BYTES) {
        res.destroy();
        fail("bad_response");
      }
      chunks.push(c);
    }
  } catch (e) {
    if (e instanceof ShimFailure) throw e;
    fail("unreachable");
  }
  const raw = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    // fatal: 不正な UTF-8 を置換文字で黙って直さない。ignoreBOM: BOM を落とさず JSON.parse に渡して
    // 拒否させる (BOM を落として検査すると、逐語転送する bytes と解釈が食い違う・SEC-HS-7)。
    // 空 body も JSON.parse が拒否する (daemon は空 body を返さない)。
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return fail("bad_response");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("bad_response");
  }
  return raw;
}

/**
 * stderr の固定文言。入力から来る値を含まない (cause は closed enum)。
 * exit 2 の stderr は CC が block 理由として Claude に見せる (上流 hooks docs) ので、gate を外す手順を
 * 書かない (SEC-HS-3)。
 */
export function formatHookShimStderr(cause: HookShimCause): string {
  return `actradeck hook-shim: blocked PreToolUse (cause=${cause})\n${HOOK_SHIM_BLOCK_MESSAGE}\n`;
}

/**
 * shim 本体。process に触れない (exit / write は entry 側)。例外は投げない。
 */
export async function runHookShim(
  argv: readonly string[],
  io: HookShimIo,
): Promise<HookShimResult> {
  let args: ShimArgs;
  try {
    args = parseHookShimArgs(argv);
  } catch {
    // 引数が読めない = on-unreachable も deadline も信用できない → 常に block。
    await drainInput(io.stdin, HOOK_SHIM_BAD_ARGS_DRAIN_MS);
    return { exitCode: EXIT_BLOCK, stderr: formatHookShimStderr("bad_args") };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ShimFailure("deadline")), args.deadlineMs);
  });
  // 処理が先に決着した後で deadline の reject が unhandled にならないよう吸収しておく。
  deadline.catch(() => undefined);

  try {
    const work = (async () => {
      // stdin を先に読み切る: token が無い等の早期失敗でも書き手側に EPIPE を起こさない (SEC-HS-10)。
      const input = await readInput(io.stdin);
      const token = await readToken(args, io);
      return forward(args, token, input, controller.signal);
    })();
    work.catch(() => undefined);
    const out = await Promise.race([work, deadline]);
    // 200 JSON は mode によらず転送する (allow でも daemon の deny を捨てない・QA-HS-1)。
    return { exitCode: EXIT_ALLOW, stdout: out };
  } catch (e) {
    // work 内の失敗は各段が ShimFailure に写像する。ShimFailure でないのは stdin の読取りエラー
    // (fd が閉じている等) だけで、daemon に問い合わせられなかったものとして unreachable に倒す。
    const cause: HookShimCause = e instanceof ShimFailure ? e.reason : "unreachable";
    if (args.onUnreachable === "allow") return { exitCode: EXIT_ALLOW };
    return { exitCode: EXIT_BLOCK, stderr: formatHookShimStderr(cause) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
