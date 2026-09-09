import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hiddenEcho } from "./scripts/recover";

/**
 * The break-glass CLI has to run where there is no source tree, no bun and no
 * tsx: the Docker image ships this bundle and nothing else of `scripts/`.
 */
const build = spawnSync(process.execPath, ["scripts/build-recover.mjs"], {
  encoding: "utf8",
});

function runOutsideTheRepo(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "deplo-recover-"));
  const bundle = join(dir, "recover.js");
  copyFileSync("dist/recover.js", bundle);
  return spawnSync(process.execPath, [bundle, "help"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: process.env.NODE_ENV,
      // A syntactically valid URL is all the module-load guard wants; `help`
      // never opens a connection.
      DEPLO_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/d",
      ...env,
    },
  });
}

test("the bundle builds", () => {
  assert.equal(build.status, 0, build.stderr);
});

test("it runs with no repo, no node_modules and no bun", () => {
  const res = runOutsideTheRepo({ DEPLO_RECOVER_CMD: "deplo recover" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /deplo recover owner <username>/);
  assert.match(res.stdout, /deplo recover panel-address/);
});

test("a checkout still names `bun run recover`", () => {
  const res = runOutsideTheRepo({});
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /bun run recover owner <username>/);
});

test("the password prompt survives the first keypress", () => {
  const label = "  New password for @ada: ";
  // Readline redraws `prompt + buffer` on every keypress after clearing the
  // row, so echoing nothing at all erases the prompt and reads as a hang.
  assert.equal(hiddenEcho(label, `${label}hunter2`), label);
  assert.equal(hiddenEcho(label, "hunter2"), "");
});
