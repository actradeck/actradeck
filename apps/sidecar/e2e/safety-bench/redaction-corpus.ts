/**
 * Redaction benchmark corpus — SYNTHETIC fixtures only (REAL DATA ONLY / no real secrets).
 *
 * ⚠️ Placement: this file lives under the `apps/sidecar/e2e` tree on purpose. The OSS secret
 * scan (`scripts/lib/oss-patterns.sh`) exempts fake-secret fixtures BY PATH (grep
 * `--exclude-dir=e2e` and the git pathspec that excludes the e2e directory), never by content
 * marker. Keeping the corpus here means the strict leak gate over the rest of the tree stays
 * content-hole-free (memory:
 * secret-scan-allowlist-path-based-not-content). Do NOT add a content-based exception to
 * oss-patterns.sh for this file, and do NOT move it out of an exempted directory.
 *
 * Fixture provenance: every positive vector reuses an EXISTING fake-secret value already committed
 * under `packages/redaction/test/redactor.test.ts` or `apps/sidecar/test/*.test.ts` (so no new
 * GitHub Push Protection per-secret unblock is introduced — memory:
 * github-push-protection-blocks-redaction-fixtures). `auth-scheme-value` reuses the same
 * `live_9f8e7d…` token as the `auth-header-scheme` fixture, just without the header prefix.
 *
 * Ground truth is assigned by HUMAN intent (this secret MUST be masked / this benign string MUST
 * be preserved), not by reading redactor output — precision/recall must not be tautological.
 */

/** A positive vector: `input` contains `secret`, which MUST NOT survive redaction. */
export interface PositiveVector {
  /** Redaction kind family this vector exercises (event-model REDACTION_KINDS value). */
  readonly kind: string;
  /** The full string fed to redactString. */
  readonly input: string;
  /** The raw secret substring that must be absent from the output (leak check). */
  readonly secret: string;
}

/** A negative vector: `input` contains NO secret and MUST be preserved verbatim. */
export interface NegativeVector {
  /** Short label for the class of hard negative (why it is a plausible false-positive trap). */
  readonly label: string;
  /** The full string fed to redactString; output must equal input (no `[REDACTED:` marker). */
  readonly input: string;
}

/**
 * Positive vectors grouped by kind family. Multiple vectors per family where fixtures exist.
 * All values are documented fake examples reused from the committed test suite.
 */
