# Snitch PRD

Date: 2026-06-27
Status: Draft ready for implementation planning

## Problem Statement

AI coding agents can modify a codebase faster than a developer can understand the resulting system change. The final diff shows changed text, but it does not clearly show what the system became: which routes appeared, which schemas are now used, which tools or external APIs were introduced, which tests are missing, which conventions were bypassed, or where the implementation drifted from the task intent.

Current tools cluster around adjacent surfaces:

- visual surfaces where agents publish diagrams or HTML
- plan boards that show what agents intend to do
- code maps that show static repo structure
- PR reviewers that comment after the work is done

Snitch should own the missing layer: live trust and drift detection for agent-written code. It should make the invisible system change visible while the agent is still working, then produce a durable review artifact when the work becomes a PR.

Research supports the pain:

- Stack Overflow's 2025 developer survey reports high AI adoption but low trust, with 66% frustrated by "almost right" AI output and 45% saying debugging AI-generated code is more time-consuming.
- Sonar's 2026 State of Code survey reports a verification bottleneck, with AI-assisted code representing a large share of committed code and 96% of developers not fully trusting AI-generated code.
- GitLab's 2026 AI Accountability research reports that organizations are generating AI code faster than they can govern it, and that review/validation has become the bottleneck.
- New Relic's 2026 State of AI Coding report frames AI code as a production reliability and observability problem, not merely a code review problem.

## Solution

Snitch is a local-first live visual truth layer for AI coding agents.

It watches a repository while an agent edits code, captures agent activity when hooks are available, derives a stable system graph from the actual code, and renders system changes immediately as:

- a live HTML graph
- a graph diff timeline
- a contract or intent rail
- Mermaid / Markdown / PR artifacts
- fast natural-language narration and repair prompts

The core experience is a split screen:

- left: the coding agent changing code
- right: Snitch showing the system map update before a human could read the diff

The product must remain universal. Snitch should work from a plain prompt, local spec, GitHub issue, Linear ticket, 8090 Work Order, or any MCP resource that describes intended work. 8090 Software Factory is an optional rich task-source adapter, not the product identity.

The hackathon build should feel like something you add to the coding agent's background loop, not a dashboard the user has to babysit. The local CLI and hook adapter are therefore part of the product surface:

- `snitch init` creates `.snitch/config.json`, `.snitch/session.json`, `.snitch/events.jsonl`, and a hook adapter.
- `snitch event` records hook events without storing raw payloads and regenerates graph artifacts.
- `snitch status` lets the user check whether the background companion is alive.
- `snitch finalize` writes the handoff and PR-ready Markdown.

The architecture has two separate planes:

1. Local capture plane:
   - local file watcher
   - optional agent hooks/plugins
   - deterministic TypeScript extractor
   - stable graph IR
   - live UI and `.snitch/` artifacts

2. Publish plane:
   - GitHub Action or GitHub App receives PR events
   - Snitch publishes generated review artifacts to PRs
   - agents do not need GitHub write powers

## User Stories

1. As a developer using an AI coding agent, I want to see the system graph update live while the agent edits files, so that I can understand impact before reading the full diff.

2. As a developer, I want the graph to be derived from code instead of invented by the agent, so that I can trust it as an evidence surface.

3. As a developer, I want new routes, tools, schemas, env vars, external services, database writes, and tests to appear as distinct graph nodes, so that I can quickly see what capability was added.

4. As a developer, I want changed nodes and edges to animate without the whole graph reshuffling, so that the visual does not become noise.

5. As a developer, I want the graph to stay visible when the agent temporarily leaves code in a broken parse state, so that the demo and workflow do not collapse mid-edit.

6. As a developer, I want a timeline of graph diffs, so that I can replay how the system changed during an agent run.

7. As a developer, I want Snitch to compare task intent against code reality, so that I can see where the implementation is incomplete.

8. As a developer, I want missing companion warnings, so that Snitch catches incomplete capabilities such as external tool access without audit logging, redaction, scoping, or tests.

