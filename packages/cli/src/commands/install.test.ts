import { describe, it, expect } from "vitest";
import { cmdInstall, type InstallOpts } from "./install.js";
import { makeFakeDeps, checksumsFor, type FakeConfig } from "../lib/fake.js";
import { sha256Hex } from "../lib/checksum.js";

const slug = "actradeck/actradeck";
const tagUrl = (t: string) => `https://api.github.com/repos/${slug}/releases/tags/${t}`;
const latestUrl = `https://api.github.com/repos/${slug}/releases/latest`;
const TAR_URL = "https://dl.example/tar";
const CS_URL = "https://dl.example/cs";

const tarBytes = new TextEncoder().encode("TARBALL-CONTENT");
const digest = sha256Hex(tarBytes);

function releaseJson(tag: string, name = "actradeck-0.4.0.tar.gz", withCs = true) {
  const assets: Array<{ name: string; browser_download_url: string }> = [
    { name, browser_download_url: TAR_URL },
  ];
  if (withCs) assets.push({ name: "checksums.txt", browser_download_url: CS_URL });
  return { tag_name: tag, assets };
}

/** A fully wired happy-path config for tag v0.4.0 with a matching checksum. */
function baseCfg(over: Partial<FakeConfig> = {}): FakeConfig {
  const { json, bytes, tools, ...rest } = over;
  return {
    json: { [tagUrl("v0.4.0")]: releaseJson("v0.4.0"), ...(json ?? {}) },
    bytes: {
      [TAR_URL]: tarBytes,
      [CS_URL]: checksumsFor(digest, "actradeck-0.4.0.tar.gz"),
      ...(bytes ?? {}),
    },
    tools: tools ?? { gh: { code: 0 } },
    ...rest,
  };
}

const opts = (o: Partial<InstallOpts> = {}): InstallOpts => ({
  version: "v0.4.0",
  dryRun: false,
  skipProvenance: false,
  ...o,
});

describe("cmdInstall — verification", () => {
  it("dry-run verifies checksum + provenance, then stops before extraction", async () => {
    const f = makeFakeDeps(baseCfg());
    expect(await cmdInstall(f.deps, opts({ dryRun: true }))).toBe(0);
    const text = f.out.join("\n");
    expect(text).toMatch(/Checksum verified/);
    expect(text).toMatch(/Provenance verified/);
    expect(text).toMatch(/Dry run: v0\.4\.0 resolved and verified \(checksum \+ provenance\)/);
    expect(f.execCalls).toEqual([
      {
        cmd: "gh",
        args: ["attestation", "verify", "/tmp/fake-work/actradeck-0.4.0.tar.gz", "--repo", slug],
      },
    ]);
    expect(f.extracted).toHaveLength(0);
    expect(f.handoffs).toHaveLength(0);
    expect(f.removed).toContain("/tmp/fake-work"); // temp cleaned
  });

  it("fails closed on a checksum mismatch (no extraction)", async () => {
    const f = makeFakeDeps(
      baseCfg({ bytes: { [CS_URL]: checksumsFor("0".repeat(64), "actradeck-0.4.0.tar.gz") } }),
    );
    await expect(cmdInstall(f.deps, opts({ dryRun: true }))).rejects.toThrow(
      /Checksum verification FAILED/,
    );
    expect(f.execCalls).toHaveLength(0); // never reached provenance
  });

  it("fails closed when checksums.txt asset is missing", async () => {
    const f = makeFakeDeps(
      baseCfg({
        json: { [tagUrl("v0.4.0")]: releaseJson("v0.4.0", "actradeck-0.4.0.tar.gz", false) },
      }),
    );
    await expect(cmdInstall(f.deps, opts({ dryRun: true }))).rejects.toThrow(/no checksums\.txt/);
  });

  it("fails closed when the tarball asset is missing", async () => {
    const f = makeFakeDeps(
      baseCfg({ json: { [tagUrl("v0.4.0")]: releaseJson("v0.4.0", "wrong-name.tar.gz") } }),
    );
    await expect(cmdInstall(f.deps, opts({ dryRun: true }))).rejects.toThrow(
      /no actradeck-0\.4\.0\.tar\.gz/,
    );
  });

  it("requires gh for provenance (fail-closed) unless --skip-provenance", async () => {
    const f = makeFakeDeps(baseCfg({ tools: {} })); // gh absent
    await expect(cmdInstall(f.deps, opts({ dryRun: true }))).rejects.toThrow(
      /requires the GitHub CLI 'gh'/,
    );
  });

  it("--skip-provenance warns loudly, enforces checksum, and skips gh", async () => {
    const f = makeFakeDeps(baseCfg({ tools: {} }));
    expect(await cmdInstall(f.deps, opts({ dryRun: true, skipProvenance: true }))).toBe(0);
    expect(f.err.join("\n")).toMatch(/--skip-provenance set — build provenance was NOT verified/);
    expect(f.out.join("\n")).toMatch(/Dry run: v0\.4\.0 resolved and verified \(checksum\)/);
    expect(f.execCalls).toHaveLength(0);
  });

  it("fails closed when provenance verification returns non-zero (and cleans temp)", async () => {
    const f = makeFakeDeps(baseCfg({ tools: { gh: { code: 1 } } }));
    await expect(cmdInstall(f.deps, opts({ dryRun: true }))).rejects.toThrow(
      /Provenance verification FAILED/,
    );
    expect(f.removed).toContain("/tmp/fake-work");
  });

  it("rejects a non-tag --version", async () => {
    const f = makeFakeDeps(baseCfg());
    await expect(cmdInstall(f.deps, opts({ version: "main" }))).rejects.toThrow(
      /must be a release tag/,
    );
    await expect(cmdInstall(f.deps, opts({ version: "v1.2" }))).rejects.toThrow(
      /must be a release tag/,
    );
  });
});

