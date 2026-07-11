// GitHub Release resolution + asset selection. Pure over an injected `fetchJson`, so the
// unit tests drive it without the network. The download of asset BYTES is a separate Deps
// call (fetchBytes) invoked by the install command.

import { parseSemver, isStable, compareSemver, type SemVer } from "./semver.js";

export interface ReleaseAsset {
  name: string;
  /** Public browser download URL (no auth needed for public releases). */
  url: string;
}

export interface ReleaseInfo {
  tag: string;
  assets: ReleaseAsset[];
}

const API = "https://api.github.com";

interface RawAsset {
  name?: unknown;
  browser_download_url?: unknown;
}
interface RawRelease {
  tag_name?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: unknown;
}

function toAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseAsset[] = [];
  for (const a of raw as RawAsset[]) {
    if (a && typeof a.name === "string" && typeof a.browser_download_url === "string") {
      out.push({ name: a.name, url: a.browser_download_url });
    }
  }
  return out;
}

/** Fetch a release by its exact tag (e.g. "v0.4.0"). */
export async function fetchReleaseByTag(
  fetchJson: (url: string) => Promise<unknown>,
  slug: string,
  tag: string,
): Promise<ReleaseInfo> {
  const body = (await fetchJson(
    `${API}/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`,
  )) as RawRelease;
  const tagName = typeof body.tag_name === "string" ? body.tag_name : tag;
  return { tag: tagName, assets: toAssets(body.assets) };
}

/**
 * Resolve the latest STABLE release tag. `/releases/latest` already excludes drafts and
 * pre-releases per GitHub's semantics; we re-check `prerelease` defensively and also verify
 * the tag parses as a stable semver, so a mis-tagged pre-release can never be offered as
 * "latest stable".
 */
export async function fetchLatestStableTag(
  fetchJson: (url: string) => Promise<unknown>,
  slug: string,
): Promise<string | null> {
  const body = (await fetchJson(`${API}/repos/${slug}/releases/latest`)) as RawRelease;
  if (body.prerelease === true || body.draft === true) return null;
  const tag = typeof body.tag_name === "string" ? body.tag_name : null;
  if (!tag) return null;
  const v = parseSemver(tag);
  if (!v || !isStable(v)) return null;
  return tag;
}

/** The canonical source-tarball asset name for a version (git archive prefix convention). */
export function tarballName(version: string): string {
  return `actradeck-${version}.tar.gz`;
}

/** Find a named asset in a release, or null. */
export function findAsset(rel: ReleaseInfo, name: string): ReleaseAsset | null {
  return rel.assets.find((a) => a.name === name) ?? null;
}

/**
 * Compare a resolved latest tag against the running version. Returns:
 *   "update"   — latest is newer,
 *   "current"  — running is >= latest,
 *   "unknown"  — either version is unparseable.
 */
export function updateStatus(
  selfVersion: string,
  latestTag: string,
): "update" | "current" | "unknown" {
  const self: SemVer | null = parseSemver(selfVersion);
  const latest: SemVer | null = parseSemver(latestTag);
  if (!self || !latest) return "unknown";
  return compareSemver(latest, self) > 0 ? "update" : "current";
}
