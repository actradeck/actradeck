/**
 * Codex TUI rollout JSONL -> NormalizedEvent.
 *
 * This mapper intentionally does not redact. All candidates are passed to
 * EventSink.emit(), the existing INV-REDACTION choke point.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";

import type {
  CheckKind,
  CheckMatch,
  EventType,
  NormalizedEvent,
  StartKind,
  State,
  WorkItemStatus as WorkItemStatusT,
} from "@actradeck/event-model";
import { parseEvent, WorkItemStatus } from "@actradeck/event-model";

import { classifyCheck } from "./check-classifier.js";
import { assertPayloadConsistency } from "./event-factory.js";

export interface CodexRolloutLine {
  readonly type: string;
  readonly payload?: unknown;
  readonly timestamp?: unknown;
}

export interface CodexRolloutNormalizeContext {
  readonly sessionId: string;
  readonly cwd?: string | undefined;
  readonly byteOffset?: number | undefined;
  readonly lineIndex?: number | undefined;
  readonly sourcePath?: string | undefined;
  readonly onWarning?: ((message: string) => void) | undefined;
  /**
   * ADR 0014 Phase 3b-2 (D6/D7) — run lineage。session_meta.payload から tailer が抽出して注入する。
   *
   * - `providerSessionId` = payload.session_id (会話全体で安定・複数 rollout ファイル間で共有) ??
   *   payload.id (この run のファイル id・fallback)。common case (session_id 欠落) は
   *   session_id===provider_session_id。安定 session_id が別値のときだけ両者が乖離する。
   *   全イベントに載る (欠落時 makeEvent が ctx.sessionId へ fallback)。
   * - `resumedFromSessionId` = payload.forked_from_id (**宣言された**継続エッジ)。親 rollout は
   *   **未観測でありうる**し、参照先は per-file run id でなく安定 `session_id` (= provider_session_id)
   *   でありうる (実データに forked_from_id == 安定 session_id の形が実在)。CC 3b-1 の
   *   「in-process で観測した canonical のみ resumed_from に載せる」ゲートとは**意図的に非対称**
   *   (observe-only ゆえ観測ゲート不能・宣言値をそのまま記録する)。消費者 (3c continued-from) は
   *   参照先 run の実在を仮定せず、不在は linked-unknown 表示・self-loop 禁止 (裁定 019fc4c6 TDA-1)。
   *   run 起点 (session.started) のみに載る。parent_thread_id (subagent spawn 階層) は **写像しない**
   *   (継続でない・over-claim 回避)。
   * - `startKind` = forked_from_id があれば "resume"、無ければ "unknown" (observe-only の正直さ・
   *   fresh と断定しない)。run 起点のみに載る。
   */
  readonly providerSessionId?: string | undefined;
  readonly resumedFromSessionId?: string | undefined;
  readonly startKind?: StartKind | undefined;
  /**
   * ADR 0015 §D6 (B1): function_call ↔ function_call_output を call_id で相関する per-file 状態。
   * tailer が FileRuntime ごとに 1 つ生成して注入する。無ければ相関しない (per-line stateless 縮退・
   * check_kind は command.completed へ乗らず update_plan ack の de-orphan もされない — 安全側)。
   */
  readonly callCorrelation?: RolloutCallCorrelation | undefined;
}

/** 相関に記録する function_call の要点 (name + 分類済 check・NO-RAW: 生 command は保持しない)。 */
export interface RolloutCallInfo {
  readonly name: string | undefined;
  readonly checkKind?: CheckKind | undefined;
  readonly checkMatch?: CheckMatch | undefined;
}

/** call_id ごとの記録上限 (DoS 境界)。超過は最古 FIFO 破棄 = 相関喪失 → bare/no-flip の安全側縮退。 */
const MAX_CORRELATION_ENTRIES = 4096;

/**
 * function_call → function_call_output を call_id で結ぶ per-file 相関 (§D6/B1・TDA-5)。
 *
 * rollout は 1 行ずつ stateless に正規化されるため、`command.completed` (= function_call_output) 側は
 * command 文字列を持たない。check_kind を completed へ乗せるには、対応する function_call (started 側・
 * command あり) で分類した結果を call_id で引き継ぐ必要がある。同じ相関が update_plan ack の de-orphan
 * (TDA-5: ack を command.completed へ誤対応させない) にも使われる。
 *
 * 実データ照合 (decision 019fc7d8): call_id は function_call↔output を 100% (17003/17003) 相関し、
 * function_call は全件 call_id を持つ。相関喪失 (daemon 再起動跨ぎ等) は bare orphan / check 非付与へ
 * 安全に縮退する (fold は check_kind 無しの completed を無視・A2 pin と同性質)。
 */
