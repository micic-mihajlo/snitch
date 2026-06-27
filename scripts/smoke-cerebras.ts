import {
  createCerebrasNarrationInput,
  diffGraph,
  getDemoReplay,
  getReviewSnapshot,
  narrateWithCerebras
} from "../packages/graph/src/index";
import { loadLocalEnv } from "./env";

const env = { ...loadLocalEnv(), ...process.env };
const replay = getDemoReplay();
const reviewSnapshot = getReviewSnapshot(replay);
const previous = replay[2];

if (!previous) {
  throw new Error("Demo replay is missing the provider-wired snapshot.");
}

const input = createCerebrasNarrationInput({
  task: String(reviewSnapshot.graph.meta?.task ?? "Snitch demo"),
  diff: diffGraph(previous.graph, reviewSnapshot.graph),
  warnings: reviewSnapshot.warnings,
  repoRules: []
});
const result = await narrateWithCerebras({
  apiKey: env.CEREBRAS_API_KEY,
  model: env.CEREBRAS_MODEL || "gpt-oss-120b",
  input
});

console.log(
  JSON.stringify(
    {
      status: result.status,
      model: result.model,
      text: result.text.slice(0, 240)
    },
    null,
    2
  )
);
