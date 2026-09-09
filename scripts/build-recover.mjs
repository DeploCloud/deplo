// The runtime image has no source tree, no bun and no tsx, so the break-glass
// CLI ships as one bundled file: `deplo recover` -> `node recover.js`.
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
  // `server-only` throws by design outside a bundler; this is the same no-op the
  // test runner preloads. `pg-native` is pg's optional native driver.
  alias: { "server-only": "./lib/test/server-only-shim.cjs" },
  external: ["pg-native"],
  logLevel: "info",
});
