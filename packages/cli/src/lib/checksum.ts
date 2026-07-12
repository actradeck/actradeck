import { createHash } from "node:crypto";

// Digest verification, kept in lockstep with scripts/install.sh's pure helpers
// (expected_digest_for / verify_sha256). The two are NOT byte-for-byte identical parsers;
// they converge via a shared NORMALIZATION CONTRACT (QA-R2-1) on the test-vector domain
// that INV-NPM-TS-SHELL-PARITY (scripts/test-release-prep.sh) pins — the same checksums.txt
// yields the same result on both sides regardless of cosmetic formatting:
//   - LOWERCASE the hex digest (a sha256 digest is case-insensitive),
//   - tolerate CRLF line endings: strip the TRAILING \r only (`.trim()`) — an interior \r
//     in a name stays significant and fails closed on both sides (SEC-R3-1),
//   - require a 64-hex digest field (a malformed line is "not found", never a non-hex value),
//   - FIRST match wins on duplicate asset names (install.sh mirrors this).
// This is not a weakening: a genuinely DIFFERENT digest still differs after normalization
// and is still rejected. FAIL-CLOSED throughout: a missing digest entry, an empty expected
// value, or a mismatch is never a false OK.

/** Lowercase hex sha256 of the given bytes (Node crypto). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve the sha256 recorded for `assetName` in a `sha256sum`-format checksums file
 * (`<hex>  <name>` or `<hex> *<name>`). Returns null if not present — the caller MUST treat
 * that as fail-closed (mirrors expected_digest_for's non-zero exit).
 */
export function expectedDigestFor(checksums: string, assetName: string): string | null {
  for (const raw of checksums.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line);
    if (m) {
      const hex = m[1];
      const name = m[2];
      if (hex && name === assetName) return hex.toLowerCase();
    }
  }
  return null;
}

/**
 * True iff `bytes` hashes to `expected`. FAIL-CLOSED: an empty/absent expected digest
 * returns false (never a false OK), matching verify_sha256's non-zero exit on no digest.
 */
export function verifySha256(bytes: Uint8Array, expected: string | null): boolean {
  if (!expected) return false;
  return sha256Hex(bytes) === expected.toLowerCase();
}
