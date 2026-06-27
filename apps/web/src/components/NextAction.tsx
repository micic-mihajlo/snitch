import { CopyButton } from "./CopyButton";

type Anchor = {
  href?: string;
  label: string;
};

type Props = {
  clear: boolean;
  title: string;
  prompt: string;
  reason?: string | undefined;
  severity?: string | undefined;
  copyValue?: string | undefined;
  anchor?: Anchor | undefined;
};

// The single most important thing on screen: what to do next. When the current diff is
// clean it says so plainly; otherwise it shows the selected finding's fix and a copy button
// so the prompt can go straight to the agent.
export function NextAction({ clear, title, prompt, reason, severity, copyValue, anchor }: Props) {
  return (
    <section
      className={clear ? "card card-pad action-card is-clear" : "card card-pad action-card"}
      aria-label="Next action"
    >
      <div className="action-head">
        <span className="action-badge">Next action</span>
        {severity ? <span className={`sev sev-${severity}`}>{severity}</span> : null}
      </div>

      <p className="action-title">{title}</p>
      {reason ? <p className="action-reason">{reason}</p> : null}

      <p className="action-prompt">{prompt}</p>

      <div className="action-head">
        {anchor ? (
          anchor.href ? (
            <a className="action-anchor" href={anchor.href}>
              {anchor.label}
            </a>
          ) : (
            <span className="action-anchor">{anchor.label}</span>
          )
        ) : (
          <span />
        )}
        {copyValue ? <CopyButton value={copyValue} label="Copy fix prompt" /> : null}
      </div>
    </section>
  );
}
