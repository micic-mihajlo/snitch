import { FileText } from "lucide-react";
import type { SnitchArtifacts } from "@snitch/graph";

type Props = {
  artifacts: SnitchArtifacts;
};

export function ArtifactPanel({ artifacts }: Props) {
  return (
    <section className="artifact-panel" aria-label="PR Artifact">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Durable output</p>
          <h2>PR Artifact</h2>
        </div>
        <FileText aria-hidden="true" className="panel-icon" />
      </div>
      <div className="artifact-grid">
        <pre aria-label="Mermaid artifact">{artifacts["mermaid.mmd"]}</pre>
        <pre aria-label="PR comment artifact">{artifacts["pr-comment.md"]}</pre>
      </div>
    </section>
  );
}
