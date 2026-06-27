/**
 * Adaptive Clarity kit — インライン SVG アイコンセット（@carbon/icons-react 置換）。
 *
 * すべて 16x16 viewBox・`fill: currentColor`（色は親の color を継承）。アイコンは装飾扱いで
 * 常に `aria-hidden` + `focusable="false"`。意味は親（IconButton の aria-label / Tag のテキスト）が担う。
 * サイズは px 直指定せず 1em（呼び出し側のフォントサイズ/トークンで決まる）。
 */
import type { ReactNode } from "react";

export type IconName =
  | "activity"
  | "dashboard"
  | "renew"
  | "check"
  | "time"
  | "warning"
  | "warning-alt"
  | "close"
  | "stop"
  | "pause"
  | "play"
  | "skip-back"
  | "skip-forward"
  | "search";

const PATHS: Record<IconName, ReactNode> = {
  activity: (
    <path
      d="M1 8h3l2-5 3 10 2-5h4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  ),
  dashboard: <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" />,
  renew: <path d="M8 2a6 6 0 105.6 3.9l-1.4.5A4.5 4.5 0 118 3.5V6l3.5-2.25L8 1.5z" />,
  check: <path d="M6.4 11.6 3 8.2l1-1 2.4 2.4L12 4l1 1z" />,
  time: (
    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5A5.5 5.5 0 118 13.5 5.5 5.5 0 018 2.5zM7.25 4v4.7l3.1 1.85.75-1.25-2.6-1.55V4z" />
  ),
  warning: <path d="M8 1 1 14.5h14L8 1zm-.75 5h1.5v4.5h-1.5V6zm0 5.5h1.5V13h-1.5z" />,
  "warning-alt": (
    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3h1.5v5.5h-1.5V4zm0 6.5h1.5V12h-1.5z" />
  ),
  close: <path d="M12 4.7 11.3 4 8 7.3 4.7 4 4 4.7 7.3 8 4 11.3l.7.7L8 8.7l3.3 3.3.7-.7L8.7 8z" />,
  stop: <path d="M3 3h10v10H3z" />,
  pause: <path d="M4 3h3v10H4zM9 3h3v10H9z" />,
  play: <path d="M4 3l9 5-9 5z" />,
  "skip-back": <path d="M5 3v10H3.5V3zM13 3v10l-7-5z" />,
  "skip-forward": <path d="M11 3v10h1.5V3zM3 3v10l7-5z" />,
  search: (
    <path d="M7 2.5a4.5 4.5 0 013.5 7.3l3.1 3.1-1 1-3.1-3.1A4.5 4.5 0 117 2.5zm0 1.5a3 3 0 100 6 3 3 0 000-6z" />
  ),
};

export interface IconProps {
  readonly name: IconName;
  readonly className?: string;
}

export function Icon({ name, className }: IconProps) {
  return (
    <svg
      className={className ? `ad-icon ${className}` : "ad-icon"}
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
