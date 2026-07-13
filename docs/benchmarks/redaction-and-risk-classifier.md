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

Corpus size: **38 redaction positives** across **29 kind families**, **22 hard negatives**, and
**43 classifier command vectors**.

## Results — redaction

Measured on 2026-07-13 against the T1 canonical redactor (`packages/redaction/src/redactor.ts`).

| Metric                                   | Value                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Overall recall (full secret caught)      | **100.0%** (38/38, 0 full leaks)                                      |
| Mask precision (masks that hit a secret) | **97.4%** (38/39 — the 1 extra mask is the safe over-redaction below) |
| Benign preservation (hard negatives)     | **95.5%** (21/22 preserved verbatim)                                  |
| Fragment survival (partial leaks)        | **1 vector** (a bounded-capture tail — see Fragment survival below)   |
| Kind families covered                    | 29                                                                    |

"Overall recall" is measured by **full-secret** substring survival — the exact metric a full-match
check gives. It is deliberately paired with the fragment-survival metric below, which catches
**partial** leaks that a full-match check reports as "detected."

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

## Fragment survival (partial leaks a full-match check misses)

A leak measured only by **full-secret** substring survival (`output.includes(secret)`) is blind to
**partial** survival: a redactor can mask the head of a secret while a long tail fragment survives,
and the full-match check still reports "detected." That is the same danger class as a straddle leak.
The benchmark therefore also measures **fragment survival**: any contiguous substring of the raw
secret of length **≥ 8** that survives in the output and is **not** explained by preserved
non-secret input (see `leakedFragmentSpan` in `bench.ts`).

> **Why "not explained by preserved input" matters.** A naive "any ≥8-char substring of the secret
> present in the output" over-counts. In this corpus the `discord-webhook` positive embeds the digit
> run `…0123456789…` inside its secret, while the URL prefix redaction legitimately **preserves**
> contains the public webhook id `…123456789012345678…`. The token itself is fully masked, yet an
> 8-char digit run coincides between the secret and the preserved public id. That is **not** a leak.
> So a fragment counts only if it appears in the output and does **not** appear in the input with the
> secret removed. This keeps the metric honest in both directions.

