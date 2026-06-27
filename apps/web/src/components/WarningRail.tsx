import { ShieldAlert } from "lucide-react";
import type { SnitchWarning } from "@snitch/graph";
import type { RankedWarningView } from "../lib/useLiveSnitch";
import { CopyButton } from "./CopyButton";

type Props = {
  warnings: SnitchWarning[];
  selectedWarning: SnitchWarning | undefined;
  rankingByWarningId?: Record<string, RankedWarningView>;
  onSelect: (warning: SnitchWarning) => void;
};

export function WarningRail({ warnings, selectedWarning, rankingByWarningId, onSelect }: Props) {
  const selectedRanking = selectedWarning ? rankingByWarningId?.[selectedWarning.id] : undefined;
  const selectedRepairPrompt = selectedWarning?.repairPrompt?.trim();
  const selectedRepairText = selectedWarning
    ? selectedRepairPrompt || selectedWarning.message || "No repair instruction available."
    : "";

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
          warnings.map((warning) => {
            const ranking = rankingByWarningId?.[warning.id];

            return (
              <button
                key={warning.id}
                type="button"
                className={warning.id === selectedWarning?.id ? "warning-item selected" : "warning-item"}
                onClick={() => onSelect(warning)}
              >
                <span className={`severity severity-${warning.severity}`}>{warning.severity}</span>
                {ranking ? (
                  <span className={`rank-badge rank-${ranking.priority}`}>
                    #{ranking.rank} {ranking.priority}
                  </span>
                ) : (
                  <span className="rank-spacer" aria-hidden="true" />
                )}
                <span>{warning.title}</span>
              </button>
            );
          })
        )}
      </div>

      {selectedWarning ? (
        <div className="repair-panel" role="region" aria-label="Selected repair prompt">
          <div className="repair-panel-heading">
            <p className="eyebrow">Repair prompt</p>
            {selectedRepairPrompt ? (
              <CopyButton value={selectedRepairPrompt} label="Copy prompt" />
            ) : null}
          </div>
          {selectedRanking ? <p className="rank-reason">{selectedRanking.reason}</p> : null}
          <p>{selectedRepairText}</p>
        </div>
      ) : null}
    </aside>
  );
}
