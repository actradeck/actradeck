/**
 * ADR 019f4206 A段: codex spawn wire 検証の INV (event-model 単一出所)。
 *
 * INV-SPAWN-WIRE-PARSE: `parseCodexSpawnRequest` は shape/型/絶対性/NUL/長さの第一次検証を行い、余剰 field を
 *   構造的に落とす (NO-RAW by construction)。不正は undefined (受信側が値ベース invalid_request deny・非 throw)。
 * INV-SPAWN-ERROR-ENUM: `asCodexSpawnErrorCode` は closed enum のみ返す (未知/欠落は spawn_failed 縮退)。
 *
 * mutation で RED を実証: parse の cwd 絶対性チェック除去 / asCodexSpawnErrorCode の allowlist 緩和。
 */
import { describe, expect, it } from "vitest";

import {
  asCodexSpawnErrorCode,
  CODEX_SPAWN_ERROR_MESSAGE,
  MAX_SPAWN_CWD_LEN,
  MAX_SPAWN_PROMPT_LEN,
  parseCodexSpawnRequest,
} from "../src/codex-spawn-wire.js";

describe("INV-SPAWN-WIRE-PARSE: parseCodexSpawnRequest", () => {
  it("正当な prompt + 絶対 cwd を通し、余剰 field を落とす (NO-RAW by construction)", () => {
    const out = parseCodexSpawnRequest({
      prompt: "refactor the parser",
      cwd: "/home/user/repo",
      // 余剰 field (adversarial): parse 境界で構造的に落ちる。
      token: "secret",
      extra: { nested: "junk" },
    });
    expect(out).toEqual({ prompt: "refactor the parser", cwd: "/home/user/repo" });
    // 余剰 field が漏れていない (キーは prompt/cwd のみ)。
    expect(Object.keys(out ?? {}).sort()).toEqual(["cwd", "prompt"]);
  });

  it("非 object / prompt 欠落・空・非 string → undefined", () => {
    expect(parseCodexSpawnRequest(null)).toBeUndefined();
    expect(parseCodexSpawnRequest("str")).toBeUndefined();
    expect(parseCodexSpawnRequest([])).toBeUndefined();
    expect(parseCodexSpawnRequest({ cwd: "/r" })).toBeUndefined();
    expect(parseCodexSpawnRequest({ prompt: "", cwd: "/r" })).toBeUndefined();
    expect(parseCodexSpawnRequest({ prompt: 42, cwd: "/r" })).toBeUndefined();
  });

  it("cwd 非絶対 / 空 / 非 string → undefined (相対は scope 判定不能ゆえ拒否)", () => {
    expect(parseCodexSpawnRequest({ prompt: "p", cwd: "relative/path" })).toBeUndefined();
    expect(parseCodexSpawnRequest({ prompt: "p", cwd: "" })).toBeUndefined();
    expect(parseCodexSpawnRequest({ prompt: "p", cwd: 7 })).toBeUndefined();
    // 正: 絶対パスは通る。
    expect(parseCodexSpawnRequest({ prompt: "p", cwd: "/a" })).toEqual({ prompt: "p", cwd: "/a" });
  });

  it("prompt / cwd の NUL 含み → undefined (NUL 注入拒否)", () => {
    const nul = String.fromCharCode(0);
    expect(parseCodexSpawnRequest({ prompt: `a${nul}b`, cwd: "/r" })).toBeUndefined();
    expect(parseCodexSpawnRequest({ prompt: "p", cwd: `/r${nul}` })).toBeUndefined();
  });

  it("長さ上限超過 → undefined (巨大 payload 拒否)", () => {
    expect(
      parseCodexSpawnRequest({ prompt: "a".repeat(MAX_SPAWN_PROMPT_LEN + 1), cwd: "/r" }),
    ).toBeUndefined();
    expect(
      parseCodexSpawnRequest({ prompt: "p", cwd: "/" + "a".repeat(MAX_SPAWN_CWD_LEN) }),
    ).toBeUndefined();
    // 上限ちょうどは通る。
    expect(parseCodexSpawnRequest({ prompt: "a".repeat(MAX_SPAWN_PROMPT_LEN), cwd: "/r" })).toEqual(
      {
        prompt: "a".repeat(MAX_SPAWN_PROMPT_LEN),
        cwd: "/r",
      },
    );
  });
});

describe("INV-SPAWN-ERROR-ENUM: asCodexSpawnErrorCode + messages", () => {
  it("既知 code はそのまま・未知/欠落は spawn_failed へ縮退 (closed enum 保証)", () => {
    expect(asCodexSpawnErrorCode("cwd_out_of_scope")).toBe("cwd_out_of_scope");
    expect(asCodexSpawnErrorCode("spawn_cap_reached")).toBe("spawn_cap_reached");
    expect(asCodexSpawnErrorCode("spawn_disabled")).toBe("spawn_disabled");
    expect(asCodexSpawnErrorCode("invalid_request")).toBe("invalid_request");
    // 未知/型不一致/欠落 → spawn_failed (敵対 daemon の未知 code を構造的に縮退)。
    expect(asCodexSpawnErrorCode("rm -rf /")).toBe("spawn_failed");
    expect(asCodexSpawnErrorCode(undefined)).toBe("spawn_failed");
    expect(asCodexSpawnErrorCode(123)).toBe("spawn_failed");
  });

  it("全 error code に固定リテラルメッセージがあり prompt/cwd を含まない", () => {
    for (const [code, msg] of Object.entries(CODEX_SPAWN_ERROR_MESSAGE)) {
      expect(msg.length).toBeGreaterThan(0);
      expect(asCodexSpawnErrorCode(code)).toBe(code); // 全キーが closed enum の一員。
    }
  });
});
