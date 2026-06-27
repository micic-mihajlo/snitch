import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.SNITCH_VERIFY_PORT ?? 5187);
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = join(process.cwd(), ".snitch", "verification");

const server = spawn(
  "pnpm",
  ["--filter", "@snitch/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  }
);

let serverOutput = "";

server.stdout.on("data", (chunk: Buffer) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk: Buffer) => {
  serverOutput += chunk.toString();
});

try {
  await waitForServer(baseUrl);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const consoleErrors: string[] = [];

  desktop.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await desktop.getByRole("heading", { name: "Snitch" }).waitFor();
  await desktop.getByText("Live System Map").waitFor();
  await desktop.getByText("Create issue tool").first().waitFor();
  await desktop.getByRole("button", { name: /No audit trail for external tool calls/i }).click();
  await desktop
    .getByRole("region", { name: "Selected repair prompt" })
    .getByText(/Add an audit log write around create_issue calls/i)
    .waitFor();
  await desktop.screenshot({ path: join(outputDir, "desktop-warning.png"), fullPage: true });
  await desktop.getByRole("button", { name: /Replay next/i }).click();
  await desktop.getByText("Companion work repaired").waitFor();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.getByRole("heading", { name: "Snitch" }).waitFor();
  await mobile.getByRole("button", { name: /No audit trail for external tool calls/i }).waitFor();
  await mobile.screenshot({ path: join(outputDir, "mobile-warning.png"), fullPage: true });

  await browser.close();

  if (consoleErrors.length > 0) {
    throw new Error(`Browser console errors:\n${consoleErrors.join("\n")}`);
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        baseUrl,
        screenshots: [
          join(outputDir, "desktop-warning.png"),
          join(outputDir, "mobile-warning.png")
        ]
      },
      null,
      2
    )
  );
} finally {
  server.kill("SIGTERM");
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before verification started:\n${serverOutput}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}.\n${serverOutput}`);
}