export class RolloutCallCorrelation {
  private readonly map = new Map<string, RolloutCallInfo>();

  record(callId: string | undefined, info: RolloutCallInfo): void {
    if (callId === undefined || callId.length === 0) return;
    if (this.map.size >= MAX_CORRELATION_ENTRIES && !this.map.has(callId)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(callId, info);
  }

  /** 記録を取り出して消費する (output は call ごとに 1 回ゆえ take-once)。 */
  take(callId: string | undefined): RolloutCallInfo | undefined {
    if (callId === undefined || callId.length === 0) return undefined;
    const v = this.map.get(callId);
    if (v !== undefined) this.map.delete(callId);
    return v;
  }
}

const EXIT_TEXT_RE = /[Pp]rocess exited with code (-?\d+)/;

/**
 * function_call_output.output から exit code を抽出する (§D6/B1・real-data 照合済・decision 019fc7d8)。
 *
 * 2 形態 (両方 real):
 *  (1) **構造化** — output が JSON object へ parse でき `metadata.exit_code` が整数 (legacy 2025 rollout +
 *      structured output を出す外部 adapter)。非 spoofable。
 *  (2) **harness テキスト** — current codex (2026) は output を平文で書き、harness header
 *      (`Chunk ID:.. / Wall time:.. / Process exited with code N / .. / Output:\n<stdout>`) の
 *      **最初の "Output:" マーカーより前**に exit を書く。header 限定で照合するのが **spoof 耐性の要**:
 *      コマンド stdout は "Output:" の**後**に出るため header を偽装できない (real-data 5075/5075 で
 *      exit は必ず header 側・body のみ出現ゼロ)。
 *  (3) どちらでもない → undefined (= 結果不明・fold は verification_state を動かさない・受入 12)。
 *
 * 戻り値は整数のみ (NO-RAW: 生テキストを保持しない)。ReDoS 安全 (固定パターン + header slice で有界)。
 */
export function extractRolloutExitCode(output: string | undefined): number | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;
  // (1) 構造化 metadata.exit_code (非 spoofable)。
  const structured = asNumber(asParams(parseJsonObject(output).metadata).exit_code);
  if (structured !== undefined && Number.isInteger(structured)) return structured;
  // (2) harness header の "Process exited with code N" ("Output:" マーカー前のみ)。
  const nlIdx = output.indexOf("\nOutput:");
  const markerIdx = nlIdx >= 0 ? nlIdx : output.startsWith("Output:") ? 0 : -1;
  if (markerIdx < 0) return undefined; // マーカー無し → header 特定不能 → 抽出しない (安全側・非捏造)。
  const m = EXIT_TEXT_RE.exec(output.slice(0, markerIdx));
  if (m === null) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * session_meta.payload から run lineage (D6/D7) を導出する **単一出所** (tailer が呼ぶ)。
 * ここに写像規律を集約し、tailer 側に散らさない (security-gate-reuse-canonical-parser 精神)。
 *
 * - `providerSessionId` = 安定 `session_id` ?? run `id` (どちらも無ければ undefined → ctx.sessionId fallback)。
 * - `resumedFromSessionId` = `forked_from_id` (非空時のみ)。**`parent_thread_id` は使わない**
 *   (subagent spawn 階層であって resume/continuation ではない・resumed_from の意味論を汚さない)。
 * - `startKind` = forked_from_id があれば "resume"、無ければ "unknown"。
 */
export function rolloutStartLineage(p: Record<string, unknown>): {
  providerSessionId: string | undefined;
  resumedFromSessionId: string | undefined;
  startKind: StartKind;
} {
  const id = asString(p.id);
  const stable = asString(p.session_id);
  const forked = asString(p.forked_from_id);
  const providerSessionId = stable !== undefined && stable.length > 0 ? stable : id;
  const resumedFromSessionId = forked !== undefined && forked.length > 0 ? forked : undefined;
  return {
    providerSessionId,
    resumedFromSessionId,
    startKind: resumedFromSessionId !== undefined ? "resume" : "unknown",
  };
}

type Params = Record<string, unknown>;

function asParams(value: unknown): Params {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Params)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(value: unknown): Params {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return asParams(JSON.parse(value));
  } catch {
    return {};
  }
}

