# Hook Strategy

Date: 2026-06-26

Snitch should use hooks as event boundaries. It should not require a GitHub MCP tool just to publish a graph to a pull request.

## Core Take

Use the right hook for the right moment:

- Agent-runtime hooks capture what the agent is doing live.
- Local Git hooks capture durable snapshots around commit/push.
- GitHub pull request hooks publish artifacts once a PR exists.

This keeps the coding agent focused on code changes. Publishing Snitch output to GitHub can happen after the PR event, outside the agent loop.

## Flow Guardian Pattern

The local Flow Guardian setup inspected in `marshmallow` is lightweight:

- `.flow-guardian/config.yaml` stores local behavior such as `auto_inject`, `include_files`, and TLDR depth.
- `.flow-guardian/handoff.yaml` stores durable session state: goal, status, current work, files, branch, session id, timestamp.

That maps well to Snitch:

- `.snitch/session.json` for live run state
- `.snitch/graph.json` for latest graph IR
- `.snitch/timeline.jsonl` for graph diffs over time
- `.snitch/handoff.md` for final summary
- `.snitch/pr-comment.md` for the PR artifact body

Flow Guardian's useful idea is durable local state, not GitHub access.

## Hook Layers

### 1. Agent Runtime Hooks

Purpose: live capture.

Examples:

- `SessionStart`: initialize a Snitch run and load prior graph/session state.
- `UserPromptSubmit`: capture the task prompt as intent.
- `PreToolUse`: optionally inspect dangerous tool calls.
- `PostToolUse`: capture file edits, shell commands, and tool results.
- `Stop`: flush final graph, timeline, handoff, and warnings.

This is how Snitch gets close to the agent's actual behavior without depending only on filesystem polling.

### 2. File Watcher

Purpose: universal fallback.

Even if an agent does not support hooks, Snitch can still watch the repo:

- `chokidar` observes file changes.
- extractor derives graph IR.
- graph diff engine emits deltas.
- UI updates live.

Hooks improve fidelity. Watchers preserve universality.

### 3. Local Git Hooks

Purpose: durable local checkpoints.

Possible hooks:

- `post-commit`: snapshot graph and timeline after each commit.
- `pre-push`: generate `.snitch/pr-comment.md` and fail only on severe local issues if configured.
- `post-merge`: refresh base graph after pulling main.

Do not rely on local Git hooks for PR publishing. Git does not know when a GitHub PR has been created unless the user uses a wrapped command.

### 4. GitHub Actions / Webhooks

Purpose: publish and update PR artifacts.

Use GitHub's `pull_request` event:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

The workflow can:

1. check out the PR branch
2. run `snitch analyze --base origin/main --head HEAD`
3. generate Mermaid/HTML/Markdown artifacts
4. upload artifacts
5. create or update a PR timeline comment

For a normal PR timeline comment, GitHub uses the issue comments API because every pull request is also an issue:

```text
POST /repos/{owner}/{repo}/issues/{issue_number}/comments
```

Use review comments only for specific changed lines. Snitch's first artifact should be a single timeline comment.

## Recommended Prototype Path

For the hackathon, build hooks in this order:

1. File watcher + replay script: proves universal live graph.
2. `.snitch/` local state: stores graph, timeline, handoff, PR comment.
3. Agent hook adapter: optional, captures tool-level events when available.
4. GitHub Action template: runs on `pull_request` and posts the generated Markdown/Mermaid summary.

Do not add GitHub MCP to the core demo. If GitHub is involved, make it a publish hook.

## Sources

- Git hooks docs: https://git-scm.org/docs/githooks
- GitHub Actions PR events: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- GitHub webhook payloads: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- GitHub issue comments API: https://docs.github.com/rest/issues/comments
- Claude Code hooks: https://code.claude.com/docs/en/hooks
