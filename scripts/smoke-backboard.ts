import { loadBackboardRepoRules, rememberBackboardWarningDecision, getReviewSnapshot, getDemoReplay } from "../packages/graph/src/index";
import { loadLocalEnv } from "./env";

const env = { ...loadLocalEnv(), ...process.env };
const reviewSnapshot = getReviewSnapshot(getDemoReplay());

const rules = await loadBackboardRepoRules({
  apiKey: env.BACKBOARD_API_KEY,
  assistantId: env.BACKBOARD_ASSISTANT_ID,
  task: String(reviewSnapshot.graph.meta?.task ?? "Snitch demo")
});

const memory = await rememberBackboardWarningDecision({
  apiKey: env.BACKBOARD_API_KEY,
  assistantId: env.BACKBOARD_ASSISTANT_ID,
  warning: reviewSnapshot.warnings[0] ?? {
    id: "warning:smoke",
    kind: "warning",
    severity: "info",
    title: "Smoke warning",
    message: "Smoke test",
    evidence: ["smoke"]
  },
  decision: "accepted"
});

console.log(
  JSON.stringify(
    {
      rulesStatus: rules.status,
      ruleCount: rules.rules.length,
      memoryStatus: memory.status
    },
    null,
    2
  )
);
