import { z } from "zod";

export const createIssueInputSchema = z.object({
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).default([])
});

export const createIssueTool = {
  name: "create_issue",
  description: "Create an issue in the provider from an assistant request.",
  inputSchema: createIssueInputSchema,
  async execute(input: unknown) {
    const parsed = createIssueInputSchema.parse(input);
    const response = await fetch("https://api.github.com/repos/acme/app/issues", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.ISSUE_PROVIDER_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(parsed)
    });

    return response.json();
  }
};
