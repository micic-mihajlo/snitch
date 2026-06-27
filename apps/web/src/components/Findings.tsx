import type { SnitchWarning } from "@snitch/graph";
import type { RankedWarningView } from "../lib/useLiveSnitch";

type Props = {
  warnings: SnitchWarning[];
  selectedWarning: SnitchWarning | undefined;
  rankingByWarningId?: Record<string, RankedWarningView>;
  onSelect: (warning: SnitchWarning) => void;
};

// Browsable list of every active finding. Selecting one drives the Next action card and
// focuses the map, so the list stays a pure picker with no duplicated detail.
export function Findings({ warnings, selectedWarning, rankingByWarningId, onSelect }: Props) {
  return (
    <section className="card card-pad findings-card" aria-label="Findings">
      <div className="row-between">
        <h2 className="section-title">Findings</h2>
        <span className="section-note">{warnings.length} active</span>
      </div>

      {warnings.length === 0 ? (
        <p className="empty-line">No active findings.</p>
      ) : (
        <div className="findings-list">
          {warnings.map((warning) => {
            const ranking = rankingByWarningId?.[warning.id];
            const selected = warning.id === selectedWarning?.id;

            return (
              <button
                key={warning.id}
                type="button"
                className={selected ? "finding-row is-selected" : "finding-row"}
                aria-pressed={selected}
                onClick={() => onSelect(warning)}
              >
                <span className={`sev sev-${warning.severity}`}>{warning.severity}</span>
                {ranking ? <span className="rank-tag">#{ranking.rank}</span> : <span className="rank-tag" />}
                <span className="finding-title">{warning.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
