# Snitch MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working local-first Snitch prototype that turns a replayed/observed agent code change into a live graph, warnings, Mermaid, Markdown artifacts, and sponsor-backed narration/memory hooks.

**Architecture:** The MVP is a TypeScript monorepo with a deterministic core package and a Vite React dashboard. The graph IR owns truth; Cerebras and Backboard enrich the experience without owning graph facts.

**Tech Stack:** pnpm workspaces, TypeScript, Vitest, Vite, React, `@xyflow/react`, ELK-compatible layout types, Mermaid text export, Node CLI scripts, Cerebras REST/OpenAI-compatible API, Backboard REST API.

---

## File Structure

- Create `package.json`: workspace scripts for build, test, lint, typecheck, demo artifact generation.
- Create `pnpm-workspace.yaml`: workspace package globs.
- Create `tsconfig.base.json`: shared TypeScript compiler options.
- Create `packages/graph/src/types.ts`: graph IR, events, warnings, artifacts, sponsor result types.
- Create `packages/graph/src/diff.ts`: stable graph diff engine.
- Create `packages/graph/src/replay.ts`: deterministic demo snapshots and warning candidates.
- Create `packages/graph/src/mermaid.ts`: graph-to-Mermaid exporter.
- Create `packages/graph/src/artifacts.ts`: `.snitch/` artifact generation helpers.
- Create `packages/graph/src/sponsors.ts`: Cerebras/Backboard client wrappers and graceful fallbacks.
- Create `packages/graph/src/index.ts`: public package exports.
- Create `packages/graph/src/*.test.ts`: Vitest coverage for diffing, Mermaid, artifacts, and sponsor fallback behavior.
- Create `apps/web/src/App.tsx`: live Snitch dashboard and replay orchestration.
- Create `apps/web/src/components/*`: graph canvas, warning rail, timeline, artifact panel, sponsor lane.
- Create `apps/web/src/lib/*`: replay state and browser-safe artifact helpers.
- Create `apps/web/src/styles.css`: industrial/utilitarian visual system.
- Create `apps/web/src/App.test.tsx`: smoke tests for dashboard rendering and warning interactions.
- Create `apps/web/index.html`, `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json`: Vite app config.
- Create `scripts/generate-demo-artifacts.ts`: writes `.snitch/session.json`, `.snitch/graph.json`, `.snitch/timeline.jsonl`, `.snitch/mermaid.mmd`, `.snitch/handoff.md`, and `.snitch/pr-comment.md`.
- Create `scripts/smoke-cerebras.ts`: optional Cerebras smoke test using `.env`.
- Create `scripts/smoke-backboard.ts`: optional Backboard smoke test using `.env`.
- Modify `README.md`: add install, run, test, demo artifact, and sponsor smoke commands.
- Modify `.env.example`: add `CEREBRAS_MODEL` and document optional dedicated endpoint IDs.

## Task 1: Project Foundation And Graph Core

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/graph/package.json`
- Create: `packages/graph/tsconfig.json`
- Create: `packages/graph/vitest.config.ts`
- Create: `packages/graph/src/types.ts`
- Create: `packages/graph/src/diff.test.ts`
- Create: `packages/graph/src/diff.ts`
- Create: `packages/graph/src/index.ts`

- [x] **Step 1: Write failing graph diff tests**

Create tests that prove:
- added, removed, changed, and unchanged nodes are classified by stable ID and hash
- edges are diffed independently from node order
- the previous graph survives when a parse/update event is marked failed

Run: `pnpm --filter @snitch/graph test -- src/diff.test.ts`
Expected before implementation: fails because `diffGraph` and `keepLastGoodGraph` do not exist.

- [x] **Step 2: Implement graph types and diff engine**

Define `SnitchGraph`, `GraphNode`, `GraphEdge`, `GraphDiff`, `GraphUpdateResult`, and helpers:
- `diffGraph(previous, next)`
- `keepLastGoodGraph(previous, update)`
- `hashEvidence(value)`

Rules:
- IDs are semantic and stable.
- Hashes carry evidence changes.
- Failed updates return the previous graph plus a warning event.

- [x] **Step 3: Verify graph package**

Run:
- `pnpm --filter @snitch/graph test -- src/diff.test.ts`
- `pnpm --filter @snitch/graph typecheck`

Expected: tests and typecheck pass.

- [x] **Step 4: Commit**

Commit message: `feat: add graph core`

## Task 2: Replay, Warnings, Mermaid, And Artifacts

**Files:**
- Create: `packages/graph/src/replay.test.ts`
- Create: `packages/graph/src/replay.ts`
- Create: `packages/graph/src/mermaid.test.ts`
- Create: `packages/graph/src/mermaid.ts`
- Create: `packages/graph/src/artifacts.test.ts`
- Create: `packages/graph/src/artifacts.ts`
- Modify: `packages/graph/src/index.ts`
- Create: `scripts/generate-demo-artifacts.ts`

- [x] **Step 1: Write failing replay and artifact tests**

Create tests that prove:
- replay has at least four snapshots ending with issue-tool capability graph
- warning candidates include audit log, redaction, permission scope, and unauthorized test gaps
- Mermaid output is deterministic and contains the final graph nodes
- PR comment includes summary, warnings, Mermaid block, and evidence notes

Run: `pnpm --filter @snitch/graph test -- src/replay.test.ts src/mermaid.test.ts src/artifacts.test.ts`
Expected before implementation: fails because modules do not exist.

- [x] **Step 2: Implement replay data and artifact builders**

Add deterministic demo snapshots:
1. baseline assistant router
2. issue tool registered
3. provider client/env/schema added
4. warnings emitted for missing companions
5. repaired state with audit/redaction/scope/test nodes

Artifact builders must output:
- `session.json`
- `graph.json`
- `timeline.jsonl`
- `mermaid.mmd`
- `handoff.md`
- `pr-comment.md`

- [x] **Step 3: Implement CLI artifact generation**

`pnpm demo:artifacts` writes `.snitch/` files from final replay state.

- [x] **Step 4: Verify and commit**

Run:
- `pnpm --filter @snitch/graph test`
- `pnpm demo:artifacts`
- `test -f .snitch/pr-comment.md`

Commit message: `feat: generate snitch artifacts`

## Task 3: Sponsor Integration Clients

**Files:**
- Create: `packages/graph/src/sponsors.test.ts`
- Create: `packages/graph/src/sponsors.ts`
- Modify: `packages/graph/src/index.ts`
- Create: `scripts/smoke-cerebras.ts`
- Create: `scripts/smoke-backboard.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing sponsor tests**

