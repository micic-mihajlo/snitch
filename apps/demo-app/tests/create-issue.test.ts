import { createIssueTool } from "../src/tools/create-issue";

test("create_issue exposes provider metadata", () => {
  expect(createIssueTool.name).toBe("create_issue");
});
