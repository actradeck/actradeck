/**
 * INV-PATH-SCOPE (SEC-1 / TDA-6 / QA-5・decision 019f0f2f): project-scope 封じ込めの正準 JS 実装を固定する。
 * backend (list 絞り込み + resolve 入口) と sidecar (解決済 root 再照合・二段封じ込め) が共有する単一出所ゆえ、
 * 危険判定で再解釈されない (security-gate-reuse-canonical-parser)。
 *
 * 固定する不変条件 (falsifiable):
 *  - scope 空 → 無制限。完全一致 / `prefix/...` 配下のみ true。兄弟ディレクトリは false。
 *  - `..`/`.`/重複スラッシュ/末尾スラッシュは canonical 化して比較 (traversal を畳む)。
 *  - 非 string / 空 / NUL / 非絶対 は false (安全側・拒否)。
 *  - root scope `["/"]` は candidate==="/" のみ true (退化設定・SQL と同じく制限的)。
 */
import { describe, expect, it } from "vitest";

import { isPathWithinScope, normalizeScopePath, sanitizeRepoLabel } from "../src/path-scope.js";

describe("normalizeScopePath", () => {
  it("`..`/`.`/重複スラッシュ/末尾スラッシュを畳む", () => {
    expect(normalizeScopePath("/a/b/")).toBe("/a/b");
    expect(normalizeScopePath("/a//b")).toBe("/a/b");
    expect(normalizeScopePath("/a/./b")).toBe("/a/b");
    expect(normalizeScopePath("/a/c/../b")).toBe("/a/b");
    expect(normalizeScopePath("/a/../../b")).toBe("/b"); // root を越える .. は破棄。
    expect(normalizeScopePath("/")).toBe("/");
  });
});

describe("isPathWithinScope (SEC-1/TDA-6 共有封じ込め)", () => {
  it("scope 空 → 無制限", () => {
    expect(isPathWithinScope("/anything", [])).toBe(true);
  });

  it("完全一致 / 配下は true・兄弟は false", () => {
    const scope = ["/home/me/work"];
    expect(isPathWithinScope("/home/me/work", scope)).toBe(true);
    expect(isPathWithinScope("/home/me/work/repo/src", scope)).toBe(true);
    expect(isPathWithinScope("/home/me/work-other", scope)).toBe(false); // 兄弟 (prefix の文字列前方一致だが配下でない)。
    expect(isPathWithinScope("/home/me", scope)).toBe(false); // 上位 (ancestor) は配下でない。
  });

  it("traversal は canonical 化してから判定 (scope 外へ抜けさせない)", () => {
    const scope = ["/home/me/work"];
    expect(isPathWithinScope("/home/me/work/../secret", scope)).toBe(false); // → /home/me/secret は scope 外。
    expect(isPathWithinScope("/home/me/work/sub/../x", scope)).toBe(true); // → /home/me/work/x は配下。
    expect(isPathWithinScope("/home/me/work/", scope)).toBe(true); // 末尾スラッシュは無視。
  });

  it("trailing-slash の prefix も canonical 化されれば対称 (TDA-6)", () => {
    expect(isPathWithinScope("/a/b/c", ["/a/b/"])).toBe(true);
    expect(isPathWithinScope("/a/b/c", [normalizeScopePath("/a/b/")])).toBe(true);
  });

  it("非 string / 空 / NUL / 非絶対 は false (安全側)", () => {
    const scope = ["/home/me/work"];
    expect(isPathWithinScope(undefined, scope)).toBe(false);
    expect(isPathWithinScope(42, scope)).toBe(false);
    expect(isPathWithinScope("", scope)).toBe(false);
    expect(isPathWithinScope("/home/me/work\0/x", scope)).toBe(false);
    expect(isPathWithinScope("relative/path", scope)).toBe(false);
  });

  it("root scope ['/'] は candidate==='/' のみ true (退化・制限的)", () => {
    expect(isPathWithinScope("/", ["/"])).toBe(true);
    expect(isPathWithinScope("/anything", ["/"])).toBe(false);
  });

  it("複数 prefix のいずれかに配下なら true", () => {
    const scope = ["/a/one", "/b/two"];
    expect(isPathWithinScope("/b/two/x", scope)).toBe(true);
    expect(isPathWithinScope("/c/three/x", scope)).toBe(false);
  });
});

describe("sanitizeRepoLabel (SEC-4/SEC-R2-1・NO-RAW basename 縮約・QA-R1 端枝)", () => {
  it("絶対パスは最終 segment (basename) へ畳む", () => {
    expect(sanitizeRepoLabel("/home/me/secret-repo")).toBe("secret-repo");
    expect(sanitizeRepoLabel("C:\\Users\\x\\repo")).toBe("repo"); // backslash も区切り。
    expect(sanitizeRepoLabel("plain")).toBe("plain");
  });

  it("制御文字 (改行/復帰/NUL/0x1F/0x7F) を除去する", () => {
    expect(sanitizeRepoLabel("evil\nname\r")).toBe("evilname");
    expect(sanitizeRepoLabel("a\x00b\x1f\x7fc")).toBe("abc");
  });

  it("QA-R1: 空/制御文字のみ/区切り終端 → undefined (label を載せない)", () => {
    expect(sanitizeRepoLabel("")).toBeUndefined();
    expect(sanitizeRepoLabel("///")).toBeUndefined(); // 最終 segment 空。
    expect(sanitizeRepoLabel("  ")).toBeUndefined(); // trim で空。
    expect(sanitizeRepoLabel("\n\r\x00")).toBeUndefined(); // 制御文字のみ。
  });

  it("QA-R1: 64 字へ cap する", () => {
    const long = "a".repeat(100);
    expect(sanitizeRepoLabel(long)).toHaveLength(64);
  });

  it("非 string は undefined", () => {
    expect(sanitizeRepoLabel(undefined)).toBeUndefined();
    expect(sanitizeRepoLabel(42)).toBeUndefined();
    expect(sanitizeRepoLabel(null)).toBeUndefined();
  });
});
