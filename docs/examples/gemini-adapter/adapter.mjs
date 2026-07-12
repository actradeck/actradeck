/**
 * ActraDeck 外部アダプタ第2号 — Gemini CLI hook adapter (ADR 019f426e-a783).
 *
 * Gemini CLI (https://geminicli.com) の hooks を ActraDeck の NormalizedEvent へ写像し、
 * backend の `POST /ingest` へ直接送る、**依存ゼロ** (Node 組込みのみ) の単一ファイル script です。
 * opencode adapter (plugin・常駐プロセス) と違い、これは hook の `type:"command"` として
 * **1 イベントにつき 1 回起動される短命プロセス** です (stdin に 1 つの hook JSON が来る)。
 *
 *   provider = "gemini"     (WHO・公開契約の slug 開放・docs/ingestion-contract.md §4.1)
 *   source   = "external"   (HOW・第三者直取込の closed enum 値・§4.2)
 *   capture_mode 省略        (観測モード enum に external 値を足さない・ADR D4)
 *   request_id = "tu:<hash>" (run_shell_command の before/after を相関させる決定的キー・下記)
 *
 * ── observe-only / never-deny (Gemini 固有 INV・ADR 契約2) ────────────────────
 * 本 script は **常に stdout へ `{}` のみを書き exit 0** で終わります。不正入力・POST 失敗・
 * env 未設定・写像 throw の**いずれでも** `{}`/exit 0 です。出力に decision / continue /
 * stopReason / hookSpecificOutput を**一切含めず**、exit 2 も返しません。エージェントの挙動へ
 * 介入しない純観測です (INV-GEMINI-ADAPTER-NEVER-DENY が subprocess で回帰固定)。
 *
 * ── 配送は per-event at-most-once best-effort (ADR 契約3) ─────────────────────
 * 短命プロセスゆえ opencode の ring/retry は構造的に不可。同期 POST + 短 timeout
 * (~1500ms・hook 既定 timeout に対し安全) を 1 回だけ試み、失敗は silent drop です。
 * INGEST_TOKEN 未設定なら **何も送らず即 `{}`** で終わります (静かに無効)。
 *
 * ── 姿勢の正直な開示 (ADR 契約5・opencode と同一) ────────────────────────────
 * この adapter は **client 側 redaction を持ちません** (依存ゼロのため)。secret に対する
 * 唯一の防御は ActraDeck backend の **ingress redaction 床** (契約 §5・保存前に無条件適用) です。
 * 「マシンを出る前に漏れない」とは **謳いません**。tool_input (read_file の file_path 等) と、
 * **依頼/応答の要約** (BeforeAgent.prompt → payload.prompt_summary・AfterAgent.prompt_response →
 * payload.response_summary・summarize で 1 行化) は送られ、backend 床で初めて redact されます
 * (ADR 019f47c2・ユーザー依頼 / エージェントの公開メッセージは見せてよい 表示許可対象)。
 * SEC-1 (truncate-before-redact straddle leak): adapter は secret を分割しうる小 cap で raw を切詰めず
 * **sanity 上限のみ** で送り (床が secret 全体を見て redact できる)、**表示用の ≤N 有界化は床の後**
 * (backend projection deriveActionSubject が redacted 値を slice) で行います (§ summarize / SUMMARY_SANITY_CAP)。
 * 源流最小化として **AfterTool の tool_response** (llmContent/returnDisplay/PGID) は **一切載せません**
 * (これは「最小化」であって「redaction」ではありません)。依頼/応答は要約 (1 行化) のみで、有界化は床の後です。
 * 信頼境界は single-operator / loopback / INGEST_TOKEN の内側です。
 */

// Node 組込みのみ (依存ゼロ)。`process` は global。
import { pathToFileURL } from "node:url";

// ── 配送パラメータ ───────────────────────────────────────────────────────────
// 短命プロセスの hook。gemini の hook 既定 timeout (60s) に対し十分小さい上限で 1 回だけ POST する。
const DELIVER_TIMEOUT_MS = 1500;
const DEFAULT_INGEST_URL = "http://127.0.0.1:55410";

