/**
 * fs-atomic — 0600 atomic JSON 書込/読取ヘルパの契約 (TDA-1 consolidation・sweep 019ee0ec)。
 *
 * daemon-state / approval-allowlist-store / settings-merge が共有する不変条件をここで一点ピン留めする:
 * - writeJson0600: 生成ファイル mode は 0600 (group/other 不可)。出力は 2-space + 末尾改行。
 * - dirMode: 親 dir は所有者限定 (group/other ビット 0)。
 * - atomic: 書込後に `.tmp-*` 残渣を残さない。
 * - chmodAfter: 既存ファイル上書きでも 0600 に収束する。
 * - readJsonObject: 無し/空/不正 JSON/配列/非オブジェクトはすべて undefined (fail-safe)。
 *
 * mutation: writeFileSync の mode を 0o644 にすると 0600 アサートが赤化。Array.isArray ガードを外すと
 * 「配列 → undefined」が赤化。末尾 \n を外すと整形アサートが赤化。
 *
 * 🔴 すべて os.tmpdir() 配下。実 ~/.actradeck 不可侵。
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readJsonObject, writeJson0600 } from "../src/fs-atomic.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-fs-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJson0600", () => {
  it("0600: 生成ファイル mode は所有者 rw のみ", () => {
    const p = join(dir, "state.json");
    writeJson0600(p, { a: 1 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("整形: 2-space インデント + 末尾改行", () => {
    const p = join(dir, "state.json");
    writeJson0600(p, { a: 1, b: { c: 2 } });
    const raw = readFileSync(p, "utf8");
    expect(raw).toBe(`${JSON.stringify({ a: 1, b: { c: 2 } }, null, 2)}\n`);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "a": 1');
  });

  it("round-trip: 書いた値が readJsonObject で復元できる", () => {
    const p = join(dir, "state.json");
    const value = { pid: 42, endpoint: "http://127.0.0.1:1", nested: { x: [1, 2] } };
    writeJson0600(p, value);
    expect(readJsonObject(p)).toEqual(value);
  });

  it("dirMode 0700: 親ディレクトリは group/other アクセス不可", () => {
    const sub = join(dir, "nested", "deep");
    const p = join(sub, "state.json");
    writeJson0600(p, { a: 1 }, { dirMode: 0o700 });
    expect(existsSync(p)).toBe(true);
    // 所有者限定 (group/other ビットが立たない)。umask 非依存の安全性質を確認。
    expect(statSync(sub).mode & 0o077).toBe(0);
  });

  it("atomic: 書込後に .tmp-* 残渣を残さない", () => {
    const p = join(dir, "state.json");
    writeJson0600(p, { a: 1 });
    writeJson0600(p, { a: 2 }); // 連続書込でも tmp が残らない。
    const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(readJsonObject(p)).toEqual({ a: 2 });
  });

  it("chmodAfter: 既存 0666 ファイル上書きでも 0600 に収束する", () => {
    const p = join(dir, "settings.json");
    writeFileSync(p, "{}", { mode: 0o666 });
    writeJson0600(p, { a: 1 }, { chmodAfter: true });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readJsonObject(p)).toEqual({ a: 1 });
  });
});

describe("readJsonObject (fail-safe)", () => {
  it("ファイル無し → undefined", () => {
    expect(readJsonObject(join(dir, "missing.json"))).toBeUndefined();
  });

  it("空ファイル → undefined", () => {
    const p = join(dir, "empty.json");
    writeFileSync(p, "");
    expect(readJsonObject(p)).toBeUndefined();
  });

  it("不正 JSON → undefined", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{not json");
    expect(readJsonObject(p)).toBeUndefined();
  });

  it("配列 → undefined (object 限定)", () => {
    const p = join(dir, "arr.json");
    writeFileSync(p, "[1,2,3]");
    expect(readJsonObject(p)).toBeUndefined();
  });

  it("null リテラル → undefined", () => {
    const p = join(dir, "null.json");
    writeFileSync(p, "null");
    expect(readJsonObject(p)).toBeUndefined();
  });

  it("プリミティブ (number) → undefined", () => {
    const p = join(dir, "num.json");
    writeFileSync(p, "123");
    expect(readJsonObject(p)).toBeUndefined();
  });

  it("正常オブジェクト → そのまま返す", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, '{"x":1,"y":"z"}');
    expect(readJsonObject(p)).toEqual({ x: 1, y: "z" });
  });
});
