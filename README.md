# Snitch

Local verification layer for AI coding agents.

Snitch installs into a coding session as a local companion for Codex, Cursor, Claude Code, OpenCode, and other agentic dev tools. Agent hooks feed it events in the background, Snitch keeps durable `.snitch/` state, and the visual/Markdown surfaces update from the same graph IR. The demo should feel like the codebase is becoming visible at machine speed while the agent is still working.

## Current MVP

This repo now includes a working first slice:

- background CLI: `pnpm snitch init`, `event`, `status`, and `finalize`
- generated hook adapter at `.snitch/hooks/codex-hook.mjs`
- generated Codex, Cursor, Claude Code, and OpenCode adapter configs with `--agent all`
- MCP stdio server: `pnpm --silent snitch mcp` exposes status, check, findings, next-action, impact, and repair-prompt tools to MCP-capable agents
- local Git hook installer: `pnpm snitch install-git-hooks`
- privacy-preserving local event log at `.snitch/events.jsonl`
- normalized event model with payload hashing and safe summaries
- narrow TypeScript extractor for real repo graph generation
- MCP-style tool extraction for `registerTool`, `server.tool`, and `tool(...)` definitions
- missing-companion warnings for any extracted tool that calls an external system, not only the demo tool
- target-aware hook refresh: file-changing events regenerate code-derived artifacts
- durable live timeline: hook and watcher refreshes append graph diff entries to `.snitch/timeline.jsonl`
- local live server: `pnpm snitch watch` serves `.snitch` artifacts and refreshes the graph from file changes
- local hook ingest endpoint: `POST /api/events?source=<agent>&hook=<hook>` records safe hook events while `snitch watch` runs
- low-latency dashboard updates over Server-Sent Events with polling fallback
- database graph extraction for common Prisma, Drizzle, and Supabase read/write calls
- graph scope controls for all, changed, and selected-warning impact views
- insights artifact: `pnpm snitch insights` writes Cerebras narration, warning ranking, repair prompts, and Backboard repo-rule status
- agent intervention packet: `pnpm snitch next-action` tells the coding agent the current grounded follow-up after hook capture
- paste-ready repair prompt: `pnpm snitch repair-prompt` prints the next agent fix from active warnings
- anchored review findings: `pnpm snitch findings` maps warnings to file/line evidence
- agent/reviewer impact lens: `pnpm snitch impact` prints the affected warning neighborhood as Markdown or JSON
- CI/local enforcement gate: `pnpm snitch check` exits nonzero when warnings meet a severity threshold
- finalize memory lane: `pnpm snitch finalize` writes Backboard warning-decision memory with hashed evidence only
- PR publish bridge: `pnpm snitch publish-github` posts or updates one top-level GitHub PR comment from `.snitch/pr-comment.md`
- dynamic PR and handoff summaries generated from the actual graph, not demo-only copy
- scripted repair pass: `pnpm demo:repair` adds the missing companion work and regenerates warning-free artifacts
- repeatable demo reset: `pnpm demo:reset` restores the unsafe agent-output state and regenerates warning artifacts
- one-command live demo runner: `pnpm demo:live`
- prepared demo assistant app under `apps/demo-app`
- deterministic graph IR, hashing, diffing, and last-good-graph behavior
- replayed issue-tool demo graph with missing companion warnings
- Mermaid, handoff, timeline, graph JSON, and PR-comment artifact generation
- Cerebras and Backboard integrations with graceful fallback behavior
- Vite/React dashboard using React Flow for the live graph surface

See [docs/strategy-2026-06-27.md](docs/strategy-2026-06-27.md) for the researched next build direction.

## Run It

```bash
pnpm install
pnpm demo:live
```

`pnpm demo:live` prepares code-derived artifacts, writes integration insights, starts `snitch watch` at `http://127.0.0.1:4767`, and starts the dashboard pointed at that local server. Plain `pnpm dev` stays in clean replay fallback mode. The first screen is the Snitch inspection surface: live graph, ranked warning rail, timeline, integration panel, and PR artifact preview.