**Measured result: 1 fragment leak across the 38 positives** (0 full leaks). The vector is a
constructed long credential assignment (`HUGE_SECRET_BLOB=<9000-char value>`). The
`credential-assignment` rule masks the value's head, but its capture is bounded at `MAX_VALUE_LEN`
(4096) — so a **~4904-character contiguous tail survives**. That leftover run is longer than the
standalone `high-entropy-secret` rule's `{40,4096}` bound, so its trailing lookahead never anchors
and it is left unmasked (a documented redactor residual — see the `high-entropy-secret` "scope
境界 (SEC-3)" note in `redactor.ts`).

> The harness reports the surviving span as a **lower bound** (`leakedSpan = 4902` for this vector,
> vs. the true 4904-char tail). The `≥ 8` leak _boolean_ is exact; only the reported magnitude can
> under-report by a few characters for a **periodic** secret, because a masked-head n-gram can equal
> a surviving-tail n-gram and the contiguity re-check then trims the run back from the end.
> Under-reporting magnitude is the safe direction (details in `leakedFragmentSpan`).

This vector is exactly what R4 flagged: the **full-substring recall counts it as detected** (the
full 9000-char secret string is absent from the output because the head is masked), yet a
multi-thousand-character fragment of the value leaks. Only the fragment-survival metric catches it.
We report it honestly rather than hiding it behind the 100% full-recall headline.

**Findings, reported not fixed** (this benchmark is measurement-only; production code is untouched):

- **REDACT-F2 (fragment leak, bounded-capture residual).** The long-credential tail above. It is a
  known, documented ReDoS/over-redaction trade-off in the redactor (`MAX_VALUE_LEN`-bounded captures
  are linear-time by construction), not an oversight. A related full-leak residual — a **standalone**
  base64 run longer than 4096 chars with no vendor prefix / credential key / PEM or JWT marker — is
  **documented only as a source note** (`SEC-3` in `redactor.ts`, lines ~667–672); it is _not_
  covered by an `INV-REDACTION-*` test (the redaction package's straddle invariants pin the
  **compensated** marker cases — PEM/JWT bounded-fallback — and standalone runs only up to the ~88-char
  fixtures, not this >4096 boundary). We do **not** add it to the curated recall corpus (it is an
  accepted design boundary, not a corpus gap), but the fragment metric would flag it as both a full
  and a fragment leak if it were present. Closing either residual would require a redactor change
  (out of scope for a measurement PR); pinning the >4096 standalone residual would need a new
  production `INV-REDACTION-*` test in the redaction package.

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

## External corpus cross-evaluation (gitleaks)

The corpus above is authored by the same people who wrote the redactor, so its recall is
self-correlated (R4 finding B: no independent holdout). To cross-check against an **independent**
ground truth, `cross-eval.mts` measures our redactor against the secret-detection rules shipped by
[gitleaks](https://github.com/gitleaks/gitleaks) (MIT licensed) — a widely used, independently
maintained secret scanner.

**Method.** gitleaks ships its rules as regexes in `config/gitleaks.toml`. The harness fetches that
single file at a **pinned commit** at run time (gitleaks **v8.30.1**, commit
`83d9cd684c87d95d656c1458ef04895a7f1cbd8e`), verifies its integrity (git-blob object id
`256f6479…`, 97 731 bytes, and raw SHA-256 `e163e53b…` — all enforced, fail-loud on mismatch), and —
for a curated subset of gitleaks rules that map onto our redaction kinds — synthesizes a sample that
is a **valid instance of the gitleaks rule** (verified against the rule's own regex), then runs it
through our production `redactString`. The gitleaks file is **fetched, never vendored** into this
repo, and **no gitleaks secret value is printed** here or committed. The numbers below are from an
actual live fetch of the pinned file (measured 2026-07-13).

```bash
pnpm --filter @actradeck/sidecar run bench:cross-eval   # opt-in; network-dependent; NOT run in CI
```

**Result: we mask 10 of 17 mapped gitleaks rules (58.8%) on their _minimal valid instance_.** Samples
are synthesized as the shortest legal instance (first alternation branch, minimum repetition), which
is a deliberately harsh setting — several "misses" are cases where gitleaks' regex accepts a shorter
or looser string than a real secret, and a **realistic** instance _does_ mask (verified below, with
the marker kind our redactor emits — never the value).

| gitleaks rule            | our kind          | min-instance result    | triage                                                                                               |
| ------------------------ | ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| github-pat               | github-token      | ✅ github-token        | —                                                                                                    |
| github-fine-grained-pat  | github-token      | ✅ github-token        | —                                                                                                    |
| slack-bot-token          | slack-token       | ✅ slack-token         | —                                                                                                    |
| slack-webhook-url        | slack-webhook     | ✅ high-entropy-secret | masked via a different kind (gitleaks' new `services/<43–56>` shape, no `T…/B…/` segments)           |
| npm-access-token         | npm-auth-token    | ✅ high-entropy-secret | masked via the high-entropy fallback rather than the labelled npm rule                               |
| huggingface-access-token | huggingface-token | ✅ huggingface-token   | —                                                                                                    |
| databricks-api-token     | databricks-token  | ✅ databricks-token    | —                                                                                                    |
| doppler-api-token        | doppler-token     | ✅ doppler-token       | —                                                                                                    |
| flyio-access-token       | flyio-token       | ✅ flyio-token         | —                                                                                                    |
| openai-api-key           | openai-key        | ✅ openai-key          | —                                                                                                    |
| aws-access-token         | aws-access-key-id | ❌ missed              | **gap**: first-branch `A3T` prefix; we cover `AKIA/ASIA/AROA/AIDA` but not `A3T/ABIA/ACCA`           |
| stripe-access-token      | stripe-key        | ❌ missed              | **gap**: gitleaks accepts `{10,99}`; our rule requires `{16,}` — a ≥16-char key masks                |
| planetscale-password     | planetscale-token | ❌ missed              | **gap**: `pscale_pw_` prefix (we model `pscale_tkn_/oauth_`); a long alnum pw masks via high-entropy |
| gitlab-pat               | gitlab-token      | ❌ missed              | **artifact**: synth tail ends in `-`; a `glpat-`+20-alnum instance masks as gitlab-token             |
| sendgrid-api-token       | sendgrid-key      | ❌ missed              | **artifact**: gitleaks' loose `SG.{66}` class; a real `SG.<22>.<43>` key masks as sendgrid-key       |
| jwt                      | jwt               | ❌ missed              | **artifact**: gitleaks' `ey`+alnum minimal instance; a real `eyJ…` JWT masks as jwt                  |
| private-key              | private-key       | ❌ missed              | **artifact**: gitleaks permits a missing space after `BEGIN`; a real PEM masks as private-key        |

**Triage (verified with realistic instances against the real redactor):** of the 7 misses, **4 are
synthesis-minimality/looseness artifacts** — gitlab, sendgrid, jwt, and private-key all mask once the
sample is a realistic secret rather than gitleaks' loosest legal string. **3 are genuine (narrow)
coverage gaps** worth noting: the AWS `A3T/ABIA/ACCA` key prefixes, the PlanetScale `pscale_pw_`
prefix (though a sufficiently long alphanumeric password is still caught by the high-entropy
fallback), and Stripe keys shorter than 16 characters.

**Fair-conditions disclosure.**

- **Different scope.** gitleaks is an **at-rest git-history scanner**; ActraDeck is a **streaming
  text redactor**. They overlap on inline token _shapes_ but not on operating model, so this is a
  shape-recall comparison on a mappable subset, not a like-for-like tool benchmark.
- **Mappable subset only.** gitleaks ships 170+ rules; the 17 above are the ones whose secret shape
  maps onto a kind we model. The rest (vendor-specific tokens we do not target) are **out of scope**
  and are not counted against recall — the claim is deliberately limited to "on the mappable
  subset, we mask this fraction of gitleaks' shapes."
- **Minimal-instance harshness.** The synthesized sample is the shortest legal instance, so misses
  driven by looseness in gitleaks' own regex (private-key without a space, `ey` without the `J`,
  Stripe below 16 chars) count against the raw number; the triage column separates these from real
  gaps. Misses are described by **rule name and shape only — never by value**.
- **Pinned point-in-time.** Numbers are for gitleaks v8.30.1 (of 221 rules parsed, 204 are outside
  our modelled kinds and 17 are mapped). gitleaks is feature-complete, so its ruleset changes
  rarely, but a different pin can shift the mapping. The step-by-step re-pin procedure (new SHA → 3
  checksums → MAPPING diff → re-measure) is documented in the `## Updating the pin` block at the top
  of `apps/sidecar/e2e/safety-bench/cross-eval.mts`.

## Honest limitations

- **Synthetic corpus.** These numbers characterize the detectors against curated vectors, not a
  representative sample of real-world traffic. 100% recall means "no vector in this corpus leaked,"
  not "no secret can ever leak."
- **Inline detection only.** Both the redactor and the `secret-egress` composite detect secrets
  present **inline** in the text/command. File-reference exfiltration (`curl --data @.env`,
  `scp .env host:`) carries no inline secret and is out of reach of pattern matching — the same
  limitation gitleaks-style tools share.
- **Known structural residuals — now measured, not just asserted.** A standalone base64 run longer
  than the bounded capture length, a JWT signature tail beyond the cap, or (as the fragment-survival
  section shows) the >4096-char tail of an over-long credential value can survive redaction. These
  are deliberate ReDoS/over-redaction trade-offs documented in the redactor source (`SEC-3`), not
  oversights. **Test coverage is partial, stated precisely:** the redaction package's
  `INV-REDACTION-*` straddle tests pin the **compensated** cases (the PEM/JWT bounded-fallback
  markers) and standalone runs only up to the ~88-char fixtures — the **>4096-char standalone
  residual is documented by the source note only, not test-pinned**. The benchmark now **measures**
  partial survival directly (fragment-survival metric, finding REDACT-F2) instead of only describing
  it — this is the upgrade R4 asked for. A full-secret recall of "100%" is scoped to full-substring
  survival on this corpus; it is not a claim that no fragment can ever leak.
- **Remainder-aware exclusion can hide a _true_ partial leak (false-negative direction).** The
  fragment metric ignores a surviving fragment that also appears in the input with the secret
  removed, to avoid alarming on coincidences with preserved benign text (the `discord-webhook`
  digit-run example). If a real secret fragment happened to coincide with preserved public text, it
  would be suppressed. This trades a false-positive risk for a false-negative one; it is the safe
  direction for a "does over-redaction destroy signal" benchmark, but it is a genuine limit. On the
  current corpus, zero true leaks are suppressed (every positive was checked by hand).
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
