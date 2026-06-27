import { BrainCircuit, Zap } from "lucide-react";

type Props = {
  narration: string;
  ruleCount: number;
  cerebrasStatus: string;
  backboardStatus: string;
  memoryStatus: string;
};

export function IntegrationPanel({
  narration,
  ruleCount,
  cerebrasStatus,
  backboardStatus,
  memoryStatus
}: Props) {
  return (
    <section className="integration-panel" aria-label="Provider integrations">
      <div className="integration-row">
        <Zap aria-hidden="true" />
        <div>
          <h2>Cerebras</h2>
          <p>{cerebrasStatus}</p>
        </div>
      </div>
      <output className="narration">{narration}</output>
      <div className="integration-row">
        <BrainCircuit aria-hidden="true" />
        <div>
          <h2>Backboard</h2>
          <p>{backboardStatus} / {ruleCount} repo rules</p>
          <p>memory: {memoryStatus}</p>
        </div>
      </div>
    </section>
  );
}
