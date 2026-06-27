import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("Snitch dashboard", () => {
  it("renders the live tool surface, warning rail, artifact panel, and sponsor lane", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Snitch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replay next/i })).toBeInTheDocument();
    expect(screen.getByText("Live System Map")).toBeInTheDocument();
    expect(screen.getByText("Warning Rail")).toBeInTheDocument();
    expect(screen.getByText("PR Artifact")).toBeInTheDocument();
    expect(screen.getByText("Cerebras")).toBeInTheDocument();
    expect(screen.getByText("Backboard")).toBeInTheDocument();
    expect(screen.getByText("static fallback")).toBeInTheDocument();
    expect(screen.getByText("not connected / 0 repo rules")).toBeInTheDocument();
    expect(screen.getByText("Create issue tool")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /No audit trail for external tool calls/i })
    ).toBeInTheDocument();
  });

  it("shows a repair prompt when a warning is clicked", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /No audit trail for external tool calls/i }));

    expect(
      within(screen.getByRole("region", { name: "Selected repair prompt" })).getByText(
        /Add an audit log write around create_issue calls/i
      )
    ).toBeInTheDocument();
  });

  it("advances replay without blanking the graph", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Replay next/i }));

    expect(screen.getByText("Live System Map")).toBeInTheDocument();
    expect(screen.getByText("Create issue tool")).toBeInTheDocument();
  });
});