9. As a developer, I want to click a warning and get a repair prompt, so that I can send the agent a precise follow-up instead of writing a vague correction.

10. As a developer, I want a fast narration ticker, so that the system explains important changes while the graph moves.

11. As a developer, I want Mermaid output generated from the same graph IR, so that I can paste or publish diagrams in docs and PR comments.

12. As a developer, I want a PR-ready Markdown summary, so that reviewers get a compact explanation of what the agent changed.

13. As a reviewer, I want Snitch to summarize structural impact, so that I can prioritize review attention across a large agent-generated diff.

14. As a reviewer, I want to know which warnings are backed by direct code evidence, so that I can trust the review artifact.

15. As a reviewer, I want generated artifacts keyed by commit SHA, so that the graph and warnings correspond to the exact code under review.

16. As a reviewer, I want Snitch to post one top-level PR comment before inline findings, so that the first integration is useful without solving diff-position complexity.

17. As a team lead, I want Snitch to avoid giving the coding agent GitHub write access, so that the agent can observe and analyze without mutating PR state.

18. As a team lead, I want a separate publish workflow or GitHub App, so that PR artifacts are posted by a narrow, auditable integration.

19. As a team lead, I want optional GitHub Action support, so that Snitch can run in ordinary repositories without a hosted SaaS dependency.

20. As a user of Claude Code, I want Snitch to use Claude hooks when available, so that live capture includes prompt, tool, and stop events.

21. As a user of Codex, I want Snitch to use command hooks or local session events when available, so that live capture works without unsupported hook handler types.

22. As a user of OpenCode, I want Snitch to use plugin or SSE events, so that live capture can include tool, file, session, and permission activity.

23. As a user of any other agent, I want Snitch to still work from file watching alone, so that the product remains agent-agnostic.

24. As a user of 8090 Software Factory, I want Snitch to import a Work Order as task intent, so that rich requirements and blueprint context can drive contract checks.

25. As a user who does not use 8090, I want to paste a prompt or point Snitch at a local spec, so that the product still works.

26. As a user of Backboard, I want Snitch to remember repo conventions and false positives, so that repeated warnings become more repo-aware over time.

27. As a hackathon judge, I want to see code changes and visual graph changes happen at machine speed, so that the demo has an immediate wow moment.

28. As a demo presenter, I want a replay fallback that produces the same graph sequence as the real agent run, so that the demo does not fail if the agent stalls.

29. As a developer building Snitch, I want clear graph IR and event schemas, so that extractor, renderer, LLM, and publisher modules can be tested independently.

30. As a maintainer, I want sponsor integrations to be optional except Cerebras, so that the MVP stays universal and shippable.

## Implementation Decisions

### Product Positioning

Snitch is not a general visual surface, not a plan board, not a static code map, and not a generic AI PR reviewer.

Snitch is a live trust layer for agent-written code:

- graph = what exists now
- intent/contract = what should exist
- warnings = gaps between reality and intent
- PR artifact = durable evidence for review

The live visual graph is the demo hook. The deeper product is drift detection and intervention.

### MVP Scope

The hackathon MVP must prove five things:

1. Snitch can animate a live system graph from graph diffs.
2. Snitch can generate Mermaid and Markdown artifacts from the same graph IR.
3. Snitch can replay a prepared agent-like edit sequence.
4. Snitch can derive graph nodes from a prepared TypeScript demo app.
5. Snitch can use Cerebras to produce fast narration, missing-companion warnings, and repair prompts.

The MVP may use a prepared demo app and replay script before a real live agent run. A real agent run should be attempted only after the visual/replay path is reliable.

### Demo Scenario

Use an AI-builder-native capability, not a generic payment checkout flow.

Recommended demo task:

> Add an external issue-creation tool to this coding assistant. It should accept a prompt, validate the input, call the issue provider, and expose it through the assistant's tool registry.