Useful commands:

```bash
pnpm snitch init --agent all --target apps/demo-app --task "Watch this coding-agent session"
printf '{"tool_name":"apply_patch","file_path":"src/tools/create-issue.ts"}' | pnpm snitch event --source codex --hook PostToolUse
pnpm snitch analyze --target apps/demo-app --task "Add an external issue-creation tool"
pnpm snitch check --target apps/demo-app --task "Add an external issue-creation tool"
pnpm snitch check --target apps/demo-app --fail-on medium --json
pnpm snitch insights --offline
pnpm snitch insights
pnpm snitch next-action
pnpm snitch next-action --json
pnpm snitch repair-prompt
pnpm snitch repair-prompt --warning warning:permission_scope_missing:create_issue
pnpm snitch findings
pnpm snitch findings --json
pnpm snitch impact --warning warning:secret_redaction_missing:create_issue
pnpm snitch impact --warning warning:secret_redaction_missing:create_issue --json
pnpm --silent snitch mcp
pnpm snitch watch --target apps/demo-app --port 4767 --scan-interval 300
pnpm dev:live
pnpm demo:live --offline-integrations
pnpm demo:reset
pnpm demo:repair
pnpm snitch status
pnpm snitch status --json
pnpm snitch finalize
pnpm snitch install-git-hooks
pnpm snitch publish-github --repo owner/name --pr 123
pnpm test
pnpm build
pnpm verify:browser
pnpm demo:artifacts
pnpm demo:extract
pnpm smoke:cerebras
pnpm smoke:backboard
```

Local credentials live in `.env`; `.env.example` lists the supported keys. `CEREBRAS_MODEL` can be a public model ID such as `gpt-oss-120b` or an org dedicated endpoint ID when available.

## Background Agent Setup

Snitch follows the Flow Guardian pattern: small local config, durable handoff state, no GitHub write powers inside the agent loop.

After `pnpm snitch init --agent all`, Snitch writes:

- `.codex/hooks.json`
- `.cursor/rules/snitch.mdc`
- `.claude/settings.local.json`
- `.opencode/snitch-plugin.ts`
- `.snitch/hooks/codex-hook.mjs`

The generated hook command is:

```bash
node .snitch/hooks/codex-hook.mjs <hook-name>
```

When `snitch watch` is running, the generated adapter first tries to POST into the live server at `SNITCH_INGEST_URL` or `http://127.0.0.1:4767/api/events`. If the server is unavailable, it falls back to `pnpm snitch event`. Set `SNITCH_DISABLE_HTTP=1` to force CLI-only capture.

The generated adapter calls back into this Snitch checkout and records:

- source and hook name
- payload hash and byte count
- safe event summary keys such as tool name, file path, command hash/byte count, status, or exit code

It does not store the raw hook payload. File-changing events refresh the configured TypeScript target and regenerate:

- `.snitch/graph.json`
- `.snitch/warnings.json`
- `.snitch/findings.json`
- `.snitch/next-action.md`
- `.snitch/timeline.jsonl`
- `.snitch/mermaid.mmd`
- `.snitch/handoff.md`
- `.snitch/pr-comment.md`
- `.snitch/insights.json`

`snitch finalize` also writes `.snitch/memory.json`. With Backboard credentials, it remembers active warning decisions as safe metadata and evidence hashes; without credentials, it records disabled status so the live dashboard can show the memory lane honestly.

`snitch next-action` is the hook-to-agent intervention path. It reads the active findings and safe hook event summaries, then returns the highest-priority grounded follow-up with file/line evidence, likely related agent events, and next commands. Use `--json` for MCP clients, hooks, and agent automation.

`snitch repair-prompt` is the coding-agent handoff path. It reads the active warning set and prints a paste-ready prompt for the next fix. If `.snitch/insights.json` contains Cerebras warning ranks, Snitch uses that ordering; otherwise it falls back to deterministic severity ordering. Use `--warning <id>` to pin a warning or `--all` to print every active repair prompt.

