"use client";

/**
 * Adaptive Clarity kit — Modal (ネイティブ `<dialog>` プリミティブ・設計裁定 019eb981).
 *
 * dumb 原則: payload の形を一切知らない。`children` を透過し、開閉と a11y 配管だけを担う。
 *  - `showModal()` / `close()` でネイティブモーダルを駆動 (フォーカストラップ・inert・Esc は
 *    ブラウザが担う = ARIA 自作ウィジェットの a11y 退行を避ける)。
 *  - `aria-labelledby` で見出しと関連付け (`titleId` を呼び元の見出し要素に付ける)。
 *  - Esc (dialog の cancel イベント) と backdrop クリックで閉じ、`onClose` を 1 回呼ぶ。
 *  - 閉じたら **呼び出し元 (open 直前の activeElement)** へフォーカスを返す。
 *
 * jsdom には `showModal`/`close` が無い場合があるため、存在チェックして呼ぶ (テスト安全)。
 */
import { useCallback, useEffect, useRef } from "react";

import type { ReactNode } from "react";

export interface ModalProps {
  readonly open: boolean;
  /** Esc / backdrop / 閉じるボタンで閉じる要求。呼び元が open=false にする。 */
  readonly onClose: () => void;
  /** aria-labelledby に使う id。呼び元はこの id を見出し要素 (例 <h2 id>) に付与する。 */
  readonly titleId: string;
  /** ダイアログ本文。kit は形を知らない (dumb)。closed (open=false) のときは省略可。 */
  readonly children?: ReactNode;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export function Modal({
  open,
  onClose,
  titleId,
  children,
  className,
  "data-testid": testId,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  // open 直前にフォーカスを持っていた要素 (閉じたとき返す先)。
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // onClose を effect 依存から外して安定させる (再 open ループ防止)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // open 状態をネイティブ dialog の showModal/close に同期する。
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        // jsdom フォールバック: showModal 不在なら open 属性のみ立てる。
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
    } else if (dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  // 閉じたとき (cancel/backdrop/プログラム close) 呼び出し元へフォーカスを返す。
  useEffect(() => {
    if (!open) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && typeof target.focus === "function") target.focus();
    }
  }, [open]);

  // Esc (dialog cancel): デフォルトの即時 close を止め、状態経由で閉じる (単一経路)。
  const handleCancel = useCallback((e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onCloseRef.current();
  }, []);

  // backdrop クリック: dialog 自身がターゲット (= ::backdrop 領域) なら閉じる。
  const handleClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === ref.current) onCloseRef.current();
  }, []);

  // dialog は常時マウントし showModal/close で開閉する (条件 unmount だと close()・フォーカス
  // 返却の effect が走らない)。閉じている dialog は `open` 属性無しでネイティブに非表示・
  // a11y ツリー外。children は閉時に描かない (秘匿本文をクローズ後 DOM に残さない)。
  return (
    <dialog
      ref={ref}
      className={["ad-modal", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      aria-modal="true"
      data-testid={testId}
      onCancel={handleCancel}
      onClick={handleClick}
    >
      {/* 内側ラッパ: backdrop クリック判定 (e.target===dialog) を本文クリックと分離する。 */}
      {open ? <div className="ad-modal__panel">{children}</div> : null}
    </dialog>
  );
}