export const POSITIVES: readonly PositiveVector[] = [
  // --- PEM private key ---
  {
    kind: "private-key",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123def456\n-----END RSA PRIVATE KEY-----",
    secret: "MIIEowIBAAKCAQEAabc123def456",
  },
  // --- cloud / vendor prefixed tokens ---
  { kind: "aws-access-key-id", input: "AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
  {
    kind: "github-token",
    input: "ghp_1234567890abcdefABCDEF1234567890abcd",
    secret: "ghp_1234567890abcdefABCDEF1234567890abcd",
  },
  {
    kind: "anthropic-key",
    input: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
    secret: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
  },
  {
    kind: "openai-key",
    // Reused from apps/sidecar/test/inv-codex-rollout-redaction.test.ts.
    input: "sk-proj-fakeOnlyNotReal012345678901234567890123456789",
    secret: "sk-proj-fakeOnlyNotReal012345678901234567890123456789",
  },
  {
    kind: "google-api-key",
    input: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    secret: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
  },
  {
    kind: "slack-token",
    input: "xoxb-12345678901-abcdefghijklmno",
    secret: "xoxb-12345678901-abcdefghijklmno",
  },
  {
    kind: "stripe-key",
    input: "sk_live_1234567890abcdefABCDEFgh",
    secret: "sk_live_1234567890abcdefABCDEFgh",
  },
  {
    kind: "gitlab-token",
    input: "GITLAB_TOKEN=glpat-ABCDEF1234567890wxyz",
    secret: "glpat-ABCDEF1234567890wxyz",
  },
  {
    kind: "sendgrid-key",
    input: "SG.aBcDeFgHiJkLmNoPqRsTuv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
    secret: "SG.aBcDeFgHiJkLmNoPqRsTuv.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab",
  },
  // --- Phase-4 bare vendor tokens (high-entropy gate blind spots covered by fixed prefixes) ---
  {
    kind: "huggingface-token",
    input: `pre hf_${"a".repeat(36)} post`,
    secret: `hf_${"a".repeat(36)}`,
  },
  {
    kind: "azure-ad-client-secret",
    input: `pre abc1Q~${"d".repeat(33)} post`,
    secret: `abc1Q~${"d".repeat(33)}`,
  },
  {
    kind: "databricks-token",
    input: `pre dapi${"0123456789abcdef".repeat(2)} post`,
    secret: `dapi${"0123456789abcdef".repeat(2)}`,
  },
  {
    kind: "doppler-token",
    input: `pre dp.pt.${"a".repeat(43)} post`,
    secret: `dp.pt.${"a".repeat(43)}`,
  },
  {
    kind: "planetscale-token",
    input: `pre pscale_tkn_${"a".repeat(38)} post`,
    secret: `pscale_tkn_${"a".repeat(38)}`,
  },
  { kind: "flyio-token", input: `pre fo1_${"a".repeat(43)} post`, secret: `fo1_${"a".repeat(43)}` },
  // --- URL-embedded webhook secrets ---
  {
    kind: "slack-webhook",
    input: "https://hooks.slack.com/services/T01ABCD2EFG/B09HIJK3LMN/aBcDeFgHiJkLmNoPqRsTuVwX",
    secret: "aBcDeFgHiJkLmNoPqRsTuVwX",
  },
  {
    kind: "discord-webhook",
    input:
      "https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-AbCd",
    secret: "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-AbCd",
  },
  // --- JWT ---
  {
    kind: "jwt",
    input:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    secret: "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  },
  // --- Authorization / auth schemes ---
  {
    kind: "basic-auth",
    input: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    secret: "dXNlcjpwYXNzd29yZA==",
  },
  {
    kind: "bearer-token",
    input: "Authorization: Bearer abcdef1234567890XYZ",
    secret: "abcdef1234567890XYZ",
  },
  {
    kind: "auth-header-scheme",
    input: "Authorization: ApiKey live_9f8e7d6c5b4a32100011223344556677",
    secret: "live_9f8e7d6c5b4a32100011223344556677",
  },
  {
    kind: "auth-header-scheme",
    input: "WWW-Authenticate: Negotiate YIIZ1234567890abcdefNEGOTIATETOKEN",
    secret: "YIIZ1234567890abcdefNEGOTIATETOKEN",
  },
  {
    kind: "auth-scheme-value",
    // Same fake token value as the auth-header-scheme fixture, header prefix removed (object-value path).
    input: "ApiKey live_9f8e7d6c5b4a32100011223344556677",
    secret: "live_9f8e7d6c5b4a32100011223344556677",
  },
  // --- Cookie ---
  {
    kind: "cookie",
    input: "Cookie: session=abc123def456ghi789xyz",
    secret: "abc123def456ghi789xyz",
  },
  {
    kind: "cookie",
    input: "Set-Cookie: auth=tok_9f8e7d6c5b4a3210zzzz; Path=/",
    secret: "tok_9f8e7d6c5b4a3210zzzz",
  },
  // --- npm registry auth token ---
  {
    kind: "npm-auth-token",
    input: "//registry.npmjs.org/:_authToken=npm_abcdef0123456789ABCDEF0123456789abcd",
    secret: "npm_abcdef0123456789ABCDEF0123456789abcd",
  },
  // --- generic credential assignment (env / JSON / YAML) ---
  {
    kind: "credential-assignment",
    input: "API_KEY=supersecretvalue123",
    secret: "supersecretvalue123",
  },
  {
    kind: "credential-assignment",
    input: "DB_PASSWORD=Sup3rSecretDbPass",
    secret: "Sup3rSecretDbPass",
  },
  {
    kind: "credential-assignment",
    input: '{"client_secret": "abcdef987654321zzz"}',
    secret: "abcdef987654321zzz",
  },
  { kind: "credential-assignment", input: "password=abc12", secret: "abc12" },
  {
    kind: "credential-assignment",
    input: "token: 'sq with space inside'",
    secret: "sq with space inside",
  },
  // --- bounded-capture residual (fragment-survival demonstrator · R4 finding A) ---
  // A long credential value whose HEAD is masked by the credential-assignment rule (bounded at
  // MAX_VALUE_LEN = 4096) while the >4096-char TAIL overflows every bounded capture and survives:
  // the leftover run exceeds the standalone high-entropy rule's {40,4096} bound, so its trailing
  // lookahead can never anchor (documented redactor residual — see the `high-entropy-secret`
  // "scope 境界 (SEC-3)" note in packages/redaction/src/redactor.ts). The FULL secret string is
  // therefore absent from the output (head removed), so the exact full-substring recall metric
  // counts this vector as DETECTED — yet a multi-thousand-char contiguous fragment of the value
  // survives, which only the fragment-survival metric catches (see bench.ts FRAGMENT_MIN_LEN).
  // This is the exact blind spot R4 flagged: partial/straddle survival that a full-match check
  // reports as "detected". Value is `.repeat()`-built (constructed, not a new literal) so it adds
  // no new fake-secret string and cannot trip GitHub Push Protection's per-secret unblock.
  {
    kind: "credential-assignment",
    input: `HUGE_SECRET_BLOB=${"xY7bQ2".repeat(1500)}`,
    secret: "xY7bQ2".repeat(1500),
  },
  // --- URL credential (user:pass@host) ---
  {
    kind: "url-credential",
    input: "postgres://app:s3cretP4ss@db.internal:5432/x",
    secret: "s3cretP4ss",
  },
  { kind: "url-credential", input: "user:s3cretpass@host.internal", secret: "s3cretpass" },
  // --- standalone high-entropy secrets (AWS secret key, cloud AccountKey) ---
  {
    kind: "high-entropy-secret",
    input: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  {
    kind: "high-entropy-secret",
    input: "AccountKey=DKRYfmt07CJQXelsz6BIPWdkry5AHOVcjqx4/GNUbipw",
    secret: "DKRYfmt07CJQXelsz6BIPWdkry5AHOVcjqx4/GNUbipw",
  },
  // --- Sentry DSN userinfo ---
  {
    kind: "sentry-dsn",
    input: "SENTRY_DSN=https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/4567",
    secret: "0123456789abcdef0123456789abcdef",
  },
];

/**
 * Hard negatives — strings that resemble secrets (high entropy, hex, base64-ish, vendor-prefix
 * near-misses) but carry NO secret and MUST be preserved verbatim. These probe over-redaction
 * (false-positive rate). ActraDeck's value is showing real paths / commands / correlation ids, so
 * masking these would destroy supervisory signal.
 */
export const NEGATIVES: readonly NegativeVector[] = [
  // Paths (preserving diffs / commands is the whole product).
  { label: "deep-abs-path", input: "/home/user/Files/ActraDeck/apps/sidecar/src/redactor.ts" },
  {
    label: "url-path",
    input: "https://example.com/api/v2/users/profile/settings/advanced/options",
  },
  { label: "relative-import", input: "../../packages/event-model/src/index/normalize/payload" },
  {
    label: "mixed-case-sep-path",
    input: "/home/user/Files/Actra-Deck/apps_v2/my_module-name/src/Deep_Nested/file_handler",
  },
  { label: "git-diff-path", input: "a/apps/sidecar/src/redactor.ts" },
  {
    label: "pnpm-node-modules-path",
    input: "node_modules/.pnpm/typescript/node_modules/typescript/lib/typescriptServices",
  },
  // Correlation ids (must stay visible so sessions do not collide into one bucket).
  { label: "single-uuid", input: "550e8400-e29b-41d4-a716-446655440000" },
  {
    label: "concatenated-uuid-trace",
    input: "550e8400-e29b-41d4-a716-446655440000-6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  },
  { label: "sess-prefixed-uuid", input: "sess_019e9529-f154-741e-80d5-d90a205fc82e" },
  // Hashes / hex — 2 char classes only, must not hit the 3-class entropy gate.
  { label: "git-sha-40hex", input: "9f1e5c3b2a8d7e6f4c1b0a9d8e7f6c5b4a3d2e1f" },
  {
    label: "sha256-64hex",
    input: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  // Vendor-prefix near-misses (benign strings sharing a prefix shape).
  { label: "hf-nonmatch", input: "hffile_report.txt" },
  { label: "hf-too-short", input: "hf_short" },
  { label: "dapi-nonhex", input: "dapifoo" },
  { label: "dppt-nonmatch", input: "dp.point.config" },
  { label: "pscale-nonmatch", input: "pscale_config" },
  { label: "fo1-nonmatch", input: "foo1_bar" },
  // Ordinary config / prose that must never be masked.
  { label: "plain-command", input: "running npm test in /repo, 3 files changed" },
  { label: "env-path", input: "PATH=/usr/local/bin:/usr/bin:/bin" },
  { label: "node-env", input: "NODE_ENV=production" },
  { label: "semver", input: "typescript@5.6.2" },
  { label: "docker-image-digest", input: "postgres@sha256:1234abcd" },
];
