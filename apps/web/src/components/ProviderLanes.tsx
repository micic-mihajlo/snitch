type Props = {
  cerebrasStatus: string;
  backboardStatus: string;
};

const MCP_TOOLS = ["snitch_findings", "snitch_next_action", "snitch_check"];

// Honest, one-look explainer of how Snitch's lanes divide the work, so nobody has to guess
// what Cerebras vs. the rules are actually deciding. Mirrors the real pipeline: rules judge,
// Cerebras only draws, Backboard only remembers.
export function ProviderLanes({ cerebrasStatus, backboardStatus }: Props) {
  const lanes = [
    {
      name: "Rules",
      status: "active",
      on: true,
      role: "Deterministic checks decide every finding, its severity, and its fix. The single source of truth — it gates commits and feeds the agent. Runs with or without any provider key."
    },
    {
      name: "Cerebras",
      status: cerebrasStatus,
      on: isOn(cerebrasStatus),
      role: "Draws the fast architecture map only. It never decides what is wrong; if it is offline you still get the deterministic graph and findings."
    },
    {
      name: "Backboard",
      status: backboardStatus,
      on: isOn(backboardStatus),
      role: "Remembers findings, decisions, and repo rules across sessions so Snitch learns what this repo cares about."
    }
  ];

  return (
    <section className="card card-pad lanes-card" aria-label="How Snitch works">
      <h2 className="section-title">How Snitch works</h2>
      <ul className="lanes">
        {lanes.map((lane) => (
          <li key={lane.name} className="lane">
            <div className="lane-head">
              <span className="lane-name">{lane.name}</span>
              <span className={lane.on ? "lane-status is-on" : "lane-status is-off"}>{lane.status}</span>
            </div>
            <p className="lane-role">{lane.role}</p>
          </li>
        ))}
      </ul>

      <div className="mcp-note">
        <div className="mcp-head">
          <span>Agent tools · MCP</span>
        </div>
        <div className="mcp-tools">
          {MCP_TOOLS.map((tool) => (
            <span key={tool} className="mcp-tool">
              {tool}
            </span>
          ))}
        </div>
        <p className="mcp-role">
          Exposed over MCP so the coding agent can pull these rule findings and steer itself
          mid-session — same verdicts as this dashboard, never a model guess.
        </p>
      </div>
    </section>
  );
}

function isOn(status: string): boolean {
  return /^ok/i.test(status.trim());
}
