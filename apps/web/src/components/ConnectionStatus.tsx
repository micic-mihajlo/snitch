type Props = {
  live: boolean;
  detail: string;
};

// Single, honest read on whether the dashboard is wired to a running `snitch watch`
// session or just showing the offline preview.
export function ConnectionStatus({ live, detail }: Props) {
  return (
    <span className={live ? "status-pill is-live" : "status-pill"} role="status">
      <span className="status-dot" aria-hidden="true" />
      {detail}
    </span>
  );
}
