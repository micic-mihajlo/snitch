import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSnitchArtifacts } from "../packages/graph/src/index";
import { extractTypeScriptGraph } from "../packages/extractor-ts/src/index";

const task =
  "Add an external issue-creation tool to this coding assistant. It should validate the request, call the issue provider, and expose the tool through the assistant's registry.";
const extracted = extractTypeScriptGraph({
  cwd: join(process.cwd(), "apps/demo-app"),
  title: "Extracted demo app graph",
  generatedAt: new Date().toISOString()
});
const artifacts = buildSnitchArtifacts({
  replay: [extracted.snapshot],
  reviewSnapshot: extracted.snapshot,
  createdAt: new Date().toISOString(),
  runId: "snitch-extracted-demo",
  task,
  source: "snitch-ts-extractor"
});
const outputDir = join(process.cwd(), ".snitch");

await mkdir(outputDir, { recursive: true });

await Promise.all(
  Object.entries(artifacts).map(([filename, contents]) =>
    writeFile(join(outputDir, filename), `${contents}\n`, "utf8")
  )
);

console.log(
  `Extracted ${extracted.snapshot.graph.nodes.length} nodes and ${extracted.snapshot.graph.edges.length} edges from apps/demo-app`
);
console.log(`Wrote ${Object.keys(artifacts).length} Snitch artifacts to ${outputDir}`);
