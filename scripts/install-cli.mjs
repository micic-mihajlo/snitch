#!/usr/bin/env node
// Install the `snitch` binary onto your PATH so you can run it in any repo.
// Zero-invasive: builds the bundle and drops a single symlink into a user bin dir.
// No sudo, no shell-profile edits. Override the target with `--bin-dir <dir>`.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(repoRoot, "packages/cli/dist/main.js");

const argv = process.argv.slice(2);
const binDirFlag = argv.indexOf("--bin-dir");
const binDir =
  binDirFlag !== -1 && argv[binDirFlag + 1]
    ? resolve(argv[binDirFlag + 1])
    : join(homedir(), ".local", "bin");

console.log("Building the snitch binary…");
const build = spawnSync("pnpm", ["--filter", "@snitch/cli", "build"], {
  cwd: repoRoot,
  stdio: "inherit"
});

if (build.status !== 0) {
  console.error("\nBuild failed — see output above.");
  process.exit(build.status ?? 1);
}

if (!existsSync(distEntry)) {
  console.error(`\nExpected bundle at ${distEntry} but it was not produced.`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

const linkPath = join(binDir, "snitch");

// Remove any prior entry (including a dangling symlink, which existsSync misses).
if (existsSync(linkPath) || isSymlink(linkPath)) {
  rmSync(linkPath, { force: true });
}

symlinkSync(distEntry, linkPath);

console.log(`\nLinked: ${linkPath} -> ${distEntry}`);

const pathDirs = (process.env.PATH ?? "").split(":");

if (pathDirs.includes(binDir)) {
  console.log("\nDone. `snitch` is on your PATH. Try it in any repo:");
  console.log("  cd ~/your-project");
  console.log('  snitch init --agent claude --task "<what the agent should build>"');
  console.log("  snitch watch --insights");
} else {
  console.log(`\n${binDir} is not on your PATH yet. Add this line to your shell profile:`);
  console.log(`  export PATH="${binDir}:$PATH"`);
  console.log("\nThen restart your shell (or `source` the profile) and run `snitch`.");
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
