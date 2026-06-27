/**
 * vitest setup: ルート .env を process.env へ流し込む (依存なしの最小 parser).
 *
 * webui の結合テスト (integration-realtime) は実 backend + 実 PG (DATABASE_URL, port 55432)
 * に接続する。CLI で env 注入していない実行でも .env を読めるようにする。既存の env は
 * 上書きしない (CI の env 注入経路を尊重)。.env はコミットしない。secret はログに出さない。
 * backend/test/setup-env.ts と同型 (重複だが各 workspace の vitest が独立に読むため許容)。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// apps/webui/test/ -> repo root
const envPath = resolve(here, "../../../.env");

try {
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // .env が無い環境 (CI 等) は env 注入経路に委ねる。実 PG テストは未到達なら skip。
}
