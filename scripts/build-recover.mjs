import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ["scripts/recover.ts"],
  outfile: "dist/recover.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  alias: { "server-only": "./lib/test/server-only-shim.cjs" },
  external: ["pg-native"],
  logLevel: "info",
});
