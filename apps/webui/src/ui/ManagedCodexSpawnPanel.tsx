"use client";

/**
 * ADR 019f4206 A段: cockpit からの Codex Managed spawn パネル。
 *
 * spawn 可能な attach デーモンが 1 つ以上あるときだけ描画する (呼び元が gate)。prompt (textarea) + cwd
 * (テキスト・ISO 入力) + 対象デーモン (spawn_capable のみ) のフォームで、送信すると `useCodexSpawn` が
 * same-origin POST を打つ。**正直な開示** (一発 prompt・headless・env opt-in) を UI 文言で明示する。
 *
 * NO-RAW: prompt/cwd はローカル state と POST body の transient のみ。失敗は `useCodexSpawn` の closed enum
 * error key を固定リテラル文言 (i18n) へ 1:1 写像し、生 error 文字列を描画しない。
 */
import { useState } from "react";

import { Button } from "./kit";
import { useLocale } from "./LocaleProvider";
import { useCodexSpawn } from "./use-codex-spawn";

/** daemonId を人間可読な短縮ラベルへ (先頭 8 hex・NO-RAW: credential でない per-connection id)。 */
function shortDaemon(id: string): string {
  return id.slice(0, 8);
}

export function ManagedCodexSpawnPanel({
  spawnDaemonIds,
}: {
  readonly spawnDaemonIds: readonly string[];
}) {
  const { t } = useLocale();
  const { phase, errorKey, spawn, reset } = useCodexSpawn();
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [daemonId, setDaemonId] = useState<string>(spawnDaemonIds[0] ?? "");

  // 選択中 daemon が一覧から消えた (再接続で id churn) 場合は先頭へフォールバック。
  const effectiveDaemon = spawnDaemonIds.includes(daemonId) ? daemonId : (spawnDaemonIds[0] ?? "");
  const canSubmit =
    phase !== "spawning" &&
    prompt.trim().length > 0 &&
    cwd.trim().startsWith("/") &&
    effectiveDaemon.length > 0;

  const onSubmit = (): void => {
    if (!canSubmit) return;
    spawn({ daemonId: effectiveDaemon, prompt: prompt.trim(), cwd: cwd.trim() });
  };

  return (
    <section className="ad-spawn" data-testid="codex-spawn" data-phase={phase}>
      <h3 className="ad-spawn__title">{t("codexSpawn.title")}</h3>
      <p className="ad-spawn__lead">{t("codexSpawn.lead")}</p>

      <label className="ad-spawn__field">
        <span>{t("codexSpawn.field.prompt")}</span>
        <textarea
          className="ad-spawn__prompt"
          data-testid="codex-spawn-prompt"
          rows={3}
          value={prompt}
          placeholder={t("codexSpawn.field.promptPlaceholder")}
          onChange={(e) => {
            setPrompt(e.target.value);
            if (phase !== "idle") reset();
          }}
        />
      </label>

      <label className="ad-spawn__field">
        <span>{t("codexSpawn.field.cwd")}</span>
        <input
          type="text"
          className="ad-spawn__cwd"
          data-testid="codex-spawn-cwd"
          value={cwd}
          placeholder={t("codexSpawn.field.cwdPlaceholder")}
          onChange={(e) => {
            setCwd(e.target.value);
            if (phase !== "idle") reset();
          }}
        />
      </label>

      {spawnDaemonIds.length > 1 ? (
        <label className="ad-spawn__field">
          <span>{t("codexSpawn.field.daemon")}</span>
          <select
            className="ad-spawn__daemon"
            data-testid="codex-spawn-daemon"
            value={effectiveDaemon}
            onChange={(e) => setDaemonId(e.target.value)}
          >
            {spawnDaemonIds.map((id) => (
              <option key={id} value={id}>
                {shortDaemon(id)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <Button
        kind="primary"
        size="md"
        iconStart="play"
        data-testid="codex-spawn-submit"
        disabled={!canSubmit}
        onClick={onSubmit}
      >
        {phase === "spawning" ? t("codexSpawn.submitting") : t("codexSpawn.submit")}
      </Button>

      <p className="ad-spawn__limits">{t("codexSpawn.limits")}</p>

      {phase === "ok" ? (
        <span className="ad-spawn__ok" data-testid="codex-spawn-ok" role="status">
          {t("codexSpawn.ok")}
        </span>
      ) : null}
      {phase === "error" && errorKey !== null ? (
        <span className="ad-spawn__error" data-testid="codex-spawn-error" role="alert">
          {t(`codexSpawn.error.${errorKey}` as const)}
        </span>
      ) : null}
    </section>
  );
}