The demo can use GitHub as the recognizable external service, but it should be mocked or use existing local auth. It should not require giving the agent a new GitHub token.

Expected graph nodes:

- agent/router
- tool registry
- issue creation tool
- input schema
- provider client or external API
- env var if present
- audit log
- secret redactor
- permission scope
- unauthorized-call test

Expected missing warnings before repair:

- no audit trail for external tool calls
- no secret redaction around external tool input/output
- no per-task or per-session permission boundary
- no unauthorized-call test

Killer demo line:

> The agent says the tool is done. Snitch shows the code added an external capability, but no audit trail, no redaction, no permission boundary, and no test proving unauthorized calls fail.

### Architecture

Snitch should be structured as local services and testable packages:

- `apps/web`
  - live dashboard
  - React Flow graph
  - timeline
  - warning rail
  - Mermaid/docs preview

- `apps/demo-app`
  - prepared TypeScript demo app the agent or replay script mutates
  - includes route/tool/schema/test patterns that extraction supports

- `packages/graph`
  - graph IR types
  - stable ID policy
  - hashing
  - diff engine
  - contract/warning edge types

- `packages/cli`
  - local background companion commands
  - Flow Guardian-style `.snitch/` initialization
  - generated coding-agent hook adapter
  - privacy-preserving event capture

- `packages/snitchd`
  - local collector
  - HTTP hook receiver
  - WebSocket/SSE broadcaster
  - `.snitch/` artifact writer

- `packages/watcher`
  - `chokidar` file watch pipeline
  - debounce handling
  - changed-file queue

- `packages/events`
  - normalized agent event schema
  - raw event storage
  - adapters for Claude, Codex, and OpenCode event shapes

- `packages/extractor-ts`
  - `ts-morph` project bootstrap
  - TypeScript symbol/type helpers
  - extraction scheduler
  - evidence/provenance model

- `packages/extractor-ts-next`
  - Next.js route extraction
  - route-to-handler mapping

- `packages/extractor-ts-zod`
  - Zod schema discovery
  - metadata/registry ID extraction where available

- `packages/extractor-ts-mcp`
  - tool definition and registry extraction
  - input/output schema linking

- `packages/extractor-ts-env`
  - env var reference extraction
  - server/public classification

- `packages/extractor-ts-external`
  - imported external package detection
  - `fetch` hostname detection

- `packages/extractor-ts-tests`
  - test file discovery
  - test-to-capability `covers` edge inference

- `packages/renderer-layout`
  - ELK layout wrapper
  - stable position cache
  - affected-component layout strategy

- `packages/mermaid`
  - graph IR to Mermaid
  - deterministic IDs where applicable

- `packages/cerebras`
  - streaming semantic narration
  - warning inference
  - repair prompt generation
  - model/client configuration

- `packages/backboard`
  - optional memory adapter
  - repo convention lookup
  - false-positive memory

- `packages/task-sources`
  - prompt/local spec parser
  - optional 8090 Work Order adapter
  - future GitHub/Linear task source adapters

- `packages/publish-github`
  - GitHub Action / GitHub App publishing logic
  - PR summary comment generation
  - future inline review support

- `packages/replay`
  - scripted patch sequence
  - deterministic demo timeline

### Sponsor Integration Architecture

Sponsor integrations should be visible in the product architecture, not treated as a logo strip.

Snitch has three lanes:

1. Deterministic truth lane:
   - hooks, watcher, extractor, graph diff, renderer, Mermaid, and `.snitch/` artifacts
   - owns graph nodes, graph edges, evidence, and publishable facts
   - must work without sponsor credentials

2. Cerebras semantic speed lane:
   - subscribes to graph diffs and task-contract changes from `snitchd`
   - receives compact inputs: task intent, latest graph diff, warning candidates, evidence snippets, and repo rules
   - streams fast narration into the UI ticker
   - ranks changed nodes by review importance
   - infers missing companion warnings from graph shape and intent
   - generates repair prompts when a user clicks a warning
   - helps word Mermaid captions and PR summaries

