#!/usr/bin/env node
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outfile = fileURLToPath(new URL("./dist/main.js", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Bundle the @snitch/* workspace sources; keep heavy/native-ish runtime deps external.
  // ts-morph ships its own TypeScript copy and is declared as a runtime dependency.
  external: ["ts-morph"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      // ESM bundles lose CJS globals that some deps probe for; shim the common ones.
      "import { createRequire as __snitchCreateRequire } from 'node:module';",
      "import { fileURLToPath as __snitchFileURLToPath } from 'node:url';",
      "import { dirname as __snitchDirname } from 'node:path';",
      "const require = __snitchCreateRequire(import.meta.url);",
      "const __filename = __snitchFileURLToPath(import.meta.url);",
      "const __dirname = __snitchDirname(__filename);"
    ].join("\n")
  },
  logLevel: "info"
});

await chmod(outfile, 0o755);
