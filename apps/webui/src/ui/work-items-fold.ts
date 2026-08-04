"use client";

/**
 * Work-items panel の表示用 **純関数** (ADR 0015 §D8・状態と表示の分離).
 *
 * 中核契約:
 *  - **client-side fold は `@actradeck/projection` の `reduceWorkItems` を共有 import** する
 *    (SessionReplay の replay reducer と同型・webui で fold を再実装しない)。fold 入力は既に
 *    Session Detail が取得済のイベントフィード (ReplayEventDTO)。`replayDtoToEvent` で NormalizedEvent へ
 *    復元し畳む。INV-WORKITEMS-FOLD-PARITY (受入14 webui 側): 同一イベント列で webui fold == projection
 *    reduce (work-items-fold.test.ts が pin)。
 *  - **バッジ判定は `deriveWorkItemBadge` を import** する (§D8 単一正準・webui で 4 状態を再実装しない)。
 *    ここは badge enum → locale ラベルキー / tone への写像のみ (日本語を焼き込まない)。
 *  - **NO-RAW**: work_item_id は既に `scheme:sha256[:16]` の hash (生 provider task id / 生パス非含)。
 *    表示は短縮 hash・subject は projection が redacted+bounded 済の値を写すのみ。
 *
 * SEC: ReplayEventDTO は backend allow-list 投影の redaction 済 DTO。ここは値の見せ方へ落とすだけで
 * 生 payload を独自取得しない (security.md)。
 */
import {
  deriveWorkItemBadge,
  reduceWorkItems,
  type WorkItem,
  type WorkItemBadge,
  type WorkItemsProjection,
} from "@actradeck/projection";

import { replayDtoToEvent } from "../replay/replay-state";

import type { MessageKey } from "./i18n/messages";
import type { Tone } from "./kit";
import type { NormalizedEvent } from "@actradeck/event-model";
import type { ReplayEventDTO } from "../realtime/contract";

/**
 * 既取得のイベントフィード上で work-items を **client-side fold** する (projection と同一関数)。
 * 不正 DTO (parse 不能) は落とす (架空の item を作らない)。決定的・冪等 (INV-WORKITEMS-FOLD-PARITY)。
 */
export function foldWorkItems(
  sessionId: string,
  events: readonly ReplayEventDTO[],
): WorkItemsProjection {
  const normalized = events.map(replayDtoToEvent).filter((e): e is NormalizedEvent => e !== null);
  return reduceWorkItems(sessionId, normalized);
}

// ── badge (§D8 単一正準 deriveWorkItemBadge の locale 写像) ─────────────────────
const BADGE_LABEL_KEY: Record<WorkItemBadge, MessageKey> = {
  self_claimed: "workitem.badge.self_claimed",
  verified: "workitem.badge.verified",
  verification_failed: "workitem.badge.verification_failed",
  changed_after_verification: "workitem.badge.changed_after_verification",
};

const BADGE_TITLE_KEY: Record<WorkItemBadge, MessageKey> = {
  self_claimed: "workitem.badge.self_claimed.title",
  verified: "workitem.badge.verified.title",
  verification_failed: "workitem.badge.verification_failed.title",
  changed_after_verification: "workitem.badge.changed_after_verification.title",
};

/** badge → kit Tag tone。verified=success / failed=danger / claimed・stale=warn (要確認)。 */
const BADGE_TONE: Record<WorkItemBadge, Tone> = {
  self_claimed: "warn",
  verified: "success",
  verification_failed: "danger",
  changed_after_verification: "warn",
};

export interface BadgeDisplay {
  readonly badge: WorkItemBadge;
  readonly labelKey: MessageKey;
  readonly titleKey: MessageKey;
  readonly tone: Tone;
}

/**
 * item のバッジ表示情報を返す (§D8 の `deriveWorkItemBadge` を単一出所として使う)。
 * completed でない / waived 等は undefined (バッジ非表示・plain status を出す)。
 */
export function badgeDisplay(item: WorkItem): BadgeDisplay | undefined {
  const badge = deriveWorkItemBadge(item);
  if (badge === undefined) return undefined;
  return {
    badge,
    labelKey: BADGE_LABEL_KEY[badge],
    titleKey: BADGE_TITLE_KEY[badge],
    tone: BADGE_TONE[badge],
  };
}

// ── status (非 completed / plain 表示) ────────────────────────────────────────
const STATUS_LABEL_KEY: Record<string, MessageKey> = {
  pending: "workitem.status.pending",
  in_progress: "workitem.status.in_progress",
  completed: "workitem.status.completed",
  cancelled: "workitem.status.cancelled",
  removed: "workitem.status.removed",
  unknown: "workitem.status.unknown",
};

