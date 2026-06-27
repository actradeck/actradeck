/**
 * Adaptive Clarity kit — StatusBadge（liveness 4値専用）。
 *
 * `livenessBadge()`（liveness-display.ts・純ロジック）の戻りを受け、tone を kit Tag tone へマップ。
 * SessionList/SessionDetail の liveness 描画をここに集約し、INV-STALLED の表記（"STALLED?" 等
 * suspected 表記）を 1 箇所で保つ。描画層で断定形に変えない。
 */
import type { LivenessBadge, LivenessTone } from "../liveness-display";
import { Tag, type Tone } from "./Tag";
import type { IconName } from "./Icon";

const TONE_MAP: Record<LivenessTone, Tone> = {
  ok: "success",
  idle: "info",
  warn: "warn",
  muted: "muted",
};

const ICON_MAP: Record<LivenessTone, IconName> = {
  ok: "check",
  idle: "time",
  warn: "warning",
  muted: "warning-alt",
};

export function StatusBadge({ badge }: { readonly badge: LivenessBadge }) {
  return (
    <Tag
      tone={TONE_MAP[badge.tone]}
      iconStart={ICON_MAP[badge.tone]}
      title={badge.title}
      data-tone={badge.tone}
    >
      {badge.label}
    </Tag>
  );
}
