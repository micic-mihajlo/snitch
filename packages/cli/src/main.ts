import { runCli } from "./cli";

const args = process.argv.slice(2);
const command = args[0];

// Only the `event` command consumes a piped hook payload from stdin. `mcp` streams
// stdin itself. Every other command must never block on stdin — otherwise a non-TTY
// invocation (a hook, a CI step, a background runner) would hang forever.
const stdin = command === "event" ? await readStdin() : "";

const result = await runCli(args, { cwd: process.cwd(), stdin });

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

process.exitCode = result.code;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const timeoutMs = Number(process.env.SNITCH_STDIN_TIMEOUT_MS ?? 2000);
  const chunks: Buffer[] = [];

  try {
    await Promise.race([
      collectStdin(chunks),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch {
    // A stdin read error should degrade to "no payload", never crash the command.
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function collectStdin(chunks: Buffer[]): Promise<void> {
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
}
