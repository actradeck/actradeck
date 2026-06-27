# 90-second demo runbook

A tight script to record a ~90s demo that shows ActraDeck's wedge (ADR 0001):
**cross-vendor governance + secrets + audit in one place** — the thing a
single-vendor dashboard does not do.

What the viewer should walk away believing:

1. One cockpit shows **both** a Claude Code and a Codex session at once.
2. You **approve/deny from one inbox** — relayed for Claude Code over Attach (the
   default). Codex over Attach is **observed** in the same inbox/list; relaying
   Codex approvals needs **Managed Mode**.
3. A secret is **redacted before it is ever stored** — you see the masked value and
   a per-kind count, never the secret.
4. There is **one audit trail / replay** spanning both agents.

> ⚠️ Use **synthetic secrets only** (the values below are public dummies). Never put
> a real key in a recording. Dry-run once and adjust UI labels — the exact wording
> of buttons/panels may differ from your build; the `data-testid`s are stable.

---

## Prerequisites (one-time, off camera)

```bash
# Cockpit (backend :55410 + web UI :55400). Needs Postgres; see .env.example.
./scripts/actradeck up
./scripts/actradeck doctor      # confirm :55410 and :55400 are LISTENing

# Attach daemons for Claude Code + Codex.
./scripts/ad-attach install-all
./scripts/ad-attach status-all  # confirm both active
```

- A throwaway git repo to act in: `mkdir -p /tmp/ad-demo && git -C /tmp/ad-demo init`.
- Cockpit open at **http://localhost:55400**, on the live session list.
- Two terminals ready: one for `claude`, one for `codex`, both `cd /tmp/ad-demo`.

Synthetic secrets to use on camera (public, non-functional dummies):

- AWS access key id: `AKIAIOSFODNN7EXAMPLE` (AWS's own documentation example)
- GitHub-token-shaped dummy: `ghp_0000000000000000000000000000000000DEMO`

> Approvals: Claude Code approval interception works over **Attach** (hooks). Codex
> approval **interception** is most reliable in **Managed Mode** (App Server); over
> Attach, Codex is observed. If you want a live Codex _approval_ on camera, launch
> Codex managed; otherwise show the Codex session **observed** in the same inbox/list
> and do the live approve/deny on the Claude Code card. Verify which your build does
> before recording.

---

## The script (≈90s)

### 0:00–0:12 — One pane, two vendors

- Say the line: _"ActraDeck is the vendor-neutral control plane for coding-agent
  approvals, secrets, and audit."_
- In the two terminals, start `claude` and `codex` (both in `/tmp/ad-demo`) and give
  each a small task.
- Cut to the cockpit: **both sessions appear in the live list** — one tagged Claude
  Code, one Codex — each showing state + current action. Point at the agent-type
  column.

### 0:12–0:40 — Approve/deny from one inbox (Codex observed over Attach)

- Drive the Claude Code session to a gated action, e.g. ask it to run a destructive-
  looking command so a **PreToolUse / PermissionRequest** card fires:
  ```
  rm -rf /tmp/ad-demo/build
  ```
- In the cockpit's **Approval Inbox**, the pending card appears (data-testid
  `approval-allow` / `approval-deny`). Show the Codex session's activity in the same
  view.
- Click **Deny** on the destructive card (`approval-deny`) → the agent is refused.
- Trigger a second, benign gated action and click **Allow** (`approval-allow`) →
  it proceeds. The point: _one inbox, decisions enforced, across agents._

### 0:40–1:05 — A secret is blocked before it hits disk

- In the Claude Code session, run a command whose text contains a synthetic secret:
  ```
  echo "deploying with AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE and token ghp_0000000000000000000000000000000000DEMO"
  ```
- In the cockpit, open that command/event. Show that the stored value reads
  `AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key-id]` and
  `[REDACTED:github-token]`, and that the **per-kind redaction count** badge
  (e.g. `aws-access-key-id ×1 · github-token ×1`) is shown.
- Say: _"The secret never reached the database — redaction runs before persist."_
  (Optionally show the local log / DB has only the masked form.)

### 1:05–1:25 — One audit trail, replay both

- Let a session finish (or open one already completed).
- Open **Session Replay / Audit** and scrub the timeline: prompts, tool calls,
  command + exit code, file diffs, approval decisions, redaction badges — all in
  order. If both vendors are in scope, show that the trail spans Claude Code **and**
  Codex events in the same model.

### 1:25–1:30 — Close

- Land the line: _"Cross-vendor observation, secrets, and audit — with approval
  relay for Claude Code today (Codex via Managed Mode) — local-first, open-source
  (Apache-2.0)."_

---

## Tips

- Pre-create the throwaway repo and pre-type the commands so the 90s is tight.
- If a card does not appear, confirm the action is actually gated (the risk
  classifier treats `rm -rf` as high; benign reads are not gated by design).
- Keep the cockpit zoom large enough that the `[REDACTED:…]` text and the redaction
  count badge are legible.
- Record a 30s "secrets-only" cut and a 30s "cross-vendor inbox" cut too — they are
  the two most differentiating moments and work well standalone.
