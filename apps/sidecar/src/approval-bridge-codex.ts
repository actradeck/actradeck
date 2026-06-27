/**
 * Codex 承認双方向写像 (ADR 019ea31b (d)).
 *
 * inbound : codex ServerRequest (item/{commandExecution,fileChange,permissions}/requestApproval
 *           + legacy execCommandApproval / applyPatchApproval) → 既存 ApprovalBridge.requestApproval
 *           を通し UI 承認カード (tool.permission.requested) を emit。
 * outbound: UI の 4 値 ApprovalDecision → codex JSON-RPC Response (decision enum)。
 *
 * 設計規律 (ADR):
 * - **ApprovalBridge は無改変再利用**。本モジュールは「写像 + JSON-RPC id ↔ bridge request_id の
 *   1:1 突合 (INV-CODEX-REQID)」のみを足す。UI カード/relay/SidecarRegistry/control_token は無改変。
 * - JSON-RPC id (string|int64) を string 化して bridge の request_id 名前空間へ持ち込む。
 *   foreign / 未知 id の Response は突合不能 → 無視。
 * - timeout / drain は安全側 deny (= decline / denied)。
 * - **MVP 制限**:
 *   - item/permissions/requestApproval の Response は decision enum でなく GrantedPermissionProfile。
 *     MVP は **deny(= 空 grant) のみ honor**、allow 系 (profile grant) は MVP 除外。
 *   - command の advanced 変種 (acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment) も
 *     MVP 除外 (4 値のみ送出)。
 *
 * redaction: inbound カードに載せるのは redacted フィールドのみ。さらに全イベントは
 *   sink.emit の choke (redactDeep) を通る。本モジュールは raw command/cwd を payload へ
 *   そのまま渡してよい (sink が担保)。
 */
import type { ApprovalDecision } from "@actradeck/event-model";

import type { ApprovalBridge, ApprovalResult, GuardReason } from "./approval-bridge.js";
import type { CodexRequestId } from "./codex-jsonrpc.js";
import type { HookCommonInput } from "./normalize.js";

/** codex 承認 ServerRequest の種別 (Response 形を決める)。 */
type CodexApprovalKind =
  | "command" // item/commandExecution/requestApproval (item-namespaced decision)
  | "file" // item/fileChange/requestApproval (item-namespaced decision)
  | "permissions" // item/permissions/requestApproval (GrantedPermissionProfile)
  | "legacy-exec" // execCommandApproval (ReviewDecision)
  | "legacy-patch"; // applyPatchApproval (ReviewDecision)

/** approval ServerRequest method → kind の対応。未知 method は undefined (= 非承認)。 */
const APPROVAL_METHODS: Readonly<Record<string, CodexApprovalKind>> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file",
  "item/permissions/requestApproval": "permissions",
  execCommandApproval: "legacy-exec",
  applyPatchApproval: "legacy-patch",
};

/** ある method が承認 ServerRequest か。 */
export function isCodexApprovalRequest(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(APPROVAL_METHODS, method);
}