3. Backboard memory lane:
   - stores repo conventions, architectural rules, known false positives, and session handoff state
   - hydrates Snitch at session start with local rules such as "external tools require audit logging"
   - records whether a warning was accepted, dismissed, or repaired
   - makes future warnings repo-aware instead of generic
   - stays off the live render path unless latency is proven acceptable

Cerebras is load-bearing for the hackathon demo because it makes user stories 8, 9, and 10 feel immediate: missing companion detection, repair prompts, and fast narration should update while the graph changes.

Backboard is optional for the MVP, but it is the clearest path to repo-aware "snitching" after the demo. Without Backboard, Snitch falls back to local rules from config and deterministic heuristics. With Backboard, the same warning engine can ask: "has this repo already said external tools require audit logging, redaction, or permission scoping?"

Important boundary:

- Cerebras and Backboard may annotate, rank, remember, and explain.
- They must not be the source of graph truth.
- Every published warning needs deterministic evidence or must be clearly marked as inferred.

Suggested live flow:

```text
agent hook / file change
  -> snitchd
  -> TypeScript extractor
  -> graph diff
  -> React Flow update

graph diff
  -> Cerebras stream: narration + salience + repair prompts
  -> .snitch artifacts
  -> PR summary

session start / warning decision / session stop
  -> Backboard lookup/write: repo rules + warning memory
```

### Local State

Snitch should persist durable run artifacts in `.snitch/`, inspired by Flow Guardian's local state model:

- `.snitch/session.json`
  - run id, task source, agent runtime, repo, branch, base/head SHA

- `.snitch/events.jsonl`
  - normalized agent/runtime events

- `.snitch/timeline.jsonl`
  - graph diffs and warning changes

- `.snitch/graph.json`
  - latest graph IR

- `.snitch/mermaid.mmd`
  - latest Mermaid diagram

- `.snitch/handoff.md`
  - final session summary

- `.snitch/pr-comment.md`
  - PR-ready Markdown artifact

### Normalized Event Model

Agent-specific adapters should normalize to a small event vocabulary:

- `session.started`
- `prompt.submitted`
- `tool.before`
- `tool.after`
- `tool.failed`
- `permission.requested`
- `permission.denied`
- `subagent.started`
- `subagent.stopped`
- `session.compacted`
- `session.stopped`
- `session.failed`
- `repo.file_changed`
- `git.commit.created`
- `git.push.started`

Each event should include:

- event id
- timestamp
- agent runtime
- repo root
- cwd
- branch
- head SHA if known
- session id
- turn id if known
- tool name if relevant
- raw payload reference
- redaction status

Raw payloads may be stored locally for debugging, but publishable artifacts must be redacted.

### Hook Strategy

Snitch uses hooks for capture, not for GitHub publishing.

Capture plane:

- Claude Code:
  - prefer HTTP hooks to local `snitchd`
  - capture `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, and subagent events where available

- Codex:
  - use command hooks where supported
  - relay stdin JSON to `snitchd` or write to a spool file that `snitchd` tails
  - do not depend on transcript parsing as a stable API

- OpenCode:
  - prefer server/SDK event stream when available
  - otherwise use a lightweight plugin for `tool.execute.before`, `tool.execute.after`, `file.edited`, and session events

- Generic agents:
  - use file watcher and replay/fallback mode

Publish plane:

- GitHub PR events trigger publish via GitHub Actions or a GitHub App.
- Use `pull_request` events for `opened`, `synchronize`, `reopened`, and `ready_for_review`.
- Use issue comments for the first PR timeline summary because every PR is also an issue.
- Use PR review APIs later for inline diff comments.
- Do not give GitHub write access to the coding agent.
- Correlate artifacts by head SHA, not branch name alone.

### Graph IR

Graph IR is the product spine and the source of truth for renderers, Mermaid, warnings, and PR artifacts.

Node kinds:

- `agent`
- `endpoint`
- `schema`
- `service`
- `tool`
- `env`
- `external`
- `database`
- `test`
- `contract`
- `warning`

Edge kinds:

- `calls`
- `validates`
- `reads`
- `writes`
- `uses_secret`
- `covers`
- `registers`
- `satisfies`
- `violates`
- `missing`

Stable IDs must be semantic, never based on array index, line number, or screen position.

Suggested ID forms:

- `endpoint:next_app:GET:/api/users`
- `schema:zod:id:create_issue_input`
- `schema:zod:symbol:CreateIssueInput@src/lib/schemas.ts`
- `tool:mcp:create_issue`
- `env:ISSUE_PROVIDER_API_KEY`
- `external:npm:@issue-provider/sdk`
- `external:http:api.issue-provider.local`
- `test:tests/issue-tool.test.ts#create issue rejects unauthorized caller`
- `warning:tool_audit_log_missing:create_issue`

