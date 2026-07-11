import { describe, it, expect } from "vitest";
import { repoSlug, resolveRepo, ghcrImage, DEFAULT_REPO } from "./repo.js";

describe("repoSlug", () => {
  it("reduces URLs and bare slugs to owner/name", () => {
    expect(repoSlug("actradeck/actradeck")).toBe("actradeck/actradeck");
    expect(repoSlug("https://github.com/actradeck/actradeck")).toBe("actradeck/actradeck");
    expect(repoSlug("https://github.com/actradeck/actradeck.git")).toBe("actradeck/actradeck");
    expect(repoSlug("git@github.com:acme/tool.git")).toBe("acme/tool");
    expect(repoSlug("git+ssh://git@github.com/acme/tool/")).toBe("acme/tool");
    expect(repoSlug("https://x:y@github.com/acme/tool")).toBe("acme/tool");
  });
  it("rejects shapes that are not exactly owner/name", () => {
    expect(repoSlug("actradeck")).toBeNull();
    expect(repoSlug("a/b/c")).toBeNull();
    expect(repoSlug("/name")).toBeNull();
    expect(repoSlug("owner/")).toBeNull();
    expect(repoSlug("own er/name")).toBeNull();
    expect(repoSlug("")).toBeNull();
  });
});

describe("resolveRepo", () => {
  it("defaults to the public mirror", () => {
    expect(resolveRepo({})).toBe(DEFAULT_REPO);
    expect(resolveRepo({ ACTRADECK_REPO: "  " })).toBe(DEFAULT_REPO);
  });
  it("honors a valid override", () => {
    expect(resolveRepo({ ACTRADECK_REPO: "acme/tool" })).toBe("acme/tool");
    expect(resolveRepo({ ACTRADECK_REPO: "https://github.com/acme/tool" })).toBe("acme/tool");
  });
  it("throws (input-free) on a malformed override", () => {
    expect(() => resolveRepo({ ACTRADECK_REPO: "not a repo" })).toThrow(/owner\/name/);
  });
});

describe("ghcrImage", () => {
  it("lowercases the path", () => {
    expect(ghcrImage("ActraDeck/ActraDeck")).toBe("ghcr.io/actradeck/actradeck");
  });
});