/** inbound カードに渡す正規化済み承認要求 (redacted フィールドのみ)。 */
export interface CodexApprovalCard {
  readonly tool_name: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

/**
 * outbound: 4 値 ApprovalDecision を kind 別の codex decision enum へ写像する。
 *
 * | UI decision        | item-namespaced (command/file) | legacy ReviewDecision |
 * |--------------------|--------------------------------|-----------------------|
 * | allow              | "accept"                       | "approved"            |
 * | allow_for_session  | "acceptForSession"             | "approved_for_session"|
 * | deny               | "decline"                      | "denied"              |
 * | cancel             | "cancel"                       | "abort"               |
 * | timeout/drain      | "decline" (安全側)              | "denied" (安全側)      |
 *
 * 戻り値は JSON-RPC Response の `result` に入れる object。permissions は別経路 (下記)。
 */
export function mapDecisionToItemNamespaced(decision: ApprovalDecision | undefined): {
  decision: string;
} {
  switch (decision) {
    case "allow":
      return { decision: "accept" };
    case "allow_for_session":
      return { decision: "acceptForSession" };
    case "cancel":
      return { decision: "cancel" };
    // deny / undefined(timeout/drain) → 安全側 decline。
    default:
      return { decision: "decline" };
  }
}

export function mapDecisionToReviewDecision(decision: ApprovalDecision | undefined): {
  decision: string;
} {
  switch (decision) {
    case "allow":
      return { decision: "approved" };
    case "allow_for_session":
      return { decision: "approved_for_session" };
    case "cancel":
      return { decision: "abort" };
    // deny / undefined(timeout/drain) → 安全側 denied。
    default:
      return { decision: "denied" };
  }
}

/**
 * permissions の Response (GrantedPermissionProfile)。
 * MVP は **deny(= 空 grant) のみ honor**。allow 系 (profile grant) は MVP 除外のため、
 * decision を問わず **空の grant** (= 何も許可しない = 安全側 deny 相当) を返す。
 * scope は既定 "turn"。
 */
export function mapDecisionToPermissionsResponse(): {
  permissions: Record<string, unknown>;
  scope: string;
} {
  // 空 profile = 追加権限なし (deny 相当)。allow 系は MVP では送出しない。
  return { permissions: {}, scope: "turn" };
}

/** kind に応じた JSON-RPC Response の result を作る。 */
export function buildApprovalResultBody(
  kind: CodexApprovalKind,
  decision: ApprovalDecision | undefined,
): Record<string, unknown> {
  switch (kind) {
    case "command":
    case "file":
      return mapDecisionToItemNamespaced(decision);
    case "legacy-exec":
    case "legacy-patch":
      return mapDecisionToReviewDecision(decision);
    case "permissions":
      return mapDecisionToPermissionsResponse();
  }
}

/** JSON-RPC id を bridge request_id 名前空間へ持ち込むため string 化する。 */
export function codexIdToKey(id: CodexRequestId): string {
  return typeof id === "string" ? id : String(id);
}

export interface CodexApprovalBridgeOptions {
  readonly bridge: ApprovalBridge;
  /** 自 sidecar の canonical / fallback session id を返す (bridge request_id プレフィックス用)。 */
  readonly sessionId: () => string;
  /** UI 承認カードを emit する (sink.emit へ writelidthrough; redaction は sink が担保)。 */
  readonly emitCard: (card: CodexApprovalCard, requestId: string) => void;
  /** 解決した decision を codex へ JSON-RPC Response として送る。 */
  readonly sendResponse: (id: CodexRequestId, result: Record<string, unknown>) => void;
}

/**
 * codex 承認 ServerRequest を受け、ApprovalBridge 経由で UI 承認を待ち、
 * 解決後に codex へ Response を返すブリッジ。
 *
 * INV-CODEX-REQID: 1 つの JSON-RPC id ↔ 1 つの bridge request_id。
 *   突合は codex id → bridge request_id の forward map と、bridge request_id → {id, kind} の
 *   reverse map で 1:1 に保つ。
 */
export class CodexApprovalBridge {
  private readonly bridge: ApprovalBridge;
  private readonly opts: CodexApprovalBridgeOptions;
  /** codex id(string) → 進行中フラグ (二重受信ガード)。 */
  private readonly inFlight = new Set<string>();

  constructor(opts: CodexApprovalBridgeOptions) {
    this.bridge = opts.bridge;
    this.opts = opts;
  }

