import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function inAWorker(script: string): string[] {
  return execFileSync(
    process.execPath,
    ["--require", "./lib/test/temp-sweep.cjs", "-e", script],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("temp-sweep", () => {
  // A test file mkdtemps at module load, so nothing but the worker's exit can own the result.
  test("removes every mkdtemp a worker made, sync and async alike", async () => {
    const dirs = inAWorker(`
      const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
      console.log(fs.mkdtempSync(p.join(os.tmpdir(), "deplo-sweep-sync-")));
      fs.mkdtemp(p.join(os.tmpdir(), "deplo-sweep-cb-"), (err, dir) => {
        console.log(dir);
        fs.promises.mkdtemp(p.join(os.tmpdir(), "deplo-sweep-promise-")).then((d) => console.log(d));
      });
    `);
    assert.equal(
      dirs.length,
      3,
      `expected three dirs, got ${JSON.stringify(dirs)}`,
    );
    for (const dir of dirs) {
      assert.ok(!existsSync(dir), `${dir} outlived the worker`);
    }
  });

  // The pglite and tsx caches are deterministic paths that MUST survive between runs.
  test("leaves a directory it did not create alone", () => {
    const [kept] = inAWorker(`
      const fs = require("node:fs"), os = require("node:os"), p = require("node:path");
      const dir = p.join(os.tmpdir(), "deplo-sweep-cache-" + process.pid);
      fs.mkdirSync(dir, { recursive: true });
      console.log(dir);
    `);
    assert.ok(existsSync(kept), "a cache dir must outlive the worker");
    assert.ok(path.basename(kept).startsWith("deplo-sweep-cache-"));
    execFileSync("rm", ["-rf", kept]);
  });
});
