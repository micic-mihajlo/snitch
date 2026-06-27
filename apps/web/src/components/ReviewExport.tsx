import { CopyButton } from "./CopyButton";

type Props = {
  prComment: string;
};

// The one durable output worth keeping in the daily loop: a ready-to-paste PR review
// comment. The raw graph lives in the map above, so we don't dump mermaid text here too.
export function ReviewExport({ prComment }: Props) {
  return (
    <section className="card card-pad export-card" aria-label="PR comment">
      <div className="row-between">
        <h2 className="section-title">PR comment</h2>
        <CopyButton value={prComment} label="Copy" />
      </div>
      <pre className="export-pre">{prComment}</pre>
    </section>
  );
}
