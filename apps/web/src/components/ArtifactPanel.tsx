import { FileText } from "lucide-react";
import type { SnitchArtifacts } from "@snitch/graph";
import { CopyButton } from "./CopyButton";

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
        <figure className="artifact-block">
          <figcaption>
            <span>mermaid.mmd</span>
            <CopyButton value={artifacts["mermaid.mmd"]} label="Copy" />
          </figcaption>
          <pre aria-label="Mermaid artifact">{artifacts["mermaid.mmd"]}</pre>
        </figure>
        <figure className="artifact-block">
          <figcaption>
            <span>pr-comment.md</span>
            <CopyButton value={artifacts["pr-comment.md"]} label="Copy" />
          </figcaption>
          <pre aria-label="PR comment artifact">{artifacts["pr-comment.md"]}</pre>
        </figure>
      </div>
    </section>
  );
}
