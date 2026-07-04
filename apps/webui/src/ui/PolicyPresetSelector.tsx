"use client";

/**
 * PolicyPresetSelector — 承認ポリシー preset (Strict/Balanced/Demo) セレクタ (ADR 019f23e1・P3)。
 *
 * pure-expand: preset は「既存 PolicyCategory 集合への名前付き展開テンプレート」。ボタンをクリックすると
 * **ドラフト categories を presetCategories(name) にセット**し (onApply)、既存の Save/looser 警告フローへ
 * 流す (即時永続でなく既存のドラフト→Save 観測経路を維持)。enforcement 機構・wire・policy.json は一切変えない。
 *
 * - 現在 preset バッジ: matchPreset(draftCats) で逆引き表示 (一致=preset 名 / 不一致=custom)。categories が
 *   唯一の真実ゆえ preset 名を保存しなくても決定論的に表示できる。
 * - looser 警告: 適用後ドラフトが推奨既定 (Balanced≡DEFAULT_GATED) より looser (無効化 or gate 対象を外す)
 *   なら明示警告する。default scope 適用は全非 override repo へ波及する旨も文言に含める (namespace 毎に message)。
 * - enforcement scope 注記: 予防が効くのは Managed モードのみ・Attach は観測のみ・Codex rollout は検知のみ、を
 *   overclaim せず常時開示する (honest support-matrix)。
 *
 * 2 パネル (PolicySettingsPanel = 単一 machine-global / ApprovalPolicyView = per-repo master-detail) で
 * 共有し、i18n namespace を prefix で切り替える (policy.* / approvalPolicy.*・ja/en 対称)。
 */
import {
  DEFAULT_GATED_CATEGORIES,
  matchPreset,
  PRESET_ORDER,
  presetCategories,
  type PolicyCategory,
  type PolicyPresetName,
} from "@actradeck/event-model";

import { Button, InlineAlert, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";

export interface PolicyPresetSelectorProps {
  /** 現在のドラフト categories (現在 preset の逆引きと looser 判定に使う)。 */
  readonly draftCats: ReadonlySet<PolicyCategory>;
  /** ドラフトのポリシー有効フラグ (無効化は「素通し」= looser 判定に含める)。 */
  readonly draftEnabled: boolean;
  /** preset 適用: ドラフト categories を presetCategories(name) にセットする (既存 Save 経路へ委譲)。 */
  readonly onApply: (categories: PolicyCategory[]) => void;
  /** i18n namespace の prefix。single-scope は "policy"・per-repo は "approvalPolicy"。 */
  readonly prefix: "policy" | "approvalPolicy";
  /** 保存中/オフライン等で操作不可のとき true。 */
  readonly disabled?: boolean;
}

/**
 * ドラフトが推奨既定 (Balanced≡DEFAULT_GATED) より looser か。無効化、または DEFAULT_GATED の
 * いずれかを外している場合に true (「止まるはずの操作が素通しになる」方向)。
 */
function isLooserThanBalanced(cats: ReadonlySet<PolicyCategory>, enabled: boolean): boolean {
  if (!enabled) return true;
  return DEFAULT_GATED_CATEGORIES.some((c) => !cats.has(c));
}

export function PolicyPresetSelector({
  draftCats,
  draftEnabled,
  onApply,
  prefix,
  disabled = false,
}: PolicyPresetSelectorProps): React.JSX.Element {
  const { t } = useLocale();
  const current: PolicyPresetName | undefined = matchPreset(draftCats);
  const looser = isLooserThanBalanced(draftCats, draftEnabled);

  return (
    <div className="ad-policy-preset" data-testid="policy-preset">
      <p className="ad-policy-preset__legend">{t(`${prefix}.preset.legend`)}</p>
      <div
        className="ad-policy-preset__buttons"
        role="group"
        aria-label={t(`${prefix}.preset.legend`)}
      >
        {PRESET_ORDER.map((name) => (
          <Button
            key={name}
            kind={current === name ? "primary" : "secondary"}
            size="sm"
            data-testid={`policy-preset-${name}`}
            aria-pressed={current === name}
            disabled={disabled}
            title={t(`${prefix}.preset.${name}.summary`)}
            onClick={() => onApply(presetCategories(name))}
          >
            {t(`${prefix}.preset.${name}`)}
          </Button>
        ))}
      </div>

      <p className="ad-policy-preset__current" data-testid="policy-preset-current">
        <span className="ad-policy-preset__current-label">{t(`${prefix}.preset.current`)}</span>{" "}
        <Tag
          tone={current === undefined ? "muted" : "info"}
          size="sm"
          data-testid="policy-preset-badge"
        >
          {current === undefined ? t(`${prefix}.preset.custom`) : t(`${prefix}.preset.${current}`)}
        </Tag>
      </p>

      {current !== undefined ? (
        <p className="ad-policy-preset__summary" data-testid="policy-preset-summary">
          {t(`${prefix}.preset.${current}.summary`)}
        </p>
      ) : null}

      {looser ? (
        <InlineAlert
          kind="warning"
          data-testid="policy-preset-looser"
          title={t(`${prefix}.preset.looserWarn`)}
        />
      ) : null}

      <p className="ad-policy-preset__scope" data-testid="policy-enforcement-scope">
        {t(`${prefix}.enforcementScope`)}
      </p>
    </div>
  );
}