Create tests that prove:
- Cerebras prompt builder receives task intent, graph diff, warnings, and repo rules
- Cerebras failures degrade to static narration
- Backboard repo rules can be converted into warning context
- missing credentials return disabled results without throwing

Run: `pnpm --filter @snitch/graph test -- src/sponsors.test.ts`
Expected before implementation: fails because sponsor helpers do not exist.

- [ ] **Step 2: Implement sponsor helpers**

Add:
- `createCerebrasNarrationInput`
- `narrateWithCerebras`
- `loadBackboardRepoRules`
- `rememberBackboardWarningDecision`
- `createStaticNarration`

Network calls must be injectable for tests and must never block deterministic graph rendering.

- [ ] **Step 3: Add smoke scripts**

`pnpm smoke:cerebras` performs a tiny `OK` completion using `CEREBRAS_MODEL` or `gpt-oss-120b`.

`pnpm smoke:backboard` sends a tiny `OK` message using `BACKBOARD_API_KEY` and optional `BACKBOARD_ASSISTANT_ID`.

- [ ] **Step 4: Verify and commit**

Run:
- `pnpm --filter @snitch/graph test -- src/sponsors.test.ts`
- `pnpm smoke:cerebras`
- `pnpm smoke:backboard`

Commit message: `feat: wire sponsor integrations`

## Task 4: Live Web Dashboard

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/components/GraphCanvas.tsx`
- Create: `apps/web/src/components/WarningRail.tsx`
- Create: `apps/web/src/components/Timeline.tsx`
- Create: `apps/web/src/components/ArtifactPanel.tsx`
- Create: `apps/web/src/components/SponsorLane.tsx`
- Create: `apps/web/src/lib/useReplay.ts`
- Create: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing dashboard tests**

Create tests that prove:
- the dashboard renders Snitch, replay controls, graph surface, warning rail, and sponsor lane
- clicking a warning displays a repair prompt
- replay advances through snapshots without blanking the graph

Run: `pnpm --filter @snitch/web test -- App.test.tsx`
Expected before implementation: fails because the app does not exist.

- [ ] **Step 2: Implement the dashboard**

Use `@xyflow/react` for the graph canvas.

UI requirements:
- no landing page
- first viewport is the tool
- dense left-to-right workflow layout
- stable graph dimensions
- warning rail with clickable repair prompts
- timeline of graph diffs
- artifact preview with Mermaid and PR comment
- sponsor lane showing Cerebras and Backboard status

- [ ] **Step 3: Verify and commit**

Run:
- `pnpm --filter @snitch/web test`
- `pnpm --filter @snitch/web build`

Commit message: `feat: add live dashboard`

## Task 5: End-To-End Verification And Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/prd.md` only if implementation reality requires a clarification

- [ ] **Step 1: Update README commands**

Document:
- `pnpm install`
- `pnpm test`
- `pnpm build`
- `pnpm dev`
- `pnpm demo:artifacts`
- `pnpm smoke:cerebras`
- `pnpm smoke:backboard`

- [ ] **Step 2: Run full verification**

Run:
- `pnpm test`
- `pnpm build`
- `pnpm demo:artifacts`
- `pnpm smoke:cerebras`
- `pnpm smoke:backboard`

- [ ] **Step 3: Browser verification**

Start the dev server and verify:
- desktop viewport shows nonblank graph
- warning click reveals repair prompt
- replay button advances graph
- Mermaid/PR artifact panel is visible

- [ ] **Step 4: Final review and commit**

Run a final self-review of the outgoing diff.

Commit message: `docs: document snitch mvp`
