# Snitch Research Notes

Date: 2026-06-26

These are the first stack decisions for the hackathon prototype. Keep the first implementation focused on the demo loop: file change -> graph diff -> live visual update -> fast narration/docs update.

## Rendering

Recommendation: use `@xyflow/react` for the live graph shell, with positions controlled by our own graph state.

Why:

- Official React Flow docs support controlled `nodes` and `edges`.
- It supports custom node and edge components.
- It gives pan/zoom/selection quickly without building canvas interactions from scratch.
- We can still own stable IDs, layout, and animation behavior.

Use ELK only for layout calculation, not as the rendering surface.

- `elkjs` is suited to layered, directed node-link/data-flow diagrams.
- API/tool/data-flow maps want lanes: agent/router -> endpoint/tool -> schema/env -> external/db/test.
- Existing nodes should retain positions; new nodes should be placed near their primary neighbor.

Sources:

- React Flow component docs: https://reactflow.dev/api-reference/react-flow
- React Flow TypeScript docs: https://reactflow.dev/learn/advanced-use/typescript
- ELK JS README: https://github.com/kieler/elkjs/blob/master/README.md

## Mermaid / Fast Docs

Recommendation: generate Mermaid from graph IR, but do not use Mermaid as the primary live animation surface.

Why:

- Mermaid has a supported programmatic API: `initialize`, `render`, and `parse`.
- `render()` returns SVG, which is perfect for docs previews and exports.
- Mermaid render calls are queued serially, which is good for correctness but not ideal for per-edit live animation.
- Full Mermaid re-rendering can re-layout the whole diagram, which works against the "smooth delta" demo.

Use Mermaid for:

- generated docs panel
- copyable `.mmd`
- handoff exports
- PR comments
- optional 8090/Backboard artifacts

Source:

- Mermaid API overview: https://www.mintlify.com/mermaid-js/mermaid/api/overview
- Mermaid initialization/rendering docs: https://www.mintlify.com/mermaid-js/mermaid/concepts/initialization

## TypeScript Extraction

Recommendation: start with `ts-morph`.

Why:

- It wraps the TypeScript compiler API for static analysis.
- It exposes the TypeScript type checker when we need it.
- It is much faster to build with than raw compiler API calls.
- It lets us start narrow: demo app route/tool/schema/env extraction first.

Do not start with a full general-purpose code intelligence engine. Extract only the patterns needed for the demo app:

- Next.js route handlers or simple server routes
- Zod schemas
- MCP-style tool registry entries
- env var references
- external API calls
- test files

Sources:

- ts-morph type checker docs: https://ts-morph.com/navigation/type-checker
- ts-morph package docs: https://jsr.io/@ts-morph/ts-morph/doc
- ts-morph GitHub: https://github.com/dsherret/ts-morph

## Watcher / Transport

Recommendation: use `chokidar` plus WebSocket or SSE.

Chokidar notes:

- Current npm version checked: `5.0.0`.
- v5 is ESM-only and requires Node 20+.
- v4 removed glob support, so watch directories and filter with `ignored` rather than depending on glob patterns.

Transport:

- WebSocket is simplest if both graph events and control messages matter.
- SSE is enough if the browser only receives a stream of graph updates.
- Start with WebSocket if we expect replay controls and click-to-repair prompts.

Source:

- Chokidar README: https://github.com/paulmillr/chokidar?tab=readme-ov-file

## Cerebras

Recommendation: use the official TypeScript SDK for the fast semantic loop.

Package checked:

- `@cerebras/cerebras_cloud_sdk@1.64.1`

Use Cerebras for:

- one-line narration from graph diffs
- missing companion inference
- Mermaid/doc wording
- warning repair prompts
- salience ranking

Do not use Cerebras to construct the graph truth. That belongs to the extractor and graph IR.

Sources:

- Cerebras OpenAI compatibility: https://inference-docs.cerebras.ai/resources/openai
- Cerebras streaming docs: https://inference-docs.cerebras.ai/capabilities/streaming
- Cerebras Node SDK: https://github.com/Cerebras/cerebras-cloud-sdk-node/blob/main/README.md

## Backboard

Recommendation: keep out of the critical animation loop.

Use Backboard later for:

- repo memory
- remembered architecture rules
- false-positive memory
- session handoff
- adaptive context around repair prompts

Sources:

- Backboard API docs: https://docs.backboard.io/
- Backboard memory docs: https://docs.backboard.io/concepts/memory
- Backboard R-CLI commands: https://backboard.io/cli-commands

## 8090

Recommendation: make 8090 an adapter, not the product identity.

Use 8090 later for:

- importing a Work Order as intent
- reading linked requirements/blueprints
- exporting Snitch evidence as handoff/status

This should not block the universal local-first prototype.

Sources:

- 8090 Work Orders docs: https://www.8090.ai/docs/modules/work-orders
- 8090 Quickstart MCP step: https://www.8090.ai/docs/general/quickstart#step-8-connect-to-a-coding-agent-via-mcp
- 8090 agent skill docs: https://www.8090.ai/docs/opinions/agent-skill

## First Concrete Stack

Use this unless a spike proves it wrong:

- App: Next.js + TypeScript
- Live graph: `@xyflow/react`
- Layout: `elkjs`, with our own stable positions
- Docs graph: `mermaid`
- Extraction: `ts-morph`
- Watcher: `chokidar`
- Transport: `ws`
- LLM loop: `@cerebras/cerebras_cloud_sdk`
- Demo fallback: patch/replay script

First proof:

1. hardcoded graph diff animates in the browser
2. same graph exports Mermaid
3. replay script emits graph changes over WebSocket
4. Cerebras streams one-line narration for each graph diff
5. only then wire file watching and extraction
