import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadLocalEnv(): Record<string, string> {
  const envPath = join(process.cwd(), ".env");

  try {
    const text = readFileSync(envPath, "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
  } catch {
    return {};
  }
}