// ── UUIDv7 自前実装 (event_id 必須・依存ゼロ) ────────────────────────────────
// ActraDeck の event_id は UUIDv7 のみ受理 (crypto.randomUUID は v4 で reject される)。
// globalThis.crypto (Web Crypto) は Node 22+ で global に存在するため import 不要。
//
// 相互参照 (UUIDv7 の hand-rolled 実装はリポジトリ内に **4 箇所**):
//   (1) 本ファイル (docs/examples/gemini-adapter/adapter.mjs・外部 adapter・依存ゼロ制約)、
//   (2) docs/examples/opencode-adapter/adapter.js (外部 adapter #1・同・依存ゼロ)、
//   (3) docs/examples/ingest-adapter/adapter.mjs (最小取込 adapter 例・同)、
//   (4) packages/event-model/src/id.ts (T1 正典・uuid@11 の v7 を使用)。
//   (1)(2)(3) は「読者がコピペして動く単一ファイル」制約のため意図的に自前化しており正典 (4) へ
//   依存しない (共通化しない設計判断)。ビット配置 (version 7 / variant 10xx) は 4 者で一致させる。
function randomBytes16() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function uuidv7() {
  const ms = Date.now();
  const b = randomBytes16();
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── tool call 相関キー (request_id) ──────────────────────────────────────────
// 実捕獲 (gemini 0.42.0) の BeforeTool/AfterTool には opencode の callID 相当が **無い**
// (base + tool_name + tool_input のみ・AfterTool は +tool_response)。かつ本 adapter は
// **1 イベント 1 プロセス**なので、opencode のような in-memory カウンタでの相関は
// プロセス跨ぎで不可能。よって request_id は **hook 入力だけから決まる決定的関数**にする:
//   同一 tool call の Before と After は同じ tool_name + 同じ tool_input を持つ (実捕獲で確認)
//   ため、両者から同じ request_id が算出され相関する。request_id は tool_name + 安定シリアライズ
//   tool_input (run_shell_command では {command, description}) の djb2 ハッシュゆえ **command も
//   ハッシュ入力に含む**が、request_id **値** は command を露出しない (djb2 は一方向・8hex から
//   command を復元できない)。command 自体は既に payload.command へ verbatim 搭載済みで、request_id
//   が新たな開示チャネルを作るわけではない。
//   限界 (正直な開示): 全く同一の tool call が同一 session 内で 2 回起きると request_id が衝突する
//   (callID が無いため区別不能)。at-most-once 観測での marginal な相関損失として許容する。
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function djb2Hex(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; // h*33 + c (unsigned 32-bit)
  }
  return h.toString(16).padStart(8, "0");
}

/** tool_name + 安定 tool_input から決定的な相関 request_id (`tu:` 名前空間・INV-REQUEST-ID-NAMESPACE)。 */
function toolRequestId(toolName, toolInput) {
  return `tu:${djb2Hex(`${String(toolName ?? "tool")} ${stableStringify(toolInput ?? {})}`)}`;
}