Node `hash` should describe current evidence/signature. ID remains stable while hash changes.

### Extraction

Use `ts-morph` as the primary extractor. It gives the fastest path to the TypeScript compiler's semantic model while avoiding raw compiler API boilerplate.

Supported day-one extraction patterns:

- Next.js App Router route handlers:
  - `app/**/route.ts`
  - exported HTTP functions such as `GET`, `POST`, `PUT`, `PATCH`, `DELETE`

- Next.js Pages API routes:
  - `pages/api/**`

- Zod schemas:
  - exported `z.object`
  - schema parse calls
  - Zod metadata or registry IDs where statically visible

- MCP/tool definitions:
  - tool `name`
  - input/output schema references
  - tool registry calls

- Env references:
  - `process.env.FOO`
  - `process.env["FOO"]`
  - `NEXT_PUBLIC_` classification

- External calls:
  - imported SDK package references
  - `fetch` URL/hostname references

- Tests:
  - `*.test.*`
  - `*.spec.*`
  - `__tests__`
  - proven imports or calls that imply coverage

Fallback syntax parsing with tree-sitter may be added later for broken in-flight files, but the MVP can keep last good graph state on parse failures.

### Rendering

Use `@xyflow/react` for the live canvas.

Use `elkjs` for deterministic directed layout.

Use Mermaid for generated docs/export, not as the live animation surface.

Rendering rules:

- existing nodes keep positions unless the user asks for relayout
- new nodes appear near their primary neighbor
- only changed nodes/edges animate
- new edges draw on
- warnings pulse briefly
- graph never blanks on parse failure
- large graph updates should render graph first, narration second

Mermaid rules:

- Mermaid is generated from graph IR
- PR comments use compact Mermaid, not the full live graph
- generated Mermaid should be deterministic enough for review diffs

### Cerebras

Cerebras is load-bearing for the demo and should be the default semantic loop.

Use Cerebras for:

- graph-diff narration
- change salience ranking
- missing companion inference
- Mermaid/doc wording
- warning-to-repair prompt generation

Do not use Cerebras to invent graph nodes or edges. Deterministic extraction owns graph truth.

Use a configurable model policy. Default to a production model available through Cerebras; allow override through env/config.

The client should be reused rather than recreated per diff event.

### Backboard

Backboard is optional for the MVP.

Use later for:

- repo conventions
- remembered architecture rules
- false positive suppression
- session memory
- handoff context

Backboard must stay off the hot visual path unless latency proves acceptable.

### 8090 Software Factory

8090 is an optional task-source and status-export adapter.

Use later for:

- importing a Work Order as task intent
- reading linked requirements and blueprints
- exporting Snitch handoff/status back to the Work Order

Snitch must remain useful without 8090.

### Docker

Docker Compose is recommended for demo reliability:

- dashboard
- local collector
- demo app
- replay service

Docker should not be the only local runtime path.

### PR Publishing

First publishing milestone:

- GitHub Action runs on PR open/update.
- It runs Snitch analysis or reads `.snitch/pr-comment.md`.
- It posts or updates one top-level PR summary comment.

