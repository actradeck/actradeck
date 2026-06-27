<!--
Thanks for contributing to ActraDeck! Please fill in the sections below.
Keep PRs focused (roughly <= 800 lines of diff) and split unrelated changes.
-->

## Summary

<!-- What does this change do, and why? Link any related issue (e.g. Closes #123). -->

## Testing

<!-- Which commands did you run? Paste relevant results. -->

- [ ] `pnpm type-check`
- [ ] `pnpm lint`
- [ ] `pnpm format` (or `pnpm format:fix`)
- [ ] `pnpm test`
- [ ] `pnpm build`

## Security & redaction

<!-- ActraDeck redacts secrets before anything is persisted/sent, and gates
     high-risk operations behind approval. Confirm the points that apply. -->

- [ ] No real secrets are included anywhere (code, tests, fixtures, screenshots) — only synthetic dummies.
- [ ] If this touches redaction / approval / event ordering / liveness, the relevant invariant tests (`INV-*`) are added or kept passing.
- [ ] I did **not** weaken a security/invariant test (e.g. relax a threshold) without a written rationale showing the test still catches the regression it targets.
- [ ] This PR contains **no** security-vulnerability disclosure (those go through [`SECURITY.md`](../SECURITY.md), not a public PR/issue).

## Docs & support matrix

- [ ] If this changes what a vendor/mode supports (observe / redaction / audit / approval relay), I updated the [support matrix](../README.md#vendor--mode-support).
- [ ] Public claims still match the **default (Attach) mode** behavior.
- [ ] User-facing docs (`README.md`, `docs/`) updated if behavior changed.
