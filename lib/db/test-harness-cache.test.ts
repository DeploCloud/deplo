import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// /tmp is memory on many hosts: a test process leaves no PGlite snapshot behind it.
test("a test database leaves nothing in the temp dir once its process ends", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deplo-harness-cache-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    delete env.DEPLO_TEST_CACHE_DIR;
    const run = spawnSync(
      process.execPath,
      [
        "--require",
        "./lib/test/server-only-shim.cjs",
        "--import",
        "tsx",
        "-e",
        'const h = await import("./lib/db/test-harness.ts"); const { pg } = await h.makeTestDb(); await pg.close();',
      ],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      fs.readdirSync(tmp).filter((f) => f.startsWith("deplo-pglite")),
      [],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
