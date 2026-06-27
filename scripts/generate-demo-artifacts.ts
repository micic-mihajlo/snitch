import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSnitchArtifacts, getDemoReplay, getReviewSnapshot } from "../packages/graph/src/index";

const replay = getDemoReplay();
const reviewSnapshot = getReviewSnapshot(replay);
const artifacts = buildSnitchArtifacts({
  replay,
  reviewSnapshot,
  createdAt: new Date().toISOString(),
  runId: "snitch-demo",
  task:
    "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry."
});

const outputDir = join(process.cwd(), ".snitch");

await mkdir(outputDir, { recursive: true });

await Promise.all(
  Object.entries(artifacts).map(([filename, contents]) =>
    writeFile(join(outputDir, filename), `${contents}\n`, "utf8")
  )
);

console.log(`Wrote ${Object.keys(artifacts).length} Snitch artifacts to ${outputDir}`);
