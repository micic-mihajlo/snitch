import type { ReactNode } from "react";

export type SlideDef = {
  id: string;
  node: ReactNode;
};

export const slides: SlideDef[] = [
  {
    id: "cover",
    node: (
      <>
        <div className="spacer" />
        <p className="kicker">Local verification layer for coding agents</p>
        <h1 className="title">
          <span className="wordmark">Snitch</span>
        </h1>
        <p className="lead" style={{ marginTop: "2cqh" }}>
          The layer that <b className="accent">steers your coding agent mid-session</b> — and
          catches the gap <i>before</i> it ever reaches a pull request.
        </p>
        <div className="spacer" />
        <div className="flow">
          <span className="chip mono">Devin</span>
          <span className="chip mono">Cursor</span>
          <span className="chip mono">Claude Code</span>
          <span className="chip mono">Codex</span>
          <span className="chip">long-running /goals &amp; loops</span>
        </div>
      </>
    )
  },
  {
    id: "shift",
    node: (
      <>
        <p className="kicker">What changed</p>
        <h2 className="heading">
          Agents write more of the code now —<br />
          and so do less-technical teammates.
        </h2>
        <div className="spacer" />
        <div className="row">
          <div className="card grow">
            <div className="label">Then</div>
            <div className="big">An engineer wrote it</div>
            <p>Context, intent, and the missing pieces lived in one head.</p>
          </div>
          <div className="card grow">
            <div className="label">Now</div>
            <div className="big">An agent ships a diff</div>
            <p>
              Kicked off by a PM, a designer, or a <span className="mono">/goal</span> running
              unattended for an hour.
            </p>
          </div>
        </div>
      </>
    )
  },
  {
    id: "problem",
    node: (
      <>
        <p className="kicker">The problem</p>
        <h2 className="heading">
          Today the first real check is <span className="high">PR review.</span>
        </h2>
        <p className="lead" style={{ marginTop: "2.4cqh" }}>
          That is the most expensive place to catch a missing audit log, an unredacted secret, or
          an ungated external call.
        </p>
        <div className="spacer" />
        <div className="flow">
          <span className="node">prompt</span>
          <span className="arrow">→</span>
          <span className="node">agent writes for an hour</span>
          <span className="arrow">→</span>
          <span className="node hot">PR</span>
          <span className="arrow">→</span>
          <span className="node hot">senior engineer untangles it</span>
        </div>
        <p className="lead" style={{ marginTop: "3cqh" }}>
          And a long agent loop with no checkpoint just <b className="high">drifts</b>.
        </p>
      </>
    )
  },
  {
    id: "idea",
    node: (
      <>
        <p className="kicker">The idea</p>
        <h2 className="heading">Move the check left — into the session.</h2>
        <p className="lead" style={{ marginTop: "2.4cqh" }}>
          Snitch watches the change as the agent makes it, and steers it the moment a gap appears.
        </p>
        <div className="spacer" />
        <div className="flow">
          <span className="node">prompt</span>
          <span className="arrow">→</span>
          <span className="node">agent edits</span>
          <span className="arrow">→</span>
          <span className="node snitch">Snitch flags &amp; steers</span>
          <span className="arrow">→</span>
          <span className="node">agent fixes</span>
          <span className="arrow">→</span>
          <span className="node good" style={{ borderColor: "rgba(86,204,140,.5)", background: "var(--good-soft)" }}>
            clean PR
          </span>
        </div>
      </>
    )
  },
  {
    id: "how",
    node: (
      <>
        <p className="kicker">How it works</p>
        <h2 className="heading">Deterministic rules, not a model's opinion.</h2>
        <div className="spacer" />
        <ul className="bullets">
          <li>
            <span className="dot" />
            <span>
              A <b>ts-morph extractor</b> builds a graph of the change — tools, routes, external
              systems, secrets.
            </span>
          </li>
          <li>
            <span className="dot" />
            <span>
              Rules flag <b>missing companions</b>: audit log, secret redaction, permission scope,
              an unauthorized-call test.
            </span>
          </li>
          <li>
            <span className="dot" />
            <span>
              Every verdict is <b className="good">reproducible</b> — same inputs, same findings,
              with or without a provider key.
            </span>
          </li>
        </ul>
      </>
    )
  },
  {
    id: "lanes",
    node: (
      <>
        <p className="kicker">Three lanes, one job each</p>
        <h2 className="heading">Rules judge. Cerebras draws. Backboard remembers.</h2>
        <div className="spacer" />
        <div className="row">
          <div className="card grow lane rules">
            <div className="big good">Rules</div>
            <p>The source of truth. Decides every finding and its fix. Gates the change.</p>
          </div>
          <div className="card grow lane cerebras">
            <div className="big accent">Cerebras</div>
            <p>Ultra-fast architecture diagram of the change, live. Never judges correctness.</p>
          </div>
          <div className="card grow lane backboard">
            <div className="big" style={{ color: "var(--medium)" }}>
              Backboard
            </div>
            <p>Remembers findings and repo rules across sessions, so it learns your codebase.</p>
          </div>
        </div>
      </>
    )
  },
  {
    id: "mcp",
    node: (
      <>
        <p className="kicker">The steering wheel</p>
        <h2 className="heading">
          The agent pulls findings over <span className="accent">MCP</span> and self-corrects.
        </h2>
        <p className="lead" style={{ marginTop: "2.2cqh" }}>
          No human in the loop. Mid-<span className="mono">/goal</span>, mid-loop, the agent asks
          Snitch what to fix next — and gets the same rule-grounded answer this dashboard shows.
        </p>
        <div className="spacer" />
        <div className="flow">
          <span className="tag">snitch_findings</span>
          <span className="tag">snitch_next_action</span>
          <span className="tag">snitch_check</span>
          <span className="tag">snitch_changed</span>
          <span className="tag">snitch_repair_prompt</span>
        </div>
      </>
    )
  },
  {
    id: "dashboard",
    node: (
      <>
        <div className="row" style={{ height: "100%" }}>
          <div className="col grow" style={{ justifyContent: "center", maxWidth: "44%" }}>
            <p className="kicker">The daily driver</p>
            <h2 className="heading">A calm live sidecar.</h2>
            <p className="lead">
              Sits on a third of your monitor: what changed, what's flagged, and the one next
              action — copy-ready for the agent.
            </p>
          </div>
          <div className="shot grow">
            <img src="/shots/dashboard.png" alt="Snitch dashboard" />
          </div>
        </div>
      </>
    )
  },
  {
    id: "dogfood",
    node: (
      <>
        <div className="row" style={{ height: "100%" }}>
          <div className="shot grow" style={{ maxWidth: "40%" }}>
            <img src="/shots/diagram.png" alt="Snitch system map" />
          </div>
          <div className="col grow" style={{ justifyContent: "center" }}>
            <p className="kicker">Proof — we pointed Snitch at Snitch</p>
            <h2 className="heading">It caught its own missing audit log.</h2>
            <p className="lead">
              We added a real <span className="mono">snitch notify</span> command that calls a
              webhook with a secret. Live, Snitch flagged the un-audited call on its own command —
              and steered the fix over MCP, before any PR.
            </p>
          </div>
        </div>
      </>
    )
  },
  {
    id: "why",
    node: (
      <>
        <p className="kicker">Why it matters</p>
        <h2 className="heading">Reliability for the way teams ship now.</h2>
        <div className="spacer" />
        <ul className="bullets">
          <li>
            <span className="dot" />
            <span>
              <b>Long /goals &amp; loops stay on track</b> — a deterministic checkpoint the agent
              keeps hitting, instead of drifting.
            </span>
          </li>
          <li>
            <span className="dot" />
            <span>
              <b>Non-engineers ship safely</b> — the guardrails travel with the agent, not the
              reviewer.
            </span>
          </li>
          <li>
            <span className="dot" />
            <span>
              <b>Engineers stop reviewing the basics</b> — the boring gaps are gone before the PR
              opens.
            </span>
          </li>
        </ul>
      </>
    )
  },
  {
    id: "close",
    node: (
      <>
        <div className="spacer" />
        <h1 className="title">
          Keep the agent <span className="accent">in check.</span>
        </h1>
        <p className="lead" style={{ marginTop: "2.4cqh" }}>
          <span className="wordmark">Snitch</span> — verification that runs while the agent works.
        </p>
        <div className="spacer" />
        <div className="flow">
          <span className="chip mono">github.com/micic-mihajlo/snitch</span>
          <span className="chip good">local · deterministic · MCP-native</span>
        </div>
      </>
    )
  }
];
