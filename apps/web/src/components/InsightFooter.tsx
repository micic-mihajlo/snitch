type Props = {
  lines: string[];
  cerebrasStatus: string;
  backboardStatus: string;
};

// Compact AI context: the Cerebras narration of the change plus a quiet read on which
// providers are actually connected. No standalone panel, no duplicated controls.
export function InsightFooter({ lines, cerebrasStatus, backboardStatus }: Props) {
  return (
    <section className="card card-pad insight-card" aria-label="Insight">
      <h2 className="section-title">Insight</h2>
      <div className="insight-body">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="provider-row">
        <span className="provider-chip">
          <b>Cerebras</b> {cerebrasStatus}
        </span>
        <span className="provider-chip">
          <b>Backboard</b> {backboardStatus}
        </span>
      </div>
    </section>
  );
}
