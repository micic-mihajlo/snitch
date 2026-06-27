import { createIssueTool } from "./tools/create-issue";

export const agentRouter = {
  name: "agent-router",
  route(prompt: string) {
    return prompt.includes("issue") ? "create_issue" : "chat";
  }
};

export const assistantTools = [createIssueTool];

export function routeAssistantRequest(prompt: string) {
  const selectedTool = agentRouter.route(prompt);

  return assistantTools.find((tool) => tool.name === selectedTool);
}
