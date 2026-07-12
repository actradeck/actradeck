# Redaction & risk-classifier benchmark

ActraDeck redacts secrets _before_ they are persisted or sent, and classifies shell commands into
high-risk categories so a bypass/YOLO agent's most dangerous actions can still be held for human
approval. The README states plainly that detection is **"best-effort pattern matching — a strong
safety net, not an absolute guarantee."** This page backs that claim with a **reproducible,
synthetic benchmark** and reports the **actual measured numbers**.

> **Honesty first.** The corpus is synthetic (no real secrets — this is a redaction product, so we
> never commit real credentials). Numbers are measured, not asserted; run the command yourself and
> you will get the same figures (the redactor and classifier are pure functions and the corpus is
> fixed, so output is byte-stable across runs).

## Reproduce

```bash
pnpm --filter @actradeck/sidecar run bench:safety          # human-readable tables + JSON
pnpm --filter @actradeck/sidecar run bench:safety -- --json # JSON only (for tooling)
```

Source: `apps/sidecar/e2e/safety-bench/` (corpus + scoring harness) and
`docs/benchmarks/redaction-and-risk-classifier.md` (this page). The harness exercises the **real
production code** — `redactString` from `@actradeck/redaction` and `classifyCommandWithCategories`
from `apps/sidecar/src/normalize.ts` — with no mocks.

## Methodology

- **Ground truth is human-assigned.** For redaction, each positive vector declares the exact secret
  substring that MUST NOT survive; each negative declares a benign string that MUST be preserved.
  For the classifier, expected categories are labelled from the category _definitions_ (the intent
  documented on `PolicyCategory` in `packages/event-model/src/payload.ts`), **not** derived from the
  classifier's own output — otherwise precision/recall would be a tautological 100%.
- **Redaction recall = leak avoidance.** A positive counts as detected iff the raw secret substring
  is absent from the output — the security-relevant metric. A leak (the secret survives) is a
  false negative.
- **Redaction precision = over-redaction avoidance.** A negative counts as a false positive iff any
  `[REDACTED:…]` marker appears in the output (a benign string was masked). ActraDeck's product
  value is showing real paths / commands / correlation ids, so over-redaction destroys supervisory
  signal.
- **Classifier metrics** are standard multi-label precision/recall against the human category
  labels, plus a **gate-decision** outcome (would this command be held for approval under a given
  enabled-category policy?) and a risk-level exact-match accuracy.
- **Fixtures reuse existing test values.** Every fake secret is reused from the committed test
  suite so no new value trips GitHub Push Protection on publish. The corpus lives under the
  `apps/sidecar/e2e` tree, which the OSS secret scan exempts _by path_ (not by content marker), so
  the strict leak gate over the rest of the tree stays hole-free.

Corpus size: **37 redaction positives** across **29 kind families**, **22 hard negatives**, and
**43 classifier command vectors**.

## Results — redaction

Measured on 2026-07-12 against the T1 canonical redactor (`packages/redaction/src/redactor.ts`).

| Metric                                     | Value                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Overall recall (secrets caught)            | **100.0%** (37/37, 0 leaks)                                            |
| Mask precision (masks that hit a secret)   | **97.4%** (37/38 — the 1 extra mask is the safe over-redaction below)  |
| Benign preservation (hard negatives)       | **95.5%** (21/22 preserved verbatim)                                   |
| Kind families covered                      | 29                                                                     |

**Per-kind recall: 100% for every one of the 29 families** — private-key, aws-access-key-id,
github-token, anthropic-key, openai-key, google-api-key, slack-token, stripe-key, gitlab-token,
sendgrid-key, huggingface-token, azure-ad-client-secret, databricks-token, doppler-token,
planetscale-token, flyio-token, slack-webhook, discord-webhook, jwt, basic-auth, bearer-token,
auth-header-scheme, auth-scheme-value, cookie, npm-auth-token, credential-assignment,
url-credential, high-entropy-secret, sentry-dsn.

**One false positive (over-redaction, safe direction).** A `sess_<uuidv7>` correlation id passed as
**free text** to `redactString` is masked as `high-entropy-secret`. This is by design and worth
understanding: session-id preservation is **field-aware** — the redactor keeps `sess_<uuid>` only
when it appears as a top-level correlation-key field of a structured event (see
`isCorrelationKeyValue` / `CORRELATION_KEY_FIELDS` in the redactor). In free-form summary/stdout
text the same value looks like a high-entropy token and is masked. The failure direction is safe
(over-redaction, never a leak), so we report it honestly rather than hiding it behind a curated
100%.

## Results — risk classifier

Measured against `classifyCommandWithCategories` (`apps/sidecar/src/normalize.ts`).

**Scope.** This benchmarks the **command-pattern** categories the classifier derives from the
command string: `recursive-rm`, `disk-destroy`, `history-rewrite`, `db-drop`, `fork-bomb`,
`perm-change`, `inline-code`, `migrate-prod`, `high-risk-other`. The composite/context categories
`secret-egress`, `secret-file-edit`, and `external-tool` are decided in the approval-bridge from
the tool input (not from the command string alone) and are **out of scope** for this harness.

