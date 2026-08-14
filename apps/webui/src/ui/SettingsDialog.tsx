"use client";

import { useId, useState } from "react";

import { Button, Modal } from "./kit";
import { useLocale } from "./LocaleProvider";
import { TelemetrySettings } from "./TelemetrySettings";

/** Secondary product settings. Product-operation tabs stay focused on live agent work. */
export function SettingsDialog(): React.JSX.Element {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const titleId = useId();

  return (
    <>
      <Button
        kind="ghost"
        size="sm"
        data-testid="open-settings"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {t("header.settings")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        titleId={titleId}
        className="ad-settings-dialog"
        data-testid="settings-dialog"
      >
        <div className="ad-modal__header">
          <div>
            <h2 id={titleId} className="ad-modal__title">
              {t("settings.title")}
            </h2>
            <span className="ad-settings__section">{t("settings.privacy")}</span>
          </div>
          <Button kind="ghost" size="sm" onClick={() => setOpen(false)}>
            {t("modal.close")}
          </Button>
        </div>
        <div className="ad-settings__body">
          <nav className="ad-settings__nav" aria-label={t("settings.title")}>
            <span aria-current="page">{t("settings.privacy")}</span>
          </nav>
          <TelemetrySettings active={open} />
        </div>
      </Modal>
    </>
  );
}
