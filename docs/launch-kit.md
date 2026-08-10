# ActraDeck launch kit

Copy for the first public distribution push. Keep the product claim narrow and let the demo do
the selling.

## Claims that must stay true

- Approval relay works for Claude Code in Attach Mode and Codex in Managed Mode.
- Codex Attach is observe-only; its native approvals remain in the Codex TUI.
- Risk classification and secret redaction are best-effort detection, not a sandbox.
- The five-second `npx actradeck demo` is synthetic and side-effect-free.
- The cockpit's 30-second demo exercises the real ingestion, approval-card, redaction, storage,
  and replay path, but never launches its synthetic destructive command.

## Show HN

Read the current [Show HN guidelines](https://news.ycombinator.com/showhn.html) before posting.
The project is runnable without signup, so link to the repository rather than a signup or launch
page. Do not ask anyone to upvote. HN may restrict Show HN posting for accounts that are not yet
established in the community.

**Title**

```text
Show HN: ActraDeck – Put risky coding-agent actions back in front of a human
```

**Submission URL**

```text
https://github.com/actradeck/actradeck
```

**First comment**

```text
I built ActraDeck because I wanted a separate, local place to review risky coding-agent actions
and keep the decision afterward—not another chat transcript tied to one vendor.

The narrow first job is an approval floor for detected dangerous actions. From the same event
stream it also redacts recognized secrets before ActraDeck persistence and keeps a replayable audit
trail across Claude Code and Codex.

You can see the interaction without installing the product:

    npx actradeck@latest demo

For the real cockpit pipeline:

    docker run --rm -p 127.0.0.1:55400:55400 \
      -v actradeck_pgdata:/data ghcr.io/actradeck/actradeck:latest

Then open http://localhost:55400 and run the 30-second safety demo. The destructive command is
synthetic and never executes, but the ingestion, approval card, redaction, storage, and replay
paths are real.

Important limits: Codex Attach is observe-only; approval relay for Codex requires Managed Mode.
Classification/redaction are best-effort and ActraDeck is not a shell sandbox. The default threat
model is one operator on a local machine.

I would especially value feedback on the entry point: would you first adopt this for one dangerous
action class, for cross-agent audit/replay, or not at all? What would stop you from trying it?
```

## Reddit / developer community post

Check each community's current self-promotion rules and use only the version relevant to that
community. Do not paste identical posts across several communities at once.

**Title**

```text
I built a local-first approval and audit cockpit for Claude Code and Codex
```

**Body**

```text
I kept finding that the moment I used a coding agent in a permissive mode, the useful question was
not “what features does the agent have?” but “which dangerous action is about to disappear into a
terminal prompt?”

ActraDeck puts detected risky actions into a local approval inbox where the agent mode supports
relay, redacts recognized secrets before ActraDeck stores observed events, and keeps a replayable
history across Claude Code and Codex.

The quickest preview is side-effect-free:

    npx actradeck@latest demo

Repo: https://github.com/actradeck/actradeck

Honest boundaries: Claude Code Attach and Codex Managed can relay approvals; Codex Attach is
observe-only. Detection is best-effort, not a sandbox. It is pre-1.0 and designed for a single
local operator today.

If you use permissive/YOLO agent modes, which action would you insist on holding for a human every
time? I am using that answer to keep the default policy small instead of turning every command into
another prompt.
```

## Short social posts

**Primary**

```text
Coding agents move fast. Destructive approvals should not disappear just as fast.

ActraDeck is a local-first approval + audit cockpit for Claude Code and Codex.

Try the side-effect-free preview:
npx actradeck@latest demo

https://github.com/actradeck/actradeck
```

**Technical**

```text
ActraDeck now default-gates inline code in YOLO mode and catches shell escapes, BusyBox/Toybox
applets, Git global options, Git shell aliases, and dynamic executables. Reproducible classifier
bench: 53 vectors, 100% default-gate recall.

https://github.com/actradeck/actradeck
```

## GitHub release summary for v0.7.0

```markdown
ActraDeck v0.7.0 makes the first-run value visible and hardens the boundaries behind it.

- Try `npx actradeck@latest demo` for a synthetic, side-effect-free preview.
- README and npm metadata now lead with the approval outcome instead of architecture terms.
- WebSocket browser upgrades enforce same-origin before the connection is accepted.
- YOLO policy gating closes shell-escape, multi-call binary, Git option/alias, inline-code, and
  dynamic-executable bypasses.
- Valid approval hooks fail closed on internal errors instead of returning a no-op response.
- The public classifier corpus now includes 53 canonical and adversarial vectors; default-gate
  recall is 100% on that committed corpus.

Breaking pre-1.0 changes: audit manifest v3 and audit review-packet manifest v2. See the changelog
for migration and verification details.
```

## Launch checklist

1. Run `scripts/version.sh 0.7.0`, review and commit the bump, then run
   `scripts/version.sh 0.7.0 --tag-only` and push the verified tag to cut the signed release.
2. Confirm `npx actradeck@latest demo` reports `0.7.0` after npm publication.
3. Upload `docs/assets/github-social-preview.png` in GitHub **Settings → General → Social preview**.
4. Open the Docker demo from a clean machine or VM and complete the 30-second flow.
5. Post one primary launch, stay available for technical questions, and answer limitations directly.
6. Measure demo runs, verified installs, Docker starts, protected sessions, and returning users;
   treat stars as acquisition signal, not the product outcome.
