# Snitch

Catch what your coding agent missed, mid-session, before the PR.

## Inspiration

We kept watching the same thing happen. An agent (Cursor, Claude Code, a Devin run) writes a few hundred lines, and nobody looks closely until the pull request. By then a missing audit log or a leaked secret is the most expensive it will ever be to fix, and the person who opened the PR often is not the person who can judge it. More of our team ships agent-written code now, and not all of them are engineers. Review became the first real checkpoint, which is too late.

The other half was long-running agents. A `/goal` or a loop that runs unattended for an hour has no checkpoint. It drifts, and you find out at the end.

We wanted a check that runs while the agent works, not after.

## What it does

Snitch is a local verification layer for coding agents. It watches a change as the agent makes it, builds a deterministic graph of the code (tools, routes, external calls, secrets), and flags missing companions: an audit log around an external call, redaction of a secret, a permission scope, a test that proves an unauthorized call is rejected.

Every finding comes from rules, not from a model deciding what looks wrong. The same change always produces the same findings, with or without a provider key.

The findings are exposed over MCP. The agent calls `snitch_findings`, `snitch_next_action`, and `snitch_check`, and corrects itself mid-session, before it opens a PR. A live dashboard runs as a quiet sidecar that fits a third of a vertical monitor: what changed, what is flagged, and the one next action, copy-ready for the agent.

Two providers sit beside the rules and do one job each. Cerebras draws a fast architecture diagram of the change. Backboard remembers findings and repo rules across sessions. Neither one decides correctness.

## How we built it

The core is a TypeScript monorepo on pnpm. A ts-morph extractor reads the repo and emits a graph: agent tools, CLI commands, HTTP routes, external calls, secrets, and the edges between them. A rule layer walks that graph and attaches findings to any actor that reaches an external system without its companions.

The CLI carries the product. `snitch analyze` builds the graph, `snitch watch` runs a live HTTP server with file watching and server-sent events, and `snitch mcp` runs an MCP stdio server that hands findings to the agent. The dashboard is React and Vite in a soft dark theme, Geist throughout, designed to sit next to the editor.

Cerebras turns the rule graph into a compact diagram, fast, and falls back to a deterministic diagram when it is offline. Backboard stores repo rules and remembered decisions.

We dogfooded it the whole way. Snitch watches its own repo while we build it.

## Challenges we faced

The hard part was deciding what gets to say "this is wrong." Early on, Cerebras ranked the findings, which meant the model could change a verdict between runs. We pulled it out of that path. Rules decide; Cerebras only draws. The findings, their order, and their repair prompts are now reproducible.

The map fought us too. A first version drew each finding as its own red node, which left lonely red boxes floating in the diagram. We collapsed findings into a badge on the real node they sit on, so the map reads as architecture and shows why something is flagged. The fallback diagram had a related bug: it seeded only from warnings and stopped one hop out, so after the collapse the map showed a single node. We taught it to expand to the real architecture around a finding, the external system it calls, the secret it uses, the service that registers it.

## What we learned

The valuable part of an agent guardrail is not catching everything. It is being deterministic enough that the agent can act on it without a human. Once findings stopped being a model's opinion, the MCP loop got simple: the agent asks what is wrong, gets the same answer every time, fixes it, asks again.

We also learned to trust the dogfood. We added a real command to Snitch that called a webhook with a secret and no audit log. Snitch caught it live, on its own codebase, and steered the fix over MCP before any PR.

## What's next

Wider rule coverage beyond the agent-tool and route patterns. More languages past TypeScript. And a tighter hook into long-running loops, so a `/goal` checks against Snitch on every step instead of only at the end.

## Built with

TypeScript, Node.js, pnpm, ts-morph, Model Context Protocol (MCP), React 19, Vite, React Flow (@xyflow/react), Vitest, esbuild, Server-Sent Events, Cerebras inference API, Backboard memory API, Geist typeface.

## Try it out

- Code: https://github.com/micic-mihajlo/snitch