export function statusLabelKey(status: string): MessageKey {
  return STATUS_LABEL_KEY[status] ?? "workitem.status.unknown";
}

// ── observation evidence (§D7 method/fidelity の locale 写像・closed enum) ──────
const METHOD_LABEL_KEY: Record<string, MessageKey> = {
  official_hook: "workitem.evidence.method.official_hook",
  official_api: "workitem.evidence.method.official_api",
  provider_jsonl: "workitem.evidence.method.provider_jsonl",
  local_file: "workitem.evidence.method.local_file",
  log_parse: "workitem.evidence.method.log_parse",
  heuristic: "workitem.evidence.method.heuristic",
};

const FIDELITY_LABEL_KEY: Record<string, MessageKey> = {
  authoritative: "workitem.evidence.fidelity.authoritative",
  observed: "workitem.evidence.fidelity.observed",
  parsed: "workitem.evidence.fidelity.parsed",
  inferred: "workitem.evidence.fidelity.inferred",
  unknown: "workitem.evidence.fidelity.unknown",
};

/** method 文字列 → locale ラベルキー (未知/欠落は undefined = 証拠注記を出さない)。 */
export function methodLabelKey(method: string | undefined): MessageKey | undefined {
  if (method === undefined) return undefined;
  return METHOD_LABEL_KEY[method];
}

/** fidelity 文字列 → locale ラベルキー (未知/欠落は undefined)。 */
export function fidelityLabelKey(fidelity: string | undefined): MessageKey | undefined {
  if (fidelity === undefined) return undefined;
  return FIDELITY_LABEL_KEY[fidelity];
}

// ── check 分類 (§D6 check_kind/check_match の locale 写像) ─────────────────────
const CHECK_KIND_LABEL_KEY: Record<string, MessageKey> = {
  test: "workitem.check.kind.test",
  lint: "workitem.check.kind.lint",
  typecheck: "workitem.check.kind.typecheck",
  build: "workitem.check.kind.build",
  format: "workitem.check.kind.format",
};

const CHECK_MATCH_LABEL_KEY: Record<string, MessageKey> = {
  program: "workitem.check.match.program",
  script: "workitem.check.match.script",
};

export function checkKindLabelKey(kind: string | undefined): MessageKey | undefined {
  if (kind === undefined) return undefined;
  return CHECK_KIND_LABEL_KEY[kind];
}

export function checkMatchLabelKey(match: string | undefined): MessageKey | undefined {
  if (match === undefined) return undefined;
  return CHECK_MATCH_LABEL_KEY[match];
}

// ── evidence-ref (§D8 claim/check/diff の timeline event へジャンプ) ───────────
export type EvidenceRole = "claim" | "check" | "diff";

export interface EvidenceRef {
  readonly role: EvidenceRole;
  readonly eventId: string;
  readonly labelKey: MessageKey;
}

const EVIDENCE_REF_LABEL_KEY: Record<EvidenceRole, MessageKey> = {
  claim: "workitem.ref.claim",
  check: "workitem.ref.check",
  diff: "workitem.ref.diff",
};

/**
 * item の証拠イベント参照 (claim / check / diff)。evidence _は_ イベントログ (§D2): claim_event_id /
 * verification_event_id / stale_event_id を timeline へジャンプする参照として返す (存在するものだけ)。
 */
export function evidenceRefs(item: WorkItem): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  if (item.claim_event_id !== undefined) {
    refs.push({
      role: "claim",
      eventId: item.claim_event_id,
      labelKey: EVIDENCE_REF_LABEL_KEY.claim,
    });
  }
  if (item.verification_event_id !== undefined) {
    refs.push({
      role: "check",
      eventId: item.verification_event_id,
      labelKey: EVIDENCE_REF_LABEL_KEY.check,
    });
  }
  if (item.stale_event_id !== undefined) {
    refs.push({
      role: "diff",
      eventId: item.stale_event_id,
      labelKey: EVIDENCE_REF_LABEL_KEY.diff,
    });
  }
  return refs;
}

/**
 * work_item_id (`scheme:sha256[:16]`) を DOM ラベル用に短縮する (NO-RAW: 既に hash・生 id 非含)。
 * scheme prefix + hash 先頭 8 桁。想定外形式は先頭 12 桁 fallback。
 */
export function shortWorkItemId(id: string): string {
  const sep = id.indexOf(":");
  if (sep < 0) return id.slice(0, 12);
  const scheme = id.slice(0, sep);
  const hash = id.slice(sep + 1);
  return `${scheme}:${hash.slice(0, 8)}`;
}
