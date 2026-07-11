import { describe, it, expect } from "vitest";
import {
  fetchReleaseByTag,
  fetchLatestStableTag,
  tarballName,
  findAsset,
  updateStatus,
} from "./release.js";

const slug = "actradeck/actradeck";
const tagsUrl = (t: string) => `https://api.github.com/repos/${slug}/releases/tags/${t}`;
const latestUrl = `https://api.github.com/repos/${slug}/releases/latest`;

function fetchJsonFrom(map: Record<string, unknown | Error>) {
  return async (url: string) => {
    const v = map[url];
    if (v === undefined) throw new Error(`no stub ${url}`);
    if (v instanceof Error) throw v;
    return v;
  };
}

describe("tarballName", () => {
  it("follows the git-archive prefix convention", () => {
    expect(tarballName("0.4.0")).toBe("actradeck-0.4.0.tar.gz");
  });
});

describe("fetchReleaseByTag", () => {
  it("maps assets with valid name + download url", async () => {
    const fj = fetchJsonFrom({
      [tagsUrl("v0.4.0")]: {
        tag_name: "v0.4.0",
        assets: [
          { name: "actradeck-0.4.0.tar.gz", browser_download_url: "https://d/tar" },
          { name: "checksums.txt", browser_download_url: "https://d/cs" },
          { name: "bogus" }, // missing url -> dropped
          { browser_download_url: "https://d/x" }, // missing name -> dropped
        ],
      },
    });
    const rel = await fetchReleaseByTag(fj, slug, "v0.4.0");
    expect(rel.tag).toBe("v0.4.0");
    expect(rel.assets).toEqual([
      { name: "actradeck-0.4.0.tar.gz", url: "https://d/tar" },
      { name: "checksums.txt", url: "https://d/cs" },
    ]);
  });
  it("falls back to the requested tag when tag_name is absent, and tolerates non-array assets", async () => {
    const fj = fetchJsonFrom({ [tagsUrl("v9.9.9")]: {} });
    const rel = await fetchReleaseByTag(fj, slug, "v9.9.9");
    expect(rel.tag).toBe("v9.9.9");
    expect(rel.assets).toEqual([]);
  });
});

describe("fetchLatestStableTag", () => {
  it("returns a stable tag", async () => {
    const fj = fetchJsonFrom({ [latestUrl]: { tag_name: "v0.4.0" } });
    expect(await fetchLatestStableTag(fj, slug)).toBe("v0.4.0");
  });
  it("rejects prerelease / draft / mis-tagged / absent", async () => {
    expect(
      await fetchLatestStableTag(
        fetchJsonFrom({ [latestUrl]: { tag_name: "v1.0.0", prerelease: true } }),
        slug,
      ),
    ).toBeNull();
    expect(
      await fetchLatestStableTag(
        fetchJsonFrom({ [latestUrl]: { tag_name: "v1.0.0", draft: true } }),
        slug,
      ),
    ).toBeNull();
    expect(
      await fetchLatestStableTag(fetchJsonFrom({ [latestUrl]: { tag_name: "v1.0.0-rc.1" } }), slug),
    ).toBeNull();
    expect(await fetchLatestStableTag(fetchJsonFrom({ [latestUrl]: {} }), slug)).toBeNull();
  });
});

describe("findAsset", () => {
  it("finds or returns null", () => {
    const rel = { tag: "v0.4.0", assets: [{ name: "a", url: "u" }] };
    expect(findAsset(rel, "a")?.url).toBe("u");
    expect(findAsset(rel, "b")).toBeNull();
  });
});

describe("updateStatus", () => {
  it("classifies update / current / unknown", () => {
    expect(updateStatus("0.4.0", "v0.5.0")).toBe("update");
    expect(updateStatus("0.4.0", "v0.4.0")).toBe("current");
    expect(updateStatus("0.5.0", "v0.4.0")).toBe("current");
    expect(updateStatus("0.4.0", "not-a-tag")).toBe("unknown");
    expect(updateStatus("weird", "v0.4.0")).toBe("unknown");
  });
});