`snitch findings` is the reviewer evidence path. It turns active graph warnings into anchored findings with file, line, warning id, evidence, and repair command. Use `--json` for agents, CI, or future PR publishers.

`snitch impact` is the local impact lens for agents and reviewers. It scopes the graph around a warning, prints the affected files, nodes, edges, and repair command, and supports `--json` so coding agents can consume it directly. Without `--warning`, it uses the highest-severity active warning.

`snitch mcp` starts a newline-delimited JSON-RPC MCP stdio server for MCP-capable coding environments. It exposes `snitch_status`, `snitch_check`, `snitch_findings`, `snitch_next_action`, `snitch_impact`, and `snitch_repair_prompt`, each backed by the same local `.snitch` artifacts as the CLI. The server writes only MCP messages to stdout; when launching through this repo's package script, use `pnpm --silent snitch mcp` so the package runner does not print its command first.

`snitch check` is the enforcement path. It runs the TypeScript extractor, updates `.snitch` artifacts, and exits with code `1` when warnings meet or exceed `--fail-on` (`high` by default). Use `--json` for CI consumers and follow failures with `pnpm snitch repair-prompt --warning <id>`.

`snitch install-git-hooks` installs Snitch-managed `post-commit` and `pre-push` hooks. They refresh local `.snitch` artifacts from the repo graph and intentionally do not publish to GitHub. Existing non-Snitch hooks are left alone unless `--force` is passed.

`snitch publish-github` is the PR publish plane. It reads `.snitch/pr-comment.md`, wraps it with a stable hidden marker, and creates or updates one top-level PR timeline comment through the GitHub issue comments API. It is intended for GitHub Actions or a future GitHub App, not for the coding agent runtime. See [templates/github/snitch-pr-summary.yml](templates/github/snitch-pr-summary.yml).

`pnpm snitch watch` exposes:

- `GET /health`
- `GET /api/state`
- `GET /api/events` for Server-Sent Events
- `POST /api/events?source=<agent>&hook=<hook>` for local hook ingestion

The dashboard listens to `/api/events` for low-latency state updates and falls back to polling `/api/state` when EventSource is unavailable. By default, `snitch watch` also polls the configured TypeScript target and regenerates `.snitch/graph.json`, `.snitch/warnings.json`, `.snitch/findings.json`, `.snitch/next-action.md`, `.snitch/mermaid.mmd`, and `.snitch/pr-comment.md` when code files change. Use `--target <repo>` to override the stored analysis target, `--scan-interval <ms>` to tune refresh speed, or `--no-files` to serve artifacts without file watching.

`/api/state` includes the latest graph, warnings, publishable artifacts, integration status, and the last 50 normalized hook events. The event trace is safe for UI rendering because it contains hashes, byte counts, safe summary keys, and file evidence rather than raw payloads.

The hook ingest endpoint accepts the raw hook payload body but stores only the normalized Snitch event: source, hook, payload hash, byte count, safe summary keys, and file evidence. It uses the same refresh path as `pnpm snitch event`.

`pnpm demo:repair` is the stage-two demo move: it patches `apps/demo-app` with the audit log, secret redactor, scoped permission contract, and unauthorized-call test, then regenerates `.snitch` artifacts. After a live dashboard is running, this is the moment where the warning rail collapses to "No active Snitch warnings."

For code-derived artifacts, run:

```bash
pnpm snitch analyze --target apps/demo-app --task "Add an external issue-creation tool"
```

`snitch analyze` is also useful as a one-shot artifact refresh; it persists the target so later hook events can keep using it. If the target cannot be extracted yet, Snitch keeps the last valid graph and can fall back to the replay sequence. The current extractor recognizes the demo assistant router, tool registry, `create_issue` tool, input schema, provider `fetch`, provider credential, and missing audit/redaction/permission/test companions.

## Demo Thesis

The wow is not "AI generated docs." The wow is:

> The agent changes code on the left, and the system map changes on the right before a human could read the diff.

The fastest path to a strong demo is a split screen:

