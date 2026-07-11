import type { Deps } from "../lib/types.js";
import { resolveRepo } from "../lib/repo.js";
import { fetchLatestStableTag, updateStatus } from "../lib/release.js";

// `actradeck version` — print the CLI's own version, then (best effort) compare against the
// latest stable release. Offline-safe: if GitHub is unreachable, print the local version and
// say so plainly rather than crashing.
export async function cmdVersion(deps: Deps): Promise<number> {
  deps.io.out(`actradeck ${deps.selfVersion}`);

  const slug = resolveRepo(deps.env); // only throws on a malformed ACTRADECK_REPO override
  try {
    const latest = await fetchLatestStableTag(deps.fetchJson, slug);
    if (!latest) {
      deps.io.out(`Latest stable release: unknown (no stable release published for ${slug} yet).`);
      return 0;
    }
    const status = updateStatus(deps.selfVersion, latest);
    if (status === "update") {
      deps.io.out(
        `A newer stable release is available: ${latest} (you have ${deps.selfVersion}). Update: npx actradeck@latest`,
      );
    } else if (status === "current") {
      deps.io.out(`You are on the latest stable release (${latest}).`);
    } else {
      deps.io.out(`Latest stable release: ${latest}.`);
    }
    return 0;
  } catch {
    // Network error / rate limit / DNS — honest fallback, never a crash (ADR D3: offline path).
    deps.io.out(
      "Could not reach GitHub to check for updates (offline?). Showing the local version only.",
    );
    return 0;
  }
}