describe("cmdInstall — latest resolution", () => {
  it("resolves the latest stable when no --version is given", async () => {
    const f = makeFakeDeps(
      baseCfg({
        json: { [latestUrl]: { tag_name: "v0.4.0" }, [tagUrl("v0.4.0")]: releaseJson("v0.4.0") },
      }),
    );
    expect(await cmdInstall(f.deps, opts({ version: undefined, dryRun: true }))).toBe(0);
    expect(f.out.join("\n")).toMatch(/Resolving release v0\.4\.0/);
  });

  it("fails closed when there is no stable release", async () => {
    const f = makeFakeDeps(baseCfg({ json: { [latestUrl]: { tag_name: "v1.0.0-rc.1" } } }));
    await expect(cmdInstall(f.deps, opts({ version: undefined }))).rejects.toThrow(
      /No stable release found/,
    );
  });
});

describe("cmdInstall — extraction + hand-off", () => {
  it("extracts into a fresh dir and hands off to quickstart", async () => {
    const f = makeFakeDeps(baseCfg({ env: { ACTRADECK_INSTALL_DIR: "/opt/ad" }, handoffCode: 0 }));
    expect(await cmdInstall(f.deps, opts())).toBe(0);
    expect(f.extracted).toEqual([
      { tar: "/tmp/fake-work/actradeck-0.4.0.tar.gz", dest: "/opt/ad" },
    ]);
    expect(f.handoffs).toEqual(["/opt/ad"]);
  });

  it("propagates the quickstart exit code", async () => {
    const f = makeFakeDeps(baseCfg({ env: { ACTRADECK_INSTALL_DIR: "/opt/ad" }, handoffCode: 3 }));
    expect(await cmdInstall(f.deps, opts())).toBe(3);
  });

  it("defaults the install dir to <home>/actradeck", async () => {
    const f = makeFakeDeps(baseCfg({ home: "/home/tester" }));
    await cmdInstall(f.deps, opts());
    expect(f.extracted[0]?.dest).toBe("/home/tester/actradeck");
  });

  it("refuses a non-empty install dir", async () => {
    const f = makeFakeDeps(
      baseCfg({ env: { ACTRADECK_INSTALL_DIR: "/opt/ad" }, nonEmptyDirs: { "/opt/ad": true } }),
    );
    await expect(cmdInstall(f.deps, opts())).rejects.toThrow(/Install directory is not empty/);
    expect(f.extracted).toHaveLength(0);
  });

  it("cleans temp even if extraction fails", async () => {
    const f = makeFakeDeps(
      baseCfg({ env: { ACTRADECK_INSTALL_DIR: "/opt/ad" }, extractFails: true }),
    );
    await expect(cmdInstall(f.deps, opts())).rejects.toThrow(/extract failed/);
    expect(f.removed).toContain("/tmp/fake-work");
  });
});
