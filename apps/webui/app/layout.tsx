import type { ReactNode } from "react";

// Adaptive Clarity 2030 デザイントークン（DTCG）。--ad-* を定義し data-theme / prefers-* で切替える。
// globals.scss より先に読み込み、後続フェーズで .ad-* が var(--ad-*) を参照できるようにする。
import "@actradeck/design-tokens/tokens.css";
import "./globals.scss";
import { ThemeProvider } from "../src/ui/ThemeProvider";
import { noFlashScript } from "../src/ui/theme";
import { LocaleProvider } from "../src/ui/LocaleProvider";
import { noFlashLocaleScript } from "../src/ui/locale";

export const metadata = {
  title: "ActraDeck",
  description: "Agent Cockpit / Coding Agent Console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* paint 前に保存テーマを data-theme へ確定し、テーマのフラッシュを防ぐ。 */}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript() }} />
        {/* paint 前に保存言語を <html lang> へ確定し、言語のフラッシュを防ぐ。 */}
        <script dangerouslySetInnerHTML={{ __html: noFlashLocaleScript() }} />
      </head>
      <body>
        <ThemeProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