// ── 依頼/応答の要約 (summarize) ──────────────────────────────────────────────
// ユーザー依頼 (BeforeAgent.prompt) と エージェント応答 (AfterAgent.prompt_response) を
// 「改行/連続空白を単一空白へ畳む」1 行化する依存ゼロ純関数 (ADR 019f47c2)。表示ポリシー
// 「見せてよい: ユーザー依頼 / エージェントの公開メッセージ」に該当し、Claude Code の
// UserPromptSubmit → `依頼: <summarize(prompt)>` (normalize.ts) と同値意味論を持つ。
//
// **secret redaction は adapter でやらない** (依存ゼロ・§ 開示のとおり唯一の防御は backend の
// ingress redaction 床)。backend は payload の値 (この要約含む) を保存前に無条件 redaction する (契約 §5)。
//
// ── SEC-1 (truncate-before-redact straddle leak・CONDITIONAL 019f47f0 の unblock) ─────────────
// 【重要】prompt/response では **secret を分割しうる小 cap で truncate してはならない**。以前は cap=200 で
// raw を切詰めてから床が redact していたため、secret の頭が 200 内・尾が切られると残 prefix が redaction
// ルールの最小長 (github {20,255} / high-entropy {40,}) を下回り床が非マッチ → raw partial fragment が
// at-rest 残存した (実 PG 実証・INV-REDACTION-SUMMARY-STRADDLE)。
//   対策 = **床が secret 全体を見てから redact する** ように adapter 側で secret を分割しない。summarize は
//   1 行化 + 巨大入力への **sanity 上限のみ** (SUMMARY_SANITY_CAP) を適用し、表示用の ≤N 有界化は **床の後**で
//   行う (backend projection `deriveActionSubject` が redacted 値を slice する・post-floor)。
//   SUMMARY_SANITY_CAP は redactor の redaction window (`packages/redaction` PRE_REDACT_SLICE ≈ 264KiB) を
//   **超える**値に取ること: adapter の cut がこの window の外に落ちれば、**bounded 捕捉長のルール (token 系・
//   github {20,255} / high-entropy {40,4096} 等)** については、床が自身の margin-safe truncation
//   (redact→truncate・PRE_REDACT_SLICE と MAX_REDACT_INPUT の差 = 2×MAX_VALUE_LEN) で straddle を安全に処理し、
//   adapter が secret を分割した fragment が at-rest に届かない (redactor の window が成長したら本値を上げる)。
//   【scope・正直な開示 (SEC-2)】token 系 bounded-rule の margin-safe 性に加え、**private-key (PEM) も
//   境界跨ぎを含め bounded 化済**である (SEC-2 解消・ADR 019f482a / task 019f482c-0904)。redactor の
//   private-key ルールは terminator (`-----END ... PRIVATE KEY-----`) が pre-redact window 外へ落ちても、
//   `-----BEGIN ... PRIVATE KEY-----` head から window 末尾までを greedy にマスクする fallback を内包し、
//   MAX_REDACT_INPUT / PRE_REDACT_SLICE 境界を跨ぐ**巨大単一行/複数行 PEM** でも raw 露出ゼロを保証する
//   (INV-REDACTION-PEM-STRADDLE が redactor 単体 + real PG で回帰固定)。したがって床は token 系・PEM の
//   双方で境界跨ぎ secret を安全に処理し、この adapter は sanity 上限のみで secret を分割しないため、
//   adapter 経由の straddle leak は (token 系・PEM とも) 無い。
//
// ── sidecar normalize.summarize との意図的 dup (TDA-3) ────────────────────────────────────────
// `apps/sidecar/src/normalize.ts` の `summarize` は **redactString(s) → 1 行化 → slice** の順で redact を先に
// 適用してから小 cap で切詰めるため、CC 経路は adapter と別方式で straddle 安全 (床が secret 全体を見る)。
// 本 adapter は依存ゼロで redact できないため、代わりに「adapter で secret を分割しない (sanity-cap のみ) +
// 有界化は床の後」で同じ性質を達成する。両者は **意図的な dup** (依存ゼロ制約 vs redact 可) であり、
// bound 契約 (単一行・連続空白畳み・ellipsis・キー名 prompt_summary/response_summary) を揃える。
export const SUMMARY_SANITY_CAP = 512 * 1024;

// TDA-2: default cap は **安全側 `SUMMARY_SANITY_CAP`** (小 cap 200 でない)。現 caller (:216/:312) は
// SANITY を明示するため挙動不変だが、将来 `summarize(x)` の cap 省略呼出が 200 で truncate して
// straddle leak を再発させる footgun を default で塞ぐ (INV-GEMINI-ADAPTER-TURN-SUMMARY の pin が回帰固定)。
export function summarize(text, cap = SUMMARY_SANITY_CAP) {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? oneLine.slice(0, cap) + "…" : oneLine;
}

// ── timestamp 正規化 (hook 入力の ISO を pass-through・欠落時のみ now) ─────────
// 短命プロセスゆえ session 毎 floor (opencode の MONOTONIC) は構造的に持てない。hook 入力の
// `timestamp` (実捕獲で常に ISO8601 UTC) をそのまま採用し、単調性は gemini が発火順で timestamp を
// 進める前提に委ねる (ADR 契約7: MONOTONIC は hook input timestamp 単調性の範囲で)。
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function normalizeTimestamp(raw, nowFn) {
  if (typeof raw === "string" && ISO8601_RE.test(raw) && Number.isFinite(Date.parse(raw))) {
    return raw;
  }
  const now = typeof nowFn === "function" ? nowFn : Date.now;
  return new Date(now()).toISOString();
}

// ── NormalizedEvent 組み立て ─────────────────────────────────────────────────
function makeEvent(eventType, { sessionId, ts, state, cwd, summary, payload }) {
  const ev = {
    event_id: uuidv7(),
    provider: "gemini",
    source: "external",
    session_id: sessionId,
    provider_session_id: sessionId,
    event_type: eventType,
    timestamp: ts,
    payload,
  };
  if (state !== undefined) ev.state = state;
  if (typeof cwd === "string" && cwd.length > 0) ev.cwd = cwd;
  if (typeof summary === "string" && summary.length > 0) ev.summary = summary;
  return ev;
}

