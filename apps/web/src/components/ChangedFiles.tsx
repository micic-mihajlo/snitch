import type { ChangedSurfaceView } from "../lib/useLiveSnitch";

type Props = {
  changed: ChangedSurfaceView | undefined;
};

// What this PR actually touches, paired with whether each file carries a Snitch finding —
// the core "is this diff safe to ship" glance.
export function ChangedFiles({ changed }: Props) {
  const files = changed?.changedFiles ?? [];
  const visible = files.slice(0, 8);
  const hidden = Math.max(0, files.length - visible.length);
  const flagged = flaggedPaths(changed);

  const meta = changed
    ? changed.git.available
      ? changed.git.baseRef
        ? `vs ${changed.git.baseRef}`
        : "working tree"
      : "git unavailable"
    : "waiting for data";

  return (
    <section className="card card-pad changed-card" aria-label="Changed files">
      <div className="row-between">
        <h2 className="section-title">Changed files</h2>
        <span className="section-note mono">{meta}</span>
      </div>

      {visible.length > 0 ? (
        <ul className="file-list">
          {visible.map((file) => {
            const isFlagged = file.targetPath ? flagged.has(file.targetPath) : flagged.has(file.path);
            return (
              <li key={`${file.status}:${file.path}`} className="file-row">
                <span className={`file-status s-${file.status.slice(0, 1)}`}>{file.status}</span>
                <span className="file-path" title={file.path}>
                  {file.path}
                </span>
                {isFlagged ? <span className="file-flag">● finding</span> : <span />}
              </li>
            );
          })}
          {hidden > 0 ? <li className="empty-line">+{hidden} more</li> : null}
        </ul>
      ) : (
        <p className="empty-line">No changed files against the base.</p>
      )}
    </section>
  );
}

function flaggedPaths(changed: ChangedSurfaceView | undefined): Set<string> {
  const paths = new Set<string>();
  for (const entry of changed?.changedFindings ?? []) {
    for (const file of entry.matchedFiles) {
      paths.add(file);
    }
  }
  return paths;
}
