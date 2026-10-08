// `bun run test [file|dir ...] [--test-flag=value ...]`: one worker per core pulls
// test files off a shared list (lib/test/batch.mjs), so the module graph and
// the test database boot once per worker instead of once per file.
import { spawn } from "node:child_process";
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SUITE = [
  "lib/**/*.test.ts",
  "components/**/*.test.ts",
  "templates/**/*.test.ts",
  "*.test.ts",
];

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const targets = args.filter((a) => !a.startsWith("-"));

const patterns = targets.length
  ? targets.map((t) => {
      const s = statSync(path.resolve(root, t), { throwIfNoEntry: false });
      return s?.isDirectory() ? `${t.replace(/\/$/, "")}/**/*.test.ts` : t;
    })
  : SUITE;
const files = [
  ...new Set(
    patterns.flatMap((p) =>
      globSync(p, { cwd: root, exclude: ["node_modules/**"] }),
    ),
  ),
];
if (files.length === 0) {
  console.error(`No test files match ${patterns.join(" ")}`);
  process.exit(1);
}
// Biggest first, so the longest files are not the ones left running at the end.
const size = (f) => statSync(path.resolve(root, f)).size;
files.sort((a, b) => size(b) - size(a) || a.localeCompare(b));

const asked = flags.find((f) => f.startsWith("--test-concurrency="));
const workers = Math.min(
  Number(asked?.split("=")[1]) || os.availableParallelism(),
  files.length,
);
const runDir = mkdtempSync(path.join(os.tmpdir(), "deplo-test-"));
writeFileSync(path.join(runDir, "files.json"), JSON.stringify(files));
mkdirSync(path.join(runDir, "claims"));
const batch = pathToFileURL(path.join(root, "lib/test/batch.mjs")).href;
const shards = Array.from({ length: workers }, (_, i) => {
  const shard = path.join(runDir, `worker-${i + 1}.mjs`);
  writeFileSync(
    shard,
    `import { runShard } from ${JSON.stringify(batch)};\nawait runShard(${JSON.stringify(runDir)});\n`,
  );
  return shard;
});

const child = spawn(
  process.execPath,
  [
    "--require",
    "./lib/test/server-only-shim.cjs",
    "--require",
    "./lib/test/offline.cjs",
    "--require",
    "./lib/test/temp-sweep.cjs",
    "--require",
    "./lib/test/scrypt-memo.cjs",
    "--import",
    "tsx",
    "--test",
    `--test-concurrency=${workers}`,
    ...flags,
    ...shards,
  ],
  { cwd: root, stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  rmSync(runDir, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