/**
 * 1 つの Gemini hook 入力 (stdin JSON) を NormalizedEvent[] へ写像する **純関数** (単一出所)。
 * CLI 経路 (main) とテスト (INV-GEMINI-ADAPTER-*) が同じ本関数を通す。写像対象外の hook
 * (Notification / PreCompress / 未知) は **意図的に drop** (空配列)。写像表は README.md 参照。
 *
 * 状態 (state) を跨ぐ集約は一切持たない (per-event process の現実に忠実)。opts.now は
 * timestamp 欠落時のフォールバック用の時刻源 (テスト注入・既定 Date.now)。
 */
export function mapHookEvent(hook, opts = {}) {
  if (!hook || typeof hook !== "object") return [];
  const sessionId = typeof hook.session_id === "string" ? hook.session_id : "";
  if (sessionId.length === 0) return [];
  const cwd = typeof hook.cwd === "string" ? hook.cwd : undefined;
  const ts = normalizeTimestamp(hook.timestamp, opts.now);
  const name = hook.hook_event_name;

  switch (name) {
    // SessionStart → session.started (実終端 SessionEnd と対になる開始シグナル)。
    case "SessionStart":
      return [
        makeEvent("session.started", {
          sessionId,
          ts,
          cwd,
          state: "starting",
          payload: { kind: "session.started" },
        }),
      ];

    // BeforeAgent → turn.started (プロンプト受領・turn 開始相当。opencode の turn.started に倣う)。
    //   依頼要約搭載 (ADR 019f47c2・CC パリティ): prompt を summarize で有界化し
    //   summary「依頼: …」+ payload.prompt_summary に載せる (KPI「何をしているか」回復)。
    //   raw 全文は載せない (有界要約のみ)・secret は backend ingress 床で redaction 済。
    case "BeforeAgent": {
      const prompt = typeof hook.prompt === "string" ? hook.prompt : "";
      // SEC-1: 小 cap で truncate せず sanity 上限のみ (床が secret 全体を見る)。有界化は床の後 (projection)。
      const promptSummary = summarize(prompt, SUMMARY_SANITY_CAP);
      return [
        makeEvent("turn.started", {
          sessionId,
          ts,
          cwd,
          state: "running.model_wait",
          summary: promptSummary ? `依頼: ${promptSummary}` : undefined,
          payload: {
            kind: "turn.started",
            ...(promptSummary ? { prompt_summary: promptSummary } : {}),
          },
        }),
      ];
    }

    // BeforeTool → run_shell_command は command.started / それ以外は tool.started。
    case "BeforeTool": {
      const toolName = hook.tool_name;
      const toolInput = hook.tool_input ?? {};
      if (toolName === "run_shell_command") {
        const command = typeof toolInput.command === "string" ? toolInput.command : "";
        return [
          makeEvent("command.started", {
            sessionId,
            ts,
            cwd,
            state: "running.command_executing",
            summary: command,
            payload: {
              kind: "command.started",
              command,
              request_id: toolRequestId(toolName, toolInput),
            },
          }),
        ];
      }
      // read_file 等の非 shell tool。tool_input は verbatim 転送 (§ 開示・backend 床依存)。
      return [
        makeEvent("tool.started", {
          sessionId,
          ts,
          cwd,
          state: "running.tool_preparing",
          payload: {
            kind: "tool.started",
            tool_name: String(toolName ?? "tool"),
            input: toolInput,
          },
        }),
      ];
    }

    // AfterTool → run_shell_command は command.completed / それ以外は tool.completed。
    //   源流最小化 (INV-GEMINI-ADAPTER-MINIMIZED): tool_response (llmContent = <untrusted_context>
    //   ラップの output 全文 + PGID / returnDisplay) は **一切載せない**。gemini の shell hook は
    //   exit code を返さないため command.completed に exit_code は無い (欠落は正当)。
    case "AfterTool": {
      const toolName = hook.tool_name;
      const toolInput = hook.tool_input ?? {};
      if (toolName === "run_shell_command") {
        const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
        const payload = {
          kind: "command.completed",
          request_id: toolRequestId(toolName, toolInput),
        };
        if (command !== undefined) payload.command = command;
        return [
          makeEvent("command.completed", {
            sessionId,
            ts,
            cwd,
            state: "running.model_wait",
            summary: command,
            payload,
          }),
        ];
      }
      return [
        makeEvent("tool.completed", {
          sessionId,
          ts,
          cwd,
          state: "running.model_wait",
          payload: { kind: "tool.completed", tool_name: String(toolName ?? "tool") },
        }),
      ];
    }

    // AfterAgent → turn.completed(idle)。応答要約搭載 (ADR 019f47c2・エージェントの公開
    //   メッセージ 表示許可): prompt_response を summarize で有界化し summary「応答: …」+
    //   payload.response_summary に載せる。raw 全文は載せない (有界要約のみ)・secret は backend 床で
    //   redaction 済。prompt_response 欠落 (実捕獲では存在) は従来どおり要約なし。
    case "AfterAgent": {
      const response = typeof hook.prompt_response === "string" ? hook.prompt_response : "";
      // SEC-1: 小 cap で truncate せず sanity 上限のみ (床が secret 全体を見る)。有界化は床の後 (projection)。
      const responseSummary = summarize(response, SUMMARY_SANITY_CAP);
      return [
        makeEvent("turn.completed", {
          sessionId,
          ts,
          cwd,
          state: "idle",
          summary: responseSummary ? `応答: ${responseSummary}` : undefined,
          payload: {
            kind: "turn.completed",
            ...(responseSummary ? { response_summary: responseSummary } : {}),
          },
        }),
      ];
    }

    // SessionEnd → session.ended。gemini は **実終端シグナルを持つ**ため終端捏造でなく正当
    //   (INV-GEMINI-ADAPTER-ENDED-ONLY-FROM-SESSIONEND: SessionEnd 由来以外で ended を出さない)。
    case "SessionEnd": {
      const payload = { kind: "session.ended" };
      if (typeof hook.reason === "string" && hook.reason.length > 0) payload.reason = hook.reason;
      return [
        makeEvent("session.ended", {
          sessionId,
          ts,
          cwd,
          state: "completed",
          payload,
        }),
      ];
    }

    // 意図的 drop: Notification / PreCompress / 未知 hook (実捕獲 8 event の写像対象外)。
    default:
      return [];
  }
}

