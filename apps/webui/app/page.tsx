import { CockpitBoard } from "../src/ui/CockpitBoard";

/**
 * Phase 4 スライス 1: ライブ session 一覧 → 詳細の観測導線。
 * BFF WS URL は CockpitBoard が same-origin で導出する (token はブラウザに出さない)。
 */
export default function HomePage() {
  return <CockpitBoard />;
}