- Left: a real coding agent editing a prepared TypeScript app.
- Background: Snitch hook adapter capturing the agent's session events.
- Right: Snitch showing the live API/tool/data-flow graph, a fast narration ticker, and generated Mermaid/HTML diagrams.

The room should watch nodes and edges appear as the agent works: endpoint, schema, tool, env var, external API, database write, test, missing companion. The final diff is secondary. The live morphing graph is the product.

## Positioning

Snitch is a developer tool for people building with AI coding agents. It should feel first class next to Codex, Cursor, Claude Code, OpenCode, and whatever local agent runtime a team already uses.

Task sources can be:

- plain prompt
- GitHub issue
- Linear ticket
- README/spec file
- 8090 Software Factory Work Order
- any MCP resource that describes intended work

8090 is an optional rich task-source adapter. The core product is local-first and agent-agnostic.

## Provider Integrations

Use providers where they make the developer loop visibly better.

### Cerebras

Cerebras should be load-bearing for speed:

- turn graph diffs into instant human narration
- generate/update Mermaid summaries quickly
- rank what changed as important
- infer missing companion pieces from the task and graph
- generate repair prompts from warnings

The deterministic parser owns truth. Cerebras owns speed-of-meaning.

### Backboard

Backboard is optional but useful if time allows:

- remember repo conventions and accepted architecture rules
- remember false positives
- store session handoff state
- make warnings repo-aware instead of generic

Example: "This repo requires audit logging for external tools" is stronger than "tools often need audit logging."

### 8090 Software Factory

8090 should be an adapter, not the identity:

- import a Work Order as a task source
- read linked requirements/blueprints when available
- export Snitch's evidence as a work-order handoff or status note

The pitch: "If your team uses Software Factory, Snitch can use its Work Orders as richer intent. If not, paste a prompt or GitHub issue."

### Docker

Docker is useful for demo reliability:

- reproducible demo app
- predictable agent sandbox
- one-command local run

It is not the product hook.

## Primary Demo Scenario

Use an AI-builder-native task, not a generic payment demo.

Task:

> Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.

Expected live graph:

```mermaid
flowchart LR
  AgentRouter --> ToolRegistry
  ToolRegistry --> IssueTool
  IssueTool --> IssueProviderAPI
  IssueTool --> EnvIssueProviderKey["env:ISSUE_PROVIDER_API_KEY"]
```

Expected contract rail:

- Tool registry created
- Issue tool registered
- Provider credential referenced
- Secret redaction present
- Tool calls audit logged
- Tool access scoped per task/session
- Unauthorized tool-call test exists

Killer demo beat:

> The agent says the tool is done. Snitch shows the system gained a broad external capability, but no audit trail, no secret redaction, and no per-task permission boundary.

Clicking a warning should produce a repair prompt the user can send back to the coding agent.

## Visual Surfaces

Build two visual surfaces with different jobs.

### 1. Live HTML Graph

This is the stage wow.

- stable animated graph
- nodes and edges move without layout thrash
- new nodes scale/fade in
- new edges draw on
- important changes glow briefly
- graph never blanks when code is temporarily unparseable

Use this for the live agent demo.

### 2. Mermaid / Fast Docs

This is the shareable artifact.

- regenerated Mermaid diagrams from the same graph IR
- copyable `.mmd` output
- HTML preview pane for docs
- useful for handoff, README updates, PR comments, and 8090/Backboard exports

Do not rely on Mermaid as the primary live animation surface unless research proves it can update smoothly without full re-layout flicker.

## Architecture

```mermaid
flowchart LR
  Agent["Coding agent or replay script"] --> Repo["Repo files"]
  Repo --> Watcher["File watcher"]
  Watcher --> Extractor["TS extractor"]
  Extractor --> IR["Stable graph IR"]
  IR --> Diff["Graph diff engine"]
  Diff --> HtmlGraph["Live HTML graph"]
  Diff --> Mermaid["Mermaid exporter"]
  Diff --> Cerebras["Cerebras semantic loop"]
  Cerebras --> Ticker["Narration ticker"]
  Cerebras --> Warnings["Missing companion warnings"]
  Warnings --> Repair["Repair prompts"]
  Warnings --> Handoff["Handoff/export"]
```

