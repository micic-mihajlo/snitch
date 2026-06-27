import { spawn, spawnSync, type ChildProcess } from "node:child_process";

type ParsedArgs = {
  flags: Map<string, string | true>;
};

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";

const args = parseArgs(process.argv.slice(2));
const target = String(args.flags.get("target") ?? "apps/demo-app");
const appPort = String(args.flags.get("port") ?? "5187");
const watchPort = String(args.flags.get("watch-port") ?? "4767");
const offlineIntegrations = args.flags.has("offline-integrations");
const prepareOnly = args.flags.has("prepare-only");
const liveUrl = `http://127.0.0.1:${watchPort}`;

run("pnpm", [
  "snitch",
  "analyze",
  "--target",
  target,
  "--task",
  task
]);
run("pnpm", ["snitch", "insights", ...(offlineIntegrations ? ["--offline"] : [])]);

if (prepareOnly) {
  console.log("Snitch live demo artifacts prepared.");
  process.exit(0);
}

const children: ChildProcess[] = [];
const watchArgs = ["snitch", "watch", "--port", watchPort, "--scan-interval", "300"];

if (!offlineIntegrations) {
  watchArgs.push("--insights");
}

const watch = spawnManaged("pnpm", watchArgs, {
  VITE_SNITCH_LIVE_URL: liveUrl
});
const web = spawnManaged(
  "pnpm",
  [
    "--filter",
    "@snitch/web",
    "exec",
    "vite",
    "--host",
    "127.0.0.1",
    "--port",
    appPort,
    "--strictPort"
  ],
  {
    VITE_SNITCH_LIVE_URL: liveUrl
  }
);

children.push(watch, web);
console.log(
  [
    "Snitch live demo running.",
    `- Dashboard: http://127.0.0.1:${appPort}`,
    `- Live state: ${liveUrl}/api/state`,
    "- Stop: Ctrl-C"
  ].join("\n")
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) {
      child.kill(signal);
    }

    process.exit(0);
  });
}

function spawnManaged(command: string, commandArgs: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(command, commandArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      return;
    }

    for (const sibling of children) {
      if (sibling !== child) {
        sibling.kill("SIGTERM");
      }
    }

    process.exit(code ?? 1);
  });

  return child;
}

function run(command: string, commandArgs: string[]): void {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (!arg?.startsWith("--")) {
      continue;
    }

    const name = arg.slice(2);
    const next = rawArgs[index + 1];

    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { flags };
}