Later milestones:

- GitHub App webhook publisher
- inline review comments
- `/snitch publish` manual command
- artifact upload with HTML graph

Do not implement a GitHub MCP tool for PR publishing.

### Acceptance Criteria

The MVP is acceptable when:

1. A prepared replay sequence causes the live graph to add at least five nodes and five edges with stable animation.
2. The graph update happens without global reshuffling.
3. Mermaid output is generated from the same graph IR.
4. The warning rail shows at least three missing companion warnings.
5. Clicking a warning generates a repair prompt.
6. A Cerebras-backed narration appears for each graph diff.
7. A `.snitch/` directory contains session, graph, timeline, Mermaid, handoff, and PR-comment artifacts.
8. The app can run without 8090 or Backboard credentials.
9. If Cerebras is unavailable, the graph still updates and a static fallback narration is shown.
10. A PR comment artifact can be generated from the final run.
11. The Cerebras lane never blocks the graph render path; slow or failed inference degrades to deterministic warnings and static narration.
12. If Backboard credentials are present, Snitch can seed or retrieve at least one repo rule and use it to make a warning more repo-specific.

### Implementation Order

1. Build `packages/graph` with hardcoded before/after graphs and diff tests.
2. Build `apps/web` live graph using hardcoded graph diffs.
3. Add ELK layout and stable position cache.
4. Add Mermaid exporter.
5. Add replay sequence that streams graph diffs.
6. Add `.snitch/` artifact writer.
7. Add `snitchd` WebSocket/SSE broadcaster.
8. Add watcher and narrow TypeScript extraction for demo app.
9. Add Cerebras narration/warning/repair loop.
10. Add Backboard repo-rule memory behind a feature flag.
11. Add prepared demo app and patch sequence.
12. Add optional agent hook adapter for one runtime.
13. Add GitHub Action template for PR summary publishing.
14. Add optional 8090 adapter if time remains.

## Testing Decisions

Good tests should verify external behavior and stable contracts, not implementation details.

Primary test modules:

- `packages/graph`
  - stable IDs remain stable across file movement and line changes
  - hashes change when evidence changes
  - diff output correctly reports added, removed, changed, unchanged

- `packages/mermaid`
  - graph IR produces deterministic Mermaid
  - warning nodes/edges render correctly
  - labels are escaped safely

- `packages/extractor-ts-*`
  - fixture projects produce expected graph nodes and edges
  - broken files do not clear last good graph
  - env refs classify correctly
  - Zod schemas link to endpoints/tools when statically provable
  - tests produce `covers` edges only when evidence is present

- `packages/events`
  - Claude/Codex/OpenCode sample payloads normalize to expected events
  - raw payloads are redacted or marked unsafe before publishing

- `packages/cerebras`
  - prompt builders produce structured requests
  - parser handles valid JSON and fallback text
  - network failures degrade to static narration

- `apps/web`
  - graph renders without blanking
  - warnings appear and are clickable
  - replay sequence updates UI in order

- `packages/publish-github`
  - PR summary body is deterministic
  - existing Snitch comment is updated instead of duplicated
  - publishing uses issue comment path for top-level PR comments

Manual demo verification:

- run replay mode from a clean checkout
- record time from graph event to UI update
- verify no full-canvas reshuffle during the main demo sequence
- verify final `.snitch/pr-comment.md` is readable and pasteable

## Out of Scope

The following are out of scope for the first PRD/MVP:

- building a new coding agent
- requiring 8090 Software Factory
- requiring Backboard
- requiring Docker for all local development
- creating a full PR review competitor to CodeRabbit or Graphite
- building a general-purpose visual surface like Sideshow
- building a pre-execution plan approval tool like Overture
- supporting every language/framework
- supporting full runtime tracing
- providing production-grade security/compliance guarantees
- automatic code modification by Snitch
- giving agents GitHub write access
- inline PR review comments in the first publishing milestone
- hosted SaaS architecture beyond optional GitHub App notes