Core rule: the parser and graph IR are the source of truth. LLM output can label, summarize, rank, and infer gaps, but it should not invent the graph.

## Graph IR

Everything should pass through one stable, diffable intermediate representation.

```ts
type GraphNodeKind =
  | "endpoint"
  | "schema"
  | "service"
  | "tool"
  | "env"
  | "external"
  | "database"
  | "test"
  | "contract";

type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  file?: string;
  line?: number;
  meta?: Record<string, unknown>;
  hash: string;
};

type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "calls" | "validates" | "reads" | "writes" | "uses_secret" | "covers" | "satisfies" | "violates";
  hash: string;
};
```

Stable IDs are non-negotiable:

- endpoint: `endpoint:POST:/api/issues`
- tool: `tool:IssueCreationTool`
- env: `env:ISSUE_PROVIDER_API_KEY`
- external: `external:issue-provider`
- schema: `schema:CreateIssueInput`

Never ID by array index, screen position, or line number.

## First Build Order

Build the wow first, then make it real.

1. Hardcoded before/after graph IRs.
2. Diff engine with stable node IDs.
3. Live HTML graph that animates only deltas.
4. Mermaid exporter from graph IR.
5. Replay script that applies prepared file changes every few seconds.
6. File watcher wired to graph updates.
7. Narrow TypeScript extractor for the prepared demo app.
8. Cerebras narration and missing-companion loop.
9. Real coding agent run on the same task.
10. Hot fallback: replay script that looks identical to the real run.
11. Optional adapters: 8090 task import, Backboard memory, Dockerized demo.

The real agent is impressive, but the replay path protects the stage demo.

## Latency Targets

These are demo targets, not production promises.

- file change to graph update: under 300 ms when extraction succeeds
- file change to Mermaid refresh: under 1000 ms
- graph diff to narration: under 1000 ms
- no full graph blanking on parse errors
- no global graph re-layout on every update

If narration lags, render the graph immediately and let text catch up.

## Repo Shape To Build Toward

```text
apps/
  web/                 # Snitch dashboard
  demo-app/            # Prepared TS app the agent mutates
packages/
  graph/               # Graph IR, hashing, diffing
  extractor-ts/        # TS/Next/Zod/MCP-tool extraction
  watcher/             # chokidar + event pipeline
  cerebras/            # fast semantic calls
  mermaid/             # graph IR -> Mermaid
  replay/              # scripted demo edits
demos/
  mcp-tool-access/     # patches, prompts, expected beats
docs/
  research.md          # stack decisions and source notes
  hooks.md             # hook layers for live capture and PR publishing
```

Do not scaffold all of this before the first latency spike. This is the target shape, not step one.

## Research Queue

Research only the decisions that affect the first build.

1. Live graph rendering:
   - React Flow with controlled positions
   - custom SVG + ELK
   - D3 force with pinned existing nodes
2. Mermaid rendering:
   - Mermaid browser API
   - Mermaid CLI
   - whether incremental visual updates are realistic
3. TypeScript extraction:
   - `ts-morph`
   - raw TypeScript language service
   - `tree-sitter-typescript`
4. Watch pipeline:
   - `chokidar`
   - SSE vs WebSocket
   - debounce strategy for agent file storms
5. Agent demo input:
   - Codex / Cursor / Claude Code / OpenCode local run
   - scripted patch replay fallback
6. Provider integrations:
   - Cerebras structured JSON response API shape
   - Backboard memory/R-CLI role
   - 8090 MCP work-order import/export shape
7. Hook integrations:
   - agent-runtime hooks for live capture
   - GitHub `pull_request` workflow for PR artifact publishing
   - local `.snitch/` state inspired by Flow Guardian handoff files

## Next Build Targets

1. Add a real file watcher and `snitchd` event stream.
2. Add a narrow TypeScript extractor for the prepared demo app.
3. Wire one agent runtime hook path.
4. Add a GitHub Action template that posts `.snitch/pr-comment.md`.
