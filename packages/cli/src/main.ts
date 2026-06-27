import { runCli } from "./cli";

const args = process.argv.slice(2);
const shouldStreamStdin = args[0] === "mcp";
const options = shouldStreamStdin
  ? { cwd: process.cwd() }
  : { cwd: process.cwd(), stdin: await readStdin() };
const result = await runCli(args, options);

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

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}
