// Repository resolution — name-agnostic (ADR 019f5131 / 019f2bc1): no owner/org is
// hardcoded in behavior. The default is the public mirror `actradeck/actradeck` (kept in
// lockstep with scripts/version.sh RELEASE_REPO and scripts/lib/oss-patterns.sh
// OSS_DEFAULT_REPO), overridable via the ACTRADECK_REPO env var.

/**
 * Canonical default public mirror. This is a THIRD copy of the value (this package is
 * dependency-free and cannot source the shell libs): the canonical source is
 * `OSS_DEFAULT_REPO` in scripts/lib/oss-patterns.sh, also duplicated in scripts/version.sh.
 * TDA-3: scripts/test-release-prep.sh (INV-NPM-DEFAULT-REPO-SYNC) asserts this literal equals
 * OSS_DEFAULT_REPO so the three copies can't drift. If the mirror name changes, update all three.
 */
export const DEFAULT_REPO = "actradeck/actradeck";

/**
 * Reduce a repo reference to `owner/name`. Accepts a full git/https URL or a bare
 * `owner/name`. Strips scheme, userinfo, host, a trailing `.git`, and trailing slashes.
 * Returns null on any shape that is NOT exactly `owner/name` of safe chars — the caller
 * fails closed rather than passing a malformed slug to the GitHub API. Mirrors
 * scripts/install.sh's repo_slug + its owner/name shape validation.
 */
export function repoSlug(ref: string): string | null {
  let s = ref.trim();
  s = s.replace(/^[a-z0-9+.-]+:\/\//i, ""); // drop scheme://
  s = s.replace(/^[^@/]+@/, ""); // drop any user[:pass]@ userinfo
  // Drop a leading host: the first segment, terminated by ':' (scp `host:owner/repo`) or '/'
  // (url `host/owner/repo`), when it looks like a host (contains a dot). A bare `owner/name`
  // has no dotted host segment and is left intact.
  const host = /^([^/:]+)[/:]/.exec(s);
  if (host && host[1]!.includes(".")) s = s.slice(host[0].length);
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  // Exactly one slash, non-empty owner + name, safe chars only.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

/**
 * Resolve the effective `owner/name` from the environment (ACTRADECK_REPO or the default).
 * Throws a clean, input-free message if the override is malformed (NO-RAW: the offending
 * value is not echoed verbatim into the error).
 */
export function resolveRepo(env: Record<string, string | undefined>): string {
  const raw = env["ACTRADECK_REPO"];
  const ref = raw && raw.trim() ? raw : DEFAULT_REPO;
  const slug = repoSlug(ref);
  if (!slug) {
    throw new Error(
      "ACTRADECK_REPO does not resolve to an 'owner/name' repository. Set it to e.g. actradeck/actradeck.",
    );
  }
  return slug;
}

/** GHCR image path for a slug (lowercased, GHCR requires a lowercase path). */
export function ghcrImage(slug: string): string {
  return `ghcr.io/${slug.toLowerCase()}`;
}
