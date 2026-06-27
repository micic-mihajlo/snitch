import { ShieldAlert } from "lucide-react";
import type { SnitchWarning } from "@snitch/graph";

type Props = {
  warnings: SnitchWarning[];
  selectedWarning: SnitchWarning | undefined;
  onSelect: (warning: SnitchWarning) => void;
};

export function WarningRail({ warnings, selectedWarning, onSelect }: Props) {
  return (
    <aside className="warning-panel" aria-label="Warning Rail">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Companion gaps</p>
          <h2>Warning Rail</h2>
        </div>
        <ShieldAlert aria-hidden="true" className="panel-icon" />
      </div>

      <div className="warning-list">
        {warnings.length === 0 ? (
          <p className="empty-state">No active warnings in this snapshot.</p>
        ) : (
          warnings.map((warning) => (
            <button
              key={warning.id}
              type="button"
              className={warning.id === selectedWarning?.id ? "warning-item selected" : "warning-item"}
              onClick={() => onSelect(warning)}
            >
              <span className={`severity severity-${warning.severity}`}>{warning.severity}</span>
              <span>{warning.title}</span>
            </button>
          ))
        )}
      </div>

      {selectedWarning ? (
        <div className="repair-panel" role="region" aria-label="Selected repair prompt">
          <p className="eyebrow">Repair prompt</p>
          <p>{selectedWarning.repairPrompt}</p>
        </div>
      ) : null}
    </aside>
  );
}
