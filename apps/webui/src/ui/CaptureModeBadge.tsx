"use client";

/**
 * capture provenance の一覧レベル正直表示バッジ (ADR 019f41ec-c549 / 019f47c2)。
 *
 * SessionList 行 / LiveWall レーンで「非 managed」のセッションにだけコンパクトなバッジを出す
 * 単一出所コンポーネント。provenance = `captureProvenance(capture_mode, source)` を **source-aware** に
 * 分類する: source=external (第三者 adapter 直取込・gemini/opencode 等) は observe-only ゆえ external を
 * 独立分類し、capture_mode 欠落を **managed と誤表示しない** (TDA-1)。managed (欠落 capture_mode + 非
 * external を含む) は **バッジ無し** = 既定扱い ("Managed" と断定表示しない)。
 *
 * 意味論契約 (SessionDetail のヘッダ badge と同一の captureProvenance 単一出所):
 *  - attach / codex_rollout の non-managed は「ActraDeck が起動を所有しない」ことだけを示す。approval
 *    relay 可否とは **直交**するため "observe-only" とは呼ばない (external のみ observe-only を用いる)。
 *  - external は第三者直取込の observe-only。専用 i18n `detail.captureMode.external`(「外部 (observe-only)」)。
 *  - attach / codex_rollout の文言は既存 i18n `detail.captureMode.nonManaged`(「外部起動 ({mode})」) を再利用。
 *  - tone 分岐は SessionDetail の risk facts と同一: attach=warn / codex_rollout・external=muted。
 *
 * NO-RAW: 表示値は closed enum (captureProvenance の戻り値: managed/attach/codex_rollout/external) と
 * その i18n 訳のみ。ユーザーデータ・生パスを新規に DOM へ出さない。
 */
import { Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { captureProvenance } from "./current-action-display";

export interface CaptureModeBadgeProps {
  /** list DTO の optional capture_mode (欠落/未知は managed 既定扱い)。 */
  readonly captureMode: string | undefined;
  /**
   * list DTO の source (ADR 019f47c2)。`external` は observe-only 取込ゆえ capture_mode 欠落を
   * managed と誤表示せず external バッジを出す。省略/未知は capture_mode 判定に委ねる (後方互換)。
   */
  readonly source?: string;
  /** 機械検証用 data-testid (表示面ごとに一意: 例 session-capture-mode / wall-lane-capture-mode)。 */
  readonly testId: string;
}

/**
 * 非 managed capture のときだけコンパクトバッジを返す (managed は null = バッジ無し)。
 * provenance は (capture_mode, source) を source-aware に単一出所分類する (captureProvenance):
 *  - external (source 由来・observe-only 取込) は専用ラベルで managed 誤表示を断つ。
 *  - attach / codex_rollout の既存表示 (「外部起動 (mode)」・tone) は不変。
 */
export function CaptureModeBadge({ captureMode, source, testId }: CaptureModeBadgeProps) {
  const { t } = useLocale();
  const provenance = captureProvenance(captureMode, source);
  if (provenance === "managed") return null;
  if (provenance === "external") {
    return (
      <Tag
        tone="muted"
        size="sm"
        data-testid={testId}
        data-capture-mode="external"
        title={t("detail.captureMode.external.title")}
      >
        {t("detail.captureMode.external")}
      </Tag>
    );
  }
  return (
    <Tag
      tone={provenance === "attach" ? "warn" : "muted"}
      size="sm"
      data-testid={testId}
      data-capture-mode={provenance}
      title={t("detail.captureMode.nonManaged.title")}
    >
      {t("detail.captureMode.nonManaged", { mode: provenance })}
    </Tag>
  );
}
