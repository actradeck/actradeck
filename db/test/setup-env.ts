/**
 * vitest setup: ルート .env を process.env へ流し込む (依存なしの最小 parser)。
 *
 * 整合テストは実 Postgres (DATABASE_URL, port 55432) に接続するため、CLI で
 * 環境変数注入していない実行 (IDE / 単独 vitest) でも .env を読めるようにする。
 * 既に環境に設定済みの値は上書きしない (CI で env 注入する経路を尊重)。
 * .env はコミットしない (.gitignore 済み)。secret をログに出さない。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// db/test/ -> repo root
const envPath = resolve(here, "../../.env");

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
  // .env が無い環境 (CI 等) は env 注入経路に委ねる。整合テストは未到達なら skip。
}