function warn(ctx: CodexRolloutNormalizeContext, message: string): void {
  ctx.onWarning?.(message);
}

function lineTimestamp(line: CodexRolloutLine, p: Params): string {
  const candidates = [line.timestamp, p.timestamp, p.started_at, p.completed_at];
  for (const c of candidates) {
    const s = asString(c);
    if (s !== undefined && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  }
  return new Date().toISOString();
}

function stableUuidV7(seed: string, timestamp: string): string {
  const hash = createHash("sha256").update(seed).digest();
  const bytes = Buffer.alloc(16);
  const parsed = Date.parse(timestamp);
  let ms = BigInt(Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = 0x70 | (hash[0]! & 0x0f);
  bytes[7] = hash[1]!;
  bytes[8] = 0x80 | (hash[2]! & 0x3f);
  for (let i = 9; i < 16; i++) bytes[i] = hash[i - 6]!;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stableRolloutEventId(args: {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly byteOffset?: number | undefined;
  readonly lineIndex?: number | undefined;
  readonly sourcePath?: string | undefined;
  readonly eventIndex?: number | undefined;
}): string {
  const position = args.byteOffset ?? args.lineIndex ?? 0;
  // QA-1: seed に rollout ファイル名 (basename) を含める。同一 threadUUID の複数 rollout
  //   (codex resume が同 sessionId で新ファイルを書く) で (同 offset ∧ 同 timestamp) でも
  //   event_id が衝突せず、ON CONFLICT DO NOTHING による別ファイルのイベント silent drop を防ぐ。
  //   basename は rollout ファイル名 (timestamp+UUID 入りで一意) ゆえ CODEX_HOME 移動にも頑健。
  const fileTag = args.sourcePath !== undefined ? basename(args.sourcePath) : "";
  const seed = [
    "codex-rollout",
    args.sessionId,
    fileTag,
    String(position),
    String(args.eventIndex ?? 0),
  ].join(":");
  return stableUuidV7(seed, args.timestamp);
}

function makeEvent(
  ctx: CodexRolloutNormalizeContext,
  line: CodexRolloutLine,
  p: Params,
  eventType: EventType,
  state: State | undefined,
  extra: {
    readonly eventIndex?: number | undefined;
    readonly turnId?: string | undefined;
    readonly summary?: string | undefined;
    readonly payload?: Params | undefined;
    readonly metrics?: Record<string, number> | undefined;
    readonly cwd?: string | undefined;
  },
): NormalizedEvent {
  const timestamp = lineTimestamp(line, p);
  const candidate: Record<string, unknown> = {
    event_id: stableRolloutEventId({
      sessionId: ctx.sessionId,
      timestamp,
      byteOffset: ctx.byteOffset,
      lineIndex: ctx.lineIndex,
      sourcePath: ctx.sourcePath,
      eventIndex: extra.eventIndex,
    }),
    provider: "codex",
    source: "rollout",
    capture_mode: "codex_rollout",
    session_id: ctx.sessionId,
    // ADR 0014 Phase 3b-2 (D4/D6): provider_session_id は安定 session_id (会話全体で共有) を優先。
    //   session_meta が安定 session_id を宣言したときだけ session_id (= run/ファイル id) と乖離する。
    //   欠落時 (mid-stream primed file 等) は run id へ fallback (common case は両者同値)。
    provider_session_id: ctx.providerSessionId ?? ctx.sessionId,
    event_type: eventType,
    timestamp,
    payload: { kind: eventType, ...(extra.payload ?? {}) },
    metrics: extra.metrics ?? {},
  };
  // ADR 0014 Phase 3b-2: lineage エッジ (start_kind / resumed_from_session_id) は run 起点イベント
  //   (session.started) にのみ載せる。1-file-1-run ゆえ session_meta が唯一の起点。backend 3a の
  //   sticky (first-wins) が起点値を確定する。over-claim 回避で forked_from_id があるときだけ resume。
  if (eventType === "session.started") {
    if (ctx.startKind !== undefined) candidate.start_kind = ctx.startKind;
    if (ctx.resumedFromSessionId !== undefined)
      candidate.resumed_from_session_id = ctx.resumedFromSessionId;
  }
  if (state !== undefined) candidate.state = state;
  const turnId = extra.turnId ?? asString(p.turn_id) ?? asString(p.turnId);
  if (turnId !== undefined) candidate.turn_id = turnId;
  const cwd = extra.cwd ?? asString(p.cwd) ?? ctx.cwd;
  if (cwd !== undefined) candidate.cwd = cwd;
  if (extra.summary !== undefined) candidate.summary = extra.summary;

  const event = parseEvent(candidate);
  assertPayloadConsistency(event);
  return event;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const obj = asParams(item);
    const text = asString(obj.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function reasoningText(summary: unknown): string {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const item of summary) {
    const obj = asParams(item);
    const text = asString(obj.text) ?? asString(obj.summary);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("");
}

function toolNameFromNamespace(
  namespace: string | undefined,
  name: string | undefined,
): {
  server: string;
  tool: string;
} {
  const ns = namespace?.startsWith("mcp__") ? namespace.slice("mcp__".length) : namespace;
  return { server: ns ?? "unknown", tool: name ?? "unknown" };
}

/** WorkItemStatus の closed-enum gate (§D2)。未知/非文字列は "unknown" (forward-compat 安全側)。 */
function gateWorkItemStatus(v: unknown): WorkItemStatusT {
  const r = WorkItemStatus.safeParse(v);
  return r.success ? r.data : "unknown";
}

/**
 * update_plan function_call の arguments から typed plan items + legacy steps を導出する (§D2/A2)。
 * `{"plan":[{"step":str,"status":str}]}` を parse し、status を WorkItemStatus へ gate する。
 * arguments が parse 不能 / plan 非配列なら **undefined** (= items 欠落・legacy 相当)。
 * step 欠落エントリは飛ばす。id は付けない (fold が step テキスト hash で導出・§D3)。
 */
function planFromUpdatePlan(
  args: Params,
): { items: Array<{ step: string; status: WorkItemStatusT }>; steps: string[] } | undefined {
  const plan = args.plan;
  if (!Array.isArray(plan)) return undefined;
  const items: Array<{ step: string; status: WorkItemStatusT }> = [];
  const steps: string[] = [];
  for (const raw of plan) {
    const o = asParams(raw);
    const step = asString(o.step);
    if (step === undefined) continue;
    items.push({ step, status: gateWorkItemStatus(asString(o.status)) });
    steps.push(step);
  }
  return { items, steps };
}

function commandFromArguments(name: string | undefined, args: Params): string {
  return (
    asString(args.cmd) ??
    asString(args.command) ??
    asString(args.input) ??
    asString(args.query) ??
    name ??
    "unknown"
  );
}

function elapsedMs(duration: unknown): number | undefined {
  const d = asParams(duration);
  const secs = asNumber(d.secs);
  const nanos = asNumber(d.nanos);
  if (secs === undefined && nanos === undefined) return undefined;
  return (secs ?? 0) * 1000 + Math.round((nanos ?? 0) / 1_000_000);
}

function changedPaths(changes: unknown): string[] {
  if (Array.isArray(changes)) {
    return changes
      .map((c) => asString(asParams(c).path))
      .filter((p): p is string => p !== undefined);
  }
  const obj = asParams(changes);
  return Object.keys(obj);
}

function hashUnknown(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function normalizeResponseItem(
  ctx: CodexRolloutNormalizeContext,
  line: CodexRolloutLine,
  p: Params,
): NormalizedEvent[] {
  const payloadType = asString(p.type);
  switch (payloadType) {
    case "message": {
      const role = asString(p.role);
      if (role !== "assistant") return [];
      const text = contentText(p.content);
      if (text === undefined) return [];
      return [
        makeEvent(ctx, line, p, "agent.message.delta", "running.model_streaming", {
          payload: { delta: text, role },
        }),
      ];
    }

    case "reasoning":
      return [
        makeEvent(ctx, line, p, "agent.reasoning_summary.delta", "running.model_streaming", {
          payload: { delta: reasoningText(p.summary) },
        }),
      ];

    case "function_call": {
      const name = asString(p.name);
      const namespace = asString(p.namespace);
      const args = parseJsonObject(p.arguments);
      const callId = asString(p.call_id);

      // ADR 0015 §D2/A2: update_plan は plan snapshot であって command ではない。専用 case で
      //   turn.plan.updated (typed items + legacy steps) を emit し、generic function_call →
      //   command.started の誤ルート (command ストリーム汚染) を**構造的に排除**する。arguments が
      //   parse 不能なら items 欠落 (legacy 相当) とし、それでも command.started へは落とさない。
      //   対応する function_call_output ("Plan updated" ack) は check_kind を持たないため、
      //   command.completed になっても work-items fold の検証束縛には一切入らない (§D6・誤対応しない)。
      if (name === "update_plan") {
        // TDA-5 (B1): この plan snapshot に対する function_call_output ("Plan updated" ack) を、
        //   後段で command.completed へ誤対応させない (de-orphan) ため call_id→name を記録する。
        ctx.callCorrelation?.record(callId, { name: "update_plan" });
        const parsed = planFromUpdatePlan(args);
        const explanation = asString(args.explanation);
        const payload: Params = {};
        if (explanation !== undefined) payload.plan = explanation; // legacy `plan` = 説明文字列。
        if (parsed !== undefined) {
          payload.steps = parsed.steps; // legacy steps (旧 consumer 向けに維持)。
          payload.items = parsed.items; // typed items (per-step status・§D2 upgrade path)。
        }
        return [
          makeEvent(ctx, line, p, "turn.plan.updated", "running.planning", {
            summary: explanation ?? `Plan updated (${parsed?.items.length ?? 0} steps)`,
            payload,
          }),
        ];
      }

      if (namespace?.startsWith("mcp__")) {
        const tool = toolNameFromNamespace(namespace, name);
        return [
          makeEvent(ctx, line, p, "mcp.call.started", "running.mcp_tool_calling", {
            summary: `MCP: ${tool.server}/${tool.tool}`,
            payload: {
              server: tool.server,
              tool: tool.tool,
              arguments: args,
              ...(callId !== undefined ? { request_id: callId } : {}),
            },
          }),
        ];
      }
      const command = commandFromArguments(name, args);
      // ADR 0015 §D6 (B1): check 分類 (raw command・closed enum のみ)。started 側に載せ run_dirty 窓を開く。
      //   command 文字列は function_call_output 側に無いため、completed へ check_kind を引き継ぐには
      //   call_id 相関で記録する (実データ照合済・decision 019fc7d8)。
      const check = classifyCheck(command);
      ctx.callCorrelation?.record(callId, {
        name,
        ...(check !== undefined
          ? { checkKind: check.check_kind, checkMatch: check.check_match }
          : {}),
      });
      return [
        makeEvent(ctx, line, p, "command.started", "running.command_executing", {
          summary: `Command: ${command}`,
          cwd: asString(args.workdir) ?? asString(args.cwd) ?? ctx.cwd,
          payload: {
            command,
            ...(check !== undefined
              ? { check_kind: check.check_kind, check_match: check.check_match }
              : {}),
            ...(asString(args.workdir) !== undefined ? { cwd: asString(args.workdir) } : {}),
            ...(callId !== undefined ? { request_id: callId } : {}),
            arguments: args,
            tool_name: name,
          },
        }),
      ];
    }

    case "function_call_output": {
      const output = asString(p.output) ?? "";
      const callId = asString(p.call_id);
      const info = ctx.callCorrelation?.take(callId);
      // TDA-5 (B1): update_plan の ack ("Plan updated") は plan snapshot の副産物ゆえ command
      //   ストリームへ一切出さない (bare orphan command.completed / output delta を抑止する = de-orphan)。
      //   相関が取れないとき (相関喪失) は従来どおり bare command.completed が出るが check_kind 無しゆえ
      //   fold は無反応 (A2 pin と同性質・安全側縮退)。
      if (info?.name === "update_plan") return [];
      const events: NormalizedEvent[] = [];
      if (output.length > 0) {
        events.push(
          makeEvent(ctx, line, p, "command.output.delta", "running.command_executing", {
            eventIndex: 0,
            payload: { stream: "stdout", delta: output, ...(callId ? { request_id: callId } : {}) },
          }),
        );
      }
      // §D6 (B1): exit code を harness 出力から抽出 (非 spoofable・§extractRolloutExitCode)。
      //   check_kind/check_match は対応 function_call (started) で分類した結果を call_id 相関で引き継ぐ。
      //   欠落時 (exit 抽出不能 or 相関喪失) は当該 field を載せない → fold は verification_state 不動 (受入 12)。
      const exitCode = extractRolloutExitCode(output);
      events.push(
        makeEvent(ctx, line, p, "command.completed", "running.model_wait", {
          eventIndex: events.length,
          summary:
            exitCode !== undefined ? `Command completed (exit ${exitCode})` : "Command completed",
          payload: {
            ...(callId ? { request_id: callId } : {}),
            ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
            ...(info?.checkKind !== undefined
              ? { check_kind: info.checkKind, check_match: info.checkMatch }
              : {}),
          },
        }),
      );
      return events;
    }

    case "custom_tool_call": {
      const name = asString(p.name) ?? "custom_tool";
      return [
        makeEvent(ctx, line, p, "tool.started", "running.tool_preparing", {
          payload: { tool_name: name, input: p.input, status: p.status },
        }),
      ];
    }

    case "custom_tool_call_output":
      return [
        makeEvent(ctx, line, p, "tool.completed", "running.model_wait", {
          payload: {
            tool_name: "custom_tool",
            output: p.output,
            ...(asString(p.call_id) ? { request_id: asString(p.call_id) } : {}),
          },
        }),
      ];

    case "tool_search_call":
      return [
        makeEvent(ctx, line, p, "tool.started", "running.tool_preparing", {
          payload: { tool_name: "tool_search", input: parseJsonObject(p.arguments) },
        }),
      ];

    case "tool_search_output":
      return [
        makeEvent(ctx, line, p, "tool.completed", "running.model_wait", {
          payload: { tool_name: "tool_search", output: p.tools ?? p.execution ?? p.status },
        }),
      ];

    case "web_search_call": {
      const action = asParams(p.action);
      return [
        makeEvent(ctx, line, p, "web.search.started", "running.web_searching", {
          payload: { query: asString(action.query) ?? "" },
        }),
      ];
    }

    default:
      warn(ctx, `unknown response_item payload.type=${payloadType ?? "unknown"}`);
      return [];
  }
}

function normalizeEventMsg(
  ctx: CodexRolloutNormalizeContext,
  line: CodexRolloutLine,
  p: Params,
): NormalizedEvent[] {
  const payloadType = asString(p.type);
  switch (payloadType) {
    case "task_started":
      return [
        makeEvent(ctx, line, p, "turn.started", "running.model_wait", {
          turnId: asString(p.turn_id),
          summary: "Turn started",
          payload: {
            model_context_window: p.model_context_window,
            collaboration_mode_kind: p.collaboration_mode_kind,
          },
        }),
      ];

    case "task_complete": {
      const metrics: Record<string, number> = {};
      const duration = asNumber(p.duration_ms);
      const ttft = asNumber(p.time_to_first_token_ms);
      if (duration !== undefined) metrics.elapsed_ms = duration;
      if (ttft !== undefined) metrics.time_to_first_token_ms = ttft;
      return [
        makeEvent(ctx, line, p, "turn.completed", undefined, {
          turnId: asString(p.turn_id),
          summary: "Turn completed",
          payload: { last_agent_message: p.last_agent_message },
          metrics,
        }),
      ];
    }

    case "turn_aborted":
      // ADR 0014 Phase 1 (terminal poisoning 修正): turn の中断は **turn の結果**であり
      //   **session の終端ではない**。以前は state=`failed` (terminal) へ落とし、以降のイベント
      //   (新 turn・resume) を projection が凍結・無視していた (live correctness bug)。turn.failed
      //   イベントは維持しつつ state は非 terminal `idle` (= 次 turn 待ち) にし、「失敗」は直交軸
      //   `last_turn_outcome` (reducer が event_type=turn.failed から導出) で表す。次の task_started
      //   (idle→running.model_wait) が正常に projection される (受入#1)。
      return [
        makeEvent(ctx, line, p, "turn.failed", "idle", {
          turnId: asString(p.turn_id),
          summary: "Turn aborted",
          payload: { error: asString(p.reason) ?? "turn aborted", reason: p.reason },
          metrics:
            asNumber(p.duration_ms) !== undefined ? { elapsed_ms: asNumber(p.duration_ms)! } : {},
        }),
      ];

    case "agent_message": {
      const message = asString(p.message);
      if (message === undefined) return [];
      return [
        makeEvent(ctx, line, p, "agent.message.delta", "running.model_streaming", {
          payload: { delta: message, phase: p.phase },
        }),
      ];
    }

    case "user_message": {
      const message = asString(p.message) ?? contentText(p.text_elements);
      if (message === undefined) return [];
      return [
        makeEvent(ctx, line, p, "turn.started", "running.model_wait", {
          summary: "User message",
          payload: { prompt_summary: message, gap_source: "event_msg/user_message" },
        }),
      ];
    }

    case "mcp_tool_call_end": {
      const invocation = asParams(p.invocation);
      const duration = elapsedMs(p.duration);
      return [
        makeEvent(ctx, line, p, "mcp.call.completed", "running.model_wait", {
          summary: "MCP call completed",
          payload: {
            server: asString(invocation.server),
            tool: asString(invocation.tool),
            result: p.result,
            ...(asString(p.call_id) ? { request_id: asString(p.call_id) } : {}),
          },
          metrics: duration !== undefined ? { elapsed_ms: duration } : {},
        }),
      ];
    }

    case "patch_apply_end": {
      const paths = changedPaths(p.changes);
      const firstPath = paths[0] ?? "unknown";
      return [
        makeEvent(ctx, line, p, "file.change.applied", "running.model_wait", {
          eventIndex: 0,
          summary: "Patch applied",
          payload: {
            path: firstPath,
            changed_files: paths.length,
            paths,
            status: p.status,
            success: p.success,
          },
        }),
        makeEvent(ctx, line, p, "diff.updated", "running.file_editing", {
          eventIndex: 1,
          summary: "Patch diff updated",
          payload: {
            diff_hash: hashUnknown(p.changes),
            changed_files: paths.length,
            changes: p.changes,
            stdout: p.stdout,
            stderr: p.stderr,
            status: p.status,
            success: p.success,
          },
        }),
      ];
    }

    case "context_compacted":
      return [
        makeEvent(ctx, line, p, "context.compacted", "compacting", {
          payload: { trigger: "auto" },
          summary: "Context compacted",
        }),
      ];

    case "thread_goal_updated": {
      const goal = asString(p.goal) ?? JSON.stringify(p.goal ?? "");
      return [
        makeEvent(ctx, line, p, "turn.plan.updated", "running.planning", {
          turnId: asString(p.turnId),
          summary: "Thread goal updated",
          payload: { plan: goal },
        }),
      ];
    }

    case "web_search_end":
    case "token_count":
      return [];

    default:
      warn(ctx, `unknown event_msg payload.type=${payloadType ?? "unknown"}`);
      return [];
  }
}

export function normalizeRolloutLine(
  line: CodexRolloutLine,
  ctx: CodexRolloutNormalizeContext,
): NormalizedEvent[] {
  const p = asParams(line.payload);

  try {
    switch (line.type) {
      case "session_meta": {
        const cwd = asString(p.cwd) ?? ctx.cwd;
        return [
          makeEvent(ctx, line, p, "session.started", "starting", {
            summary: "Codex rollout session started",
            cwd,
            payload: {
              cwd,
              originator: p.originator,
              cli_version: p.cli_version,
              model_provider: p.model_provider,
              source: p.source,
              thread_source: p.thread_source,
              // ADR 0014 Phase 3b-2: parent_thread_id は subagent spawn 階層 (継続でない) ゆえ
              //   resumed_from_session_id には写像せず payload-only の観測情報として残す。
              parent_thread_id: p.parent_thread_id,
              git: p.git,
            },
          }),
        ];
      }

      case "turn_context":
        return [];

      case "response_item":
        return normalizeResponseItem(ctx, line, p);

      case "event_msg":
        return normalizeEventMsg(ctx, line, p);

      case "compacted":
        return [
          makeEvent(ctx, line, p, "context.compacted", "compacting", {
            summary: "Context compacted",
            payload: { trigger: "auto", replacement_history: p.replacement_history },
          }),
        ];

      default:
        warn(ctx, `unknown rollout type=${line.type}`);
        return [];
    }
  } catch (err) {
    warn(
      ctx,
      `failed to normalize rollout type=${line.type}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export function sessionIdFromRolloutPath(path: string): string | undefined {
  const match =
    /rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match?.[1];
}