  /**
   * inbound: codex 承認 ServerRequest を処理する。
   * - 非承認 method は false を返す (呼び出し側が通常 notification 経路へ流す)。
   * - 承認 method は ApprovalBridge.requestApproval を駆動し UI カードを emit、
   *   解決後に codex へ Response を送る (非同期)。true を返す。
   */
  handleServerRequest(id: CodexRequestId, method: string, params: unknown): boolean {
    const kind = APPROVAL_METHODS[method];
    if (kind === undefined) return false;

    const key = codexIdToKey(id);
    // 同一 id の二重受信は無視 (codex は通常 1 回だが防御)。
    if (this.inFlight.has(key)) return true;
    this.inFlight.add(key);

    const p = asParams(params);
    const card = buildCard(kind, p);

    // ApprovalBridge は HookCommonInput で gating する。codex の承認要求は **既に codex が
    // 承認を要求している** ので、hook_event_name="PermissionRequest" で **常にゲート対象** にする
    // (destructive 常時ゲートは不変)。session_id は bridge request_id の
    // プレフィックスに使われる (foreign request_id scope 判定の既存契約と整合)。
    //
    // ADR 019ecc70 段階2: 内容を持つ承認 (command/legacy-exec/legacy-patch) は走査用 tool_name
    //   (Bash/Edit) + tool_input を載せ、ApprovalBridge.detectSecretInInput が secret を検出して
    //   reason (secretKinds) + D5 (allow_for_session auto-allow 非対象) を codex 経路にも効かせる。
    //   file/permissions は本文が params に無く gateInput=undefined → 従来どおり常時ゲートのみ。
    //   NO-RAW: tool_input の raw 内容は述語評価専用で emit されない (card は別途 redacted)。
    const gateInput = buildGateInput(kind, p);
    const input: HookCommonInput = {
      session_id: this.opts.sessionId(),
      hook_event_name: "PermissionRequest",
      tool_name: gateInput?.toolName ?? card.tool_name,
      ...(gateInput !== undefined ? { tool_input: gateInput.toolInput } : {}),
    };

    void this.bridge
      .requestApproval(input, (requestId: string, reason: GuardReason) => {
        // JSON-RPC id ↔ bridge request_id を 1:1 で対応づける。
        this.forward.set(key, requestId);
        this.reverse.set(requestId, { id, kind });
        // ADR 019ecc70 段階2: guard reason (trigger / secret_kinds) を card payload へ合流し
        //   UI に「なぜ pause したか」を表示する (CC 経路と同じ payload 契約: trigger / secret_kinds)。
        //   secret_kinds は REDACTION_KINDS 名のみ (NO-RAW)・非空時のみ付与。card は sink redaction を通る。
        const enriched: CodexApprovalCard = {
          ...card,
          payload: {
            ...card.payload,
            trigger: reason.trigger,
            ...(reason.secretKinds.length > 0 ? { secret_kinds: [...reason.secretKinds] } : {}),
          },
        };
        this.opts.emitCard(enriched, requestId);
      })
      .then((result: ApprovalResult) => {
        // auto-allow (allow_for_session cache / 永続 allowlist 命中) は decision を載せない
        // (CC は behavior で判定するため省略・ApprovalResult JSDoc)。codex は decision で
        // Response を作るため、behavior:"allow" を decision="allow"(=accept) に写像する。
        // acceptForSession でなく accept(一回許可) に倒すのは、codex 側がセッション記憶して
        // 以後 sidecar ゲートを迂回するのを避けるため (D5 secret 再カードを各要求で効かせる)。
        // timeout/drain(behavior:"deny") / defer は undefined のまま → 安全側 decline。
        const decision: ApprovalDecision | undefined =
          result.decision ?? (result.behavior === "allow" ? "allow" : undefined);
        this.finish(id, key, kind, decision);
      })
      .catch(() => {
        // 異常時も安全側 (deny=decline/denied) で codex に応答し、turn を宙吊りにしない。
        this.finish(id, key, kind, undefined);
      });
    return true;
  }

  /** JSON-RPC id(key) → bridge request_id。 */
  private readonly forward = new Map<string, string>();
  /** bridge request_id → {codex id, kind}。 */
  private readonly reverse = new Map<string, { id: CodexRequestId; kind: CodexApprovalKind }>();

  /** 解決を codex へ Response として送り、突合 map を掃除する。 */
  private finish(
    id: CodexRequestId,
    key: string,
    kind: CodexApprovalKind,
    decision: ApprovalDecision | undefined,
  ): void {
    if (!this.inFlight.has(key)) return; // 既に応答済み (idempotent)
    this.inFlight.delete(key);
    const requestId = this.forward.get(key);
    this.forward.delete(key);
    if (requestId !== undefined) this.reverse.delete(requestId);
    this.opts.sendResponse(id, buildApprovalResultBody(kind, decision));
  }