## Further Notes

### Research Summary

The strongest product thesis is:

> AI agents make code faster than teams can verify system impact. Snitch turns the agent run into live, code-backed evidence.

The closest adjacent tools are useful references, but the wedge is different:

- Sideshow proves live visual surfaces are compelling.
- FlowPlan and Overture prove plan graphs are compelling.
- Agent Flow proves live agent telemetry is compelling.
- Synapse proves Claude Code observability graphs are already a real category.
- GraphIDE proves durable visual plan files are already being explored.
- codebase-memory-mcp and code-visualizer prove code graph memory is also crowded.
- CodeSee and CodeSee-like tools prove graph-based understanding is compelling.
- CodeRabbit and Graphite prove PR review is a crowded output channel.

Snitch should connect intent, execution, code graph, warnings, and PR evidence.

### Source Links

Pain and market:

- Stack Overflow 2025 AI survey: https://survey.stackoverflow.co/2025/ai
- Sonar 2026 State of Code: https://www.sonarsource.com/blog/state-of-code-developer-survey-report-the-current-reality-of-ai-coding
- GitLab AI Accountability Report release: https://ir.gitlab.com/news/news-details/2026/GitLab-Research-Reveals-Organizations-Are-Generating-AI-Code-Faster-Than-They-Can-Control-It/default.aspx
- New Relic 2026 State of AI Coding: https://newrelic.com/resources/report/2026-state-of-ai-coding

Adjacent products:

- Sideshow: https://github.com/modem-dev/sideshow
- FlowPlan: https://github.com/Bariskau/flowplan
- Overture: https://github.com/SixHq/Overture
- Agent Flow: https://github.com/patoles/agent-flow
- Synapse: https://github.com/Soarcer/synapse
- GraphIDE: https://github.com/Z-M-Huang/graphide
- codebase-memory-mcp: https://github.com/DeusData/codebase-memory-mcp
- code-visualizer: https://github.com/kylenewm/code-visualizer
- CodeSee-like feature graph example: https://github.com/Kaka-cheaper/codeSee
- CodeRabbit docs: https://docs.coderabbit.ai
- Graphite AI reviews: https://graphite.com/features/ai-reviews

Hooks and publishing:

- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Codex hooks: https://developers.openai.com/codex/hooks
- OpenCode plugins: https://opencode.ai/docs/plugins/
- Git hooks: https://git-scm.com/docs/githooks
- GitHub Actions PR events: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- GitHub issue comments API: https://docs.github.com/rest/issues/comments
- GitHub webhook best practices: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks

Rendering and extraction:

- React Flow docs: https://reactflow.dev/api-reference/react-flow
- React Flow performance: https://reactflow.dev/learn/advanced-use/performance
- ELK JS: https://github.com/kieler/elkjs
- Mermaid API: https://mermaid.js.org/config/usage.html
- ts-morph: https://ts-morph.com
- TypeScript compiler API: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
- Next.js route handlers: https://nextjs.org/docs/app/getting-started/route-handlers
- Zod metadata: https://zod.dev/metadata
- MCP tools spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

Sponsor integrations:

- Cerebras streaming: https://inference-docs.cerebras.ai/capabilities/streaming
- Cerebras OpenAI compatibility: https://inference-docs.cerebras.ai/resources/openai
- Backboard memory: https://docs.backboard.io/concepts/memory
- 8090 Work Orders: https://www.8090.ai/docs/modules/work-orders
- 8090 Quickstart MCP step: https://www.8090.ai/docs/general/quickstart#step-8-connect-to-a-coding-agent-via-mcp
- Docker Compose: https://docs.docker.com/compose/

### Naming Note

Snitch has collision risk with existing AI/security tools, but it is emotionally strong for a hackathon because the behavior is clear: it tells on the agent when reality diverges from intent.

If the project becomes real after the hackathon, revisit naming.
