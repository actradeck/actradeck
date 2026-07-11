// Minimal, dependency-free semantic-version parsing + comparison. Enough to answer "is a
// newer stable release available than the one I am?" — NOT a full SemVer implementation.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, or null for a normal release. */
  prerelease: string[] | null;
}

const CORE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse "vX.Y.Z" / "X.Y.Z" (optional -prerelease / +build). Returns null if unparseable. */
export function parseSemver(input: string): SemVer | null {
  const m = CORE.exec(input.trim());
  if (!m) return null;
  const [, maj, min, pat, pre] = m;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    prerelease: pre ? pre.split(".") : null,
  };
}

/** True iff the version carries a pre-release tag (e.g. 1.2.0-rc.1) — i.e. not "stable". */
export function isStable(v: SemVer): boolean {
  return v.prerelease === null;
}

function comparePre(a: string[] | null, b: string[] | null): number {
  // A version WITHOUT a pre-release outranks one WITH (1.0.0 > 1.0.0-rc.1) — SemVer §11.3.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined) return -1; // a is a proper prefix -> lower precedence
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers are lower precedence than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** -1 if a<b, 0 if equal precedence, 1 if a>b. Build metadata is ignored (SemVer §10). */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.prerelease, b.prerelease);
}