| Category          | Support | Precision | Recall     |
| ----------------- | ------- | --------- | ---------- |
| recursive-rm      | 6       | 100.0%    | 100.0%     |
| disk-destroy      | 4       | 80.0%     | 100.0%     |
| history-rewrite   | 4       | 100.0%    | 100.0%     |
| db-drop           | 3       | 75.0%     | 100.0%     |
| fork-bomb         | 1       | 100.0%    | 100.0%     |
| perm-change       | 3       | 100.0%    | 100.0%     |
| inline-code       | 4       | 100.0%    | 100.0%     |
| migrate-prod      | 2       | 50.0%     | 100.0%     |
| **micro-average** | 27      | **87.1%** | **100.0%** |

**Recall is 100% on every category** — nothing dangerous in the corpus slips past the classifier.
Precision is below 100% only where a keyword literal fires on a benign near-miss (below). This is
the deliberate design bias: **under-detection (a real destructive op sneaking through) is far worse
than over-gating (an extra approval prompt)**, so ambiguous cases fail toward "gate it."

### Gate-decision outcome (would the command be held for approval?)

| Policy                              | Precision | Recall | TP / FP / FN / TN |
| ----------------------------------- | --------- | ------ | ----------------- |
| default-gated (out-of-box)          | 90.0%     | 100.0% | 18 / 2 / 0 / 23   |
| strict-all (every category enabled) | 86.7%     | 100.0% | 26 / 4 / 0 / 13   |

- Risk-level exact-match accuracy: **86.0%**.
- Danger recall (vectors labelled non-`low` that the classifier flags non-`low`): **96.2%**.

Under the out-of-box `DEFAULT_GATED_CATEGORIES`, `perm-change` / `inline-code` / `migrate-prod` are
**off by default** (operator opt-in), which is why their false positives do not affect the
default-gated precision. This matches the documented default: the most catastrophic, irreversible
categories gate out of the box; the noisier categories are opt-in.

### Divergences from human labels (findings / calibration notes)

The harness prints every divergence. All false positives are **safe-direction over-gates** driven
by whole-command keyword literals:

| Command                                 | Divergence               | Nature                                                                                                  |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `dd if=backup.iso of=restore.iso bs=4M` | predicted `disk-destroy` | `dd if=` literal fires even for a file-to-file copy (no block device). Intentional safe-side over-gate. |
| `grep -rn 'DROP TABLE' migrations/`     | predicted `db-drop`      | The literal `DROP TABLE` string appears in a _search_ argument. Keyword match, not intent.              |
| `echo 'see the production runbook'`     | predicted `migrate-prod` | `production` keyword in prose. Off by default.                                                          |
| `cat docs/migrate-guide.md`             | predicted `migrate-prod` | `migrate` keyword in a filename. Off by default.                                                        |

Risk-level calibration notes (not safety gaps):

- `psql -c 'DROP DATABASE prod'` classifies as risk `low` while the `db-drop` **category still
  fires** (so the gate still holds it). `DROP DATABASE` is intentionally a _category-only_ literal:
  it drives the approval gate without inflating the risk score. The safety outcome (held for
  approval under default policy) is correct; only the numeric risk label differs from a human's.
- `find … -exec rm {} ;` classifies as `medium` rather than `high`; it is still gated
  (`recursive-rm`).

## Honest limitations

- **Synthetic corpus.** These numbers characterize the detectors against curated vectors, not a
  representative sample of real-world traffic. 100% recall means "no vector in this corpus leaked,"
  not "no secret can ever leak."
- **Inline detection only.** Both the redactor and the `secret-egress` composite detect secrets
  present **inline** in the text/command. File-reference exfiltration (`curl --data @.env`,
  `scp .env host:`) carries no inline secret and is out of reach of pattern matching — the same
  limitation gitleaks-style tools share.
- **Known structural residuals** are documented in the redactor source (e.g. a standalone base64
  run longer than the bounded capture length, or a JWT signature tail beyond the cap). These are
  deliberate ReDoS/over-redaction trade-offs, not oversights, and are pinned by `INV-REDACTION-*`
  tests.
- **Canonical-form classifier vectors.** The command corpus uses canonical shapes of each dangerous
  pattern. An obfuscated or interpreter-mediated equivalent (e.g. `perl -e 'unlink glob "*"'` as a
  mass delete) may carry only the `inline-code` category (default-OFF) and miss a named category
  such as `recursive-rm` — so the measured 100% category recall reflects canonical-form coverage,
  not robustness to obfuscation.
- **Best-effort, by construction.** New vendor token formats appear constantly; the rule set is
  maintained, not exhaustive. The classifier's category keywords are a denylist-plus-structural
  hybrid, not a complete grammar of dangerous shell. Treat both as a strong safety net layered on
  top of the agent's own permissions, never as the sole control.

## Relationship to the invariant tests

This benchmark is a **measurement**, not a gate. The hard guarantees live in the `INV-REDACTION-*`
and classifier invariant tests (`packages/redaction/test/`, `apps/sidecar/test/`), which fail CI on
regression. The benchmark corpus is deliberately separate so that adding measurement vectors never
weakens a security invariant, and so the published numbers can be regenerated on demand.