  /** 進行中の承認件数 (検証用)。 */
  get inFlightCount(): number {
    return this.inFlight.size;
  }
}

function asParams(p: unknown): Record<string, unknown> {
  return p !== null && typeof p === "object" && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : {};
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * inbound: 承認 ServerRequest params → UI カード (redacted フィールドのみ)。
 * - command: command, cwd, reason, itemId → command 系 high。
 * - file: itemId, reason, grantRoot → file 系 medium。
 * - permissions: permissions, cwd, reason → permission 系 high。
 * - legacy-exec: command(array), cwd, reason → command 系 high。
 * - legacy-patch: fileChanges(keys), grantRoot, reason → file 系 medium。
 */
function buildCard(kind: CodexApprovalKind, p: Record<string, unknown>): CodexApprovalCard {
  const reason = asString(p.reason);
  const reasonPayload = reason !== undefined ? { reason } : {};
  switch (kind) {
    case "command": {
      const command = asString(p.command) ?? "";
      const cwd = asString(p.cwd);
      const itemId = asString(p.itemId);
      return {
        tool_name: "codex/command",
        summary: `承認待ち: コマンド実行${command ? ` (${command})` : ""}`,
        payload: {
          tool_name: "codex/command",
          risk_level: "high",
          ...(command ? { command } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(itemId !== undefined ? { item_id: itemId } : {}),
          ...reasonPayload,
        },
      };
    }
    case "file": {
      const itemId = asString(p.itemId);
      const grantRoot = asString(p.grantRoot);
      return {
        tool_name: "codex/file",
        summary: "承認待ち: ファイル変更",
        payload: {
          tool_name: "codex/file",
          risk_level: "medium",
          ...(itemId !== undefined ? { item_id: itemId } : {}),
          ...(grantRoot !== undefined ? { grant_root: grantRoot } : {}),
          ...reasonPayload,
        },
      };
    }
    case "permissions": {
      const cwd = asString(p.cwd);
      const itemId = asString(p.itemId);
      return {
        tool_name: "codex/permissions",
        summary: "承認待ち: 権限要求",
        payload: {
          tool_name: "codex/permissions",
          risk_level: "high",
          // permissions 構造は credential を含みうる → 概要のみ。詳細は sink redaction 後でも
          //   生で載せない (MVP は deny only なので grant 詳細は UI に不要)。
          permissions_requested: true,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(itemId !== undefined ? { item_id: itemId } : {}),
          ...reasonPayload,
        },
      };
    }
    case "legacy-exec": {
      const cmdArr = Array.isArray(p.command)
        ? (p.command as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const command = cmdArr.join(" ");
      const cwd = asString(p.cwd);
      const callId = asString(p.callId);
      return {
        tool_name: "codex/command",
        summary: `承認待ち: コマンド実行${command ? ` (${command})` : ""}`,
        payload: {
          tool_name: "codex/command",
          risk_level: "high",
          ...(command ? { command } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(callId !== undefined ? { call_id: callId } : {}),
          ...reasonPayload,
        },
      };
    }
    case "legacy-patch": {
      const fileChanges = p.fileChanges;
      const paths =
        fileChanges !== null && typeof fileChanges === "object" && !Array.isArray(fileChanges)
          ? Object.keys(fileChanges as Record<string, unknown>)
          : [];
      const grantRoot = asString(p.grantRoot);
      const callId = asString(p.callId);
      return {
        tool_name: "codex/file",
        summary: `承認待ち: ファイル変更 (${paths.length} ファイル)`,
        payload: {
          tool_name: "codex/file",
          risk_level: "medium",
          ...(paths.length > 0 ? { paths } : {}),
          ...(grantRoot !== undefined ? { grant_root: grantRoot } : {}),
          ...(callId !== undefined ? { call_id: callId } : {}),
          ...reasonPayload,
        },
      };
    }
  }
}

/**
 * ADR 019ecc70 段階2 (task 019eccb0): codex 承認 params から **secret 走査用の gate input** を作る。
 *
 * UI 表示用 `buildCard` とは別に、`ApprovalBridge.detectSecretInInput` が classifyTool で bash/edit に
 * 分類してフィールドを走査できる `tool_name` + `tool_input` を返す。**内容を持つ kind のみ** が対象:
 *  - command (item/commandExecution) / legacy-exec (execCommandApproval): `command` を Bash として走査。
 *  - legacy-patch (applyPatchApproval): `fileChanges` (path→内容) を JSON 化し Edit content として走査。
 *  - file (item/fileChange) / permissions: 承認 params に **本文を持たない** (itemId/grantRoot のみ) ため
 *    走査不能 → `undefined` を返す (常時ゲートは維持・secret reason は付与しない)。
 *
 * NO-RAW: 戻り値の raw 内容は `detectSecretInInput` の述語評価 (redactString!==x) と redacted マーカー
 *   からの kind 算出にのみ使われ、card/emit/DB には出ない (card は別途 `buildCard` が redacted payload
 *   を作り sink redaction を通る)。
 *
 * silent no-op 回避: `tool_name` を card の "codex/*" のままにすると classifyTool→"other" となり走査が
 *   黙って no-op になる (偽の保護)。必ず Bash/Edit を返し、テストで mutation 赤化を pin する。
 */
export function buildGateInput(
  kind: CodexApprovalKind,
  p: Record<string, unknown>,
): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  switch (kind) {
    case "command": {
      const command = asString(p.command);
      return command !== undefined && command.length > 0
        ? { toolName: "Bash", toolInput: { command } }
        : undefined;
    }
    case "legacy-exec": {
      const command = Array.isArray(p.command)
        ? (p.command as unknown[]).filter((x): x is string => typeof x === "string").join(" ")
        : "";
      return command.length > 0 ? { toolName: "Bash", toolInput: { command } } : undefined;
    }
    case "legacy-patch": {
      // fileChanges (path→内容の object) を JSON 文字列化し Edit content として走査 (CC edit と同型)。
      if (p.fileChanges === null || typeof p.fileChanges !== "object") return undefined;
      let content: string;
      try {
        content = JSON.stringify(p.fileChanges);
      } catch {
        return undefined; // 直列化不能 → 走査不能 (常時ゲートは維持)。
      }
      return content.length > 0 ? { toolName: "Edit", toolInput: { content } } : undefined;
    }
    // file (item/fileChange) / permissions: 承認 params に本文なし → 走査不可。
    default:
      return undefined;
  }
}
