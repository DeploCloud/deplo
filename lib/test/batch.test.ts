import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The runner takes the biggest file first, so the one that leaves things behind is padded.
const LEAVES_THINGS = `import { beforeEach, test } from "node:test";
const log = ((globalThis as any).deploFixtureLog ??= []) as string[];
process.env.DEPLO_FIXTURE = "a";
(globalThis as any)[Symbol.for("deplo.fixture")] = "a";
beforeEach(() => { log.push("a"); });
test("a leaves an env var, a parked global and a hook behind", () => {});
${"//".padEnd(400, "-")}
`;
const FINDS_NOTHING = `import assert from "node:assert/strict";
import { test } from "node:test";
test("b sees none of it", () => {
  assert.deepEqual((globalThis as any).deploFixtureLog, ["a"]);
  assert.equal(process.env.DEPLO_FIXTURE, undefined);
  assert.equal((globalThis as any)[Symbol.for("deplo.fixture")], undefined);
});
`;
const FAILS = `import { test } from "node:test";
test("c fails on purpose", () => { throw new Error("on purpose"); });
`;

test("files share a worker, not their hooks, env or parked globals; a failure fails the run", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deplo-batch-"));
  try {
    writeFileSync(path.join(dir, "a.test.ts"), LEAVES_THINGS);
    writeFileSync(path.join(dir, "b.test.ts"), FINDS_NOTHING);
    writeFileSync(path.join(dir, "c.test.ts"), FAILS);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ["scripts/test.mjs", dir, "--test-concurrency=1", "--test-reporter=tap"],
      { env, encoding: "utf8" },
    );
    const out = run.stdout + run.stderr;
    assert.match(out, /^# pass 2$/m, out);
    assert.match(out, /^# fail 1$/m, out);
    assert.match(out, /not ok \d+ - c fails on purpose/);
    assert.equal(run.status, 1, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MANY = `import { test } from "node:test";
for (let i = 0; i < 3000; i++) test("case " + i + " ".padEnd(60, "."), () => {});
`;

test("a report bigger than the pipe reaches the runner whole", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deplo-batch-"));
  try {
    writeFileSync(path.join(dir, "many.test.ts"), MANY);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ["scripts/test.mjs", dir, "--test-reporter=tap"],
      { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const out = run.stdout + run.stderr;
    assert.match(out, /^# pass 3000$/m, out.slice(-2000));
    assert.equal(run.status, 0, out.slice(-2000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker left with no file to claim exits cleanly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deplo-batch-"));
  try {
    writeFileSync(path.join(dir, "files.json"), "[]");
    mkdirSync(path.join(dir, "claims"));
    const shard = path.join(dir, "worker-1.mjs");
    const batch = pathToFileURL(path.resolve("lib/test/batch.mjs")).href;
    writeFileSync(
      shard,
      `import { runShard } from ${JSON.stringify(batch)};\nawait runShard(${JSON.stringify(dir)});\n`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", shard],
      { env, encoding: "utf8" },
    );
    const out = run.stdout + run.stderr;
    assert.match(out, /^# fail 0$/m, out);
    assert.equal(run.status, 0, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