// ── 環境設定 (副作用ゼロ・遅延評価) ───────────────────────────────────────────
export function resolveConfig(env) {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  const url = (e.ACTRADECK_INGEST_URL ?? DEFAULT_INGEST_URL).replace(/\/$/, "");
  const token = e.INGEST_TOKEN ?? "";
  return { url, token, enabled: token.length > 0 };
}

// ── 配送 (per-event at-most-once best-effort・fail-open) ─────────────────────
// 1 回だけ POST を試み、timeout / ネットワーク失敗は silent drop。retry しない (短命プロセス)。
export async function deliverEvents(events, config, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVER_TIMEOUT_MS);
  try {
    await fetchImpl(`${config.url}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(events),
      signal: controller.signal,
    });
  } catch {
    // fail-open: 配送不達は gemini を壊さない (握り潰す)。
  } finally {
    clearTimeout(timer);
  }
}

// ── stdin 読み取り ───────────────────────────────────────────────────────────
function readStdin(stream) {
  const s = stream ?? process.stdin;
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    s.setEncoding?.("utf8");
    s.on("data", (chunk) => {
      data += chunk;
    });
    s.on("end", done);
    s.on("error", done); // fail-open: stdin エラーでも {} を返せるよう空扱いで解決
  });
}

/**
 * CLI エントリ。**常に `{}` を stdout へ書き exit 0** で終わる (never-deny・observe-only)。
 * env 未設定 / 不正 JSON / 写像 throw / POST 失敗の**いずれでも** `{}` を守る。
 * opts (テスト注入・全て任意): env / stdin / fetchImpl / stdout / now。
 */
export async function main(opts = {}) {
  const write = typeof opts.stdout === "function" ? opts.stdout : (s) => process.stdout.write(s);
  try {
    const config = resolveConfig(opts.env);
    if (config.enabled) {
      const raw = await readStdin(opts.stdin);
      const hook = JSON.parse(raw); // 不正 JSON は throw → catch → {} (never-deny)
      const events = mapHookEvent(hook, { now: opts.now });
      if (events.length > 0) {
        await deliverEvents(events, config, { fetchImpl: opts.fetchImpl });
      }
    }
  } catch {
    // fail-open / never-deny: あらゆる失敗を握り潰す。出力は下の `{}` 一択。
  }
  // observe-only: hook 応答は常に空オブジェクト。decision/continue/stopReason/hookSpecificOutput を含めない。
  write("{}\n");
}

// ── エントリポイント検出 (import 時は副作用ゼロ・テスト安全) ──────────────────
const isEntrypoint = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void main();
}
