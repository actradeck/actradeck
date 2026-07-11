import type { Deps } from "../lib/types.js";
import { resolveRepo } from "../lib/repo.js";
import { parseSemver } from "../lib/semver.js";
import { fetchReleaseByTag, fetchLatestStableTag, findAsset, tarballName } from "../lib/release.js";
import { expectedDigestFor, verifySha256 } from "../lib/checksum.js";

export interface InstallOpts {
  /** Explicit release tag (vX.Y.Z), or undefined to resolve the latest stable. */
  version: string | undefined;
  /** Verify everything but stop BEFORE extraction / quickstart hand-off. */
  dryRun: boolean;
  /** Explicit opt-out of provenance verification (checksum is ALWAYS enforced). */
  skipProvenance: boolean;
}

// `actradeck install` — resolve a signed GitHub Release, download its tarball + checksums,
// VERIFY (sha256 via Node crypto — same semantics as install.sh's expected_digest_for — plus
// build provenance via `gh attestation verify`), and only then extract + hand off to the
// repo's own scripts/quickstart. Verification is FAIL-CLOSED by default with NO silent skip;
// the only way to weaken it is the explicit --skip-provenance flag (checksum stays mandatory).
export async function cmdInstall(deps: Deps, opts: InstallOpts): Promise<number> {
  const slug = resolveRepo(deps.env);

  // 1. resolve the tag ------------------------------------------------------
  let tag: string;
  if (opts.version) {
    if (!/^v/.test(opts.version) || !parseSemver(opts.version)) {
      throw new Error(
        "--version must be a release tag like v0.4.0 (branches/commits are unsigned).",
      );
    }
    tag = opts.version;
  } else {
    const latest = await fetchLatestStableTag(deps.fetchJson, slug);
    if (!latest) {
      throw new Error(
        `No stable release found for ${slug}. Pass --version vX.Y.Z, or check that a signed release exists.`,
      );
    }
    tag = latest;
  }
  const version = tag.replace(/^v/, "");
  const tarName = tarballName(version);

  deps.io.out(`Resolving release ${tag} from ${slug} ...`);
  const rel = await fetchReleaseByTag(deps.fetchJson, slug, tag);
  const tarAsset = findAsset(rel, tarName);
  const csAsset = findAsset(rel, "checksums.txt");
  if (!tarAsset)
    throw new Error(`Release ${tag} has no ${tarName} asset (not a signed source release?).`);
  if (!csAsset)
    throw new Error(
      `Release ${tag} has no checksums.txt — cannot verify the digest (fail-closed).`,
    );

  // 2. download -------------------------------------------------------------
  deps.io.out("Downloading source tarball + checksums ...");
  const tarBytes = await deps.fetchBytes(tarAsset.url);
  const csText = new TextDecoder().decode(await deps.fetchBytes(csAsset.url));

  // 3. checksum (ALWAYS mandatory — no opt-out) -----------------------------
  const expected = expectedDigestFor(csText, tarName);
  if (!verifySha256(tarBytes, expected)) {
    throw new Error(
      `Checksum verification FAILED for ${tarName} — refusing to install (fail-closed).`,
    );
  }
  deps.io.out("Checksum verified (sha256).");

  // 4. provenance (fail-closed by default; explicit opt-out only) -----------
  if (opts.skipProvenance) {
    deps.io.err(
      "WARNING: --skip-provenance set — build provenance was NOT verified (checksum is still enforced). " +
        "Prefer installing the GitHub CLI 'gh' so provenance can be checked.",
    );
  } else {
    if (!(await deps.which("gh"))) {
      throw new Error(
        "Provenance verification requires the GitHub CLI 'gh' (https://cli.github.com). " +
          "Install it, or pass --skip-provenance to proceed on checksum only (not recommended).",
      );
    }
    const work = await deps.mkdtemp();
    try {
      const tarPath = `${work}/${tarName}`;
      await deps.writeFile(tarPath, tarBytes);
      deps.io.out("Verifying build provenance (gh attestation verify) ...");
      const r = await deps.exec("gh", ["attestation", "verify", tarPath, "--repo", slug]);
      if (r.code !== 0) {
        throw new Error(
          `Provenance verification FAILED for ${tarName} — refusing to install (fail-closed).`,
        );
      }
      deps.io.out("Provenance verified.");
    } finally {
      await deps.rmrf(work);
    }
  }

  // 5. dry-run stops here ---------------------------------------------------
  if (opts.dryRun) {
    const what = opts.skipProvenance ? "checksum" : "checksum + provenance";
    deps.io.out(
      `Dry run: ${tag} resolved and verified (${what}). Stopping before extraction / quickstart hand-off. Nothing was changed.`,
    );
    return 0;
  }

  // 6. extract into a fresh dir + hand off to quickstart --------------------
  const installDir = deps.env["ACTRADECK_INSTALL_DIR"]?.trim() || `${deps.homedir()}/actradeck`;
  if (await deps.dirHasContent(installDir)) {
    throw new Error(
      "Install directory is not empty. Set ACTRADECK_INSTALL_DIR to a fresh path and re-run (a verified install is a clean extraction).",
    );
  }
  const work = await deps.mkdtemp();
  try {
    const tarPath = `${work}/${tarName}`;
    await deps.writeFile(tarPath, tarBytes);
    deps.io.out(`Extracting verified source into ${installDir} ...`);
    await deps.extractTarball(tarPath, installDir);
  } finally {
    await deps.rmrf(work);
  }

  deps.io.out("Handing off to quickstart ...");
  return await deps.handoffQuickstart(installDir);
}
