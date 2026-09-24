import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync(join(process.cwd(), "install-agent.sh"), "utf8");
const fn = /^git_too_old\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0];

function tooOld(version: string): boolean {
  assert.ok(fn, "git_too_old is gone from install-agent.sh");
  const bin = mkdtempSync(join(tmpdir(), "fake-git-"));
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "${version}"\n`);
  chmodSync(join(bin, "git"), 0o755);
  try {
    execFileSync("bash", ["-c", `${fn}\ngit_too_old`], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    return true;
  } catch {
    return false;
  }
}

test("git older than 2.31 is flagged, the rest is not", () => {
  assert.equal(tooOld("git version 2.30.2"), true);
  assert.equal(tooOld("git version 1.8.3.1"), true);
  assert.equal(tooOld("git version 2.31.0"), false);
  assert.equal(tooOld("git version 2.39.5"), false);
  assert.equal(tooOld("git version 3.0.0"), false);
  assert.equal(tooOld("git version 2.45.1.windows.1"), false);
  assert.equal(tooOld("not git"), false);
});

test("the check runs right after git is ensured", () => {
  assert.match(script, /ensure_git\n\s+if git_too_old; then/);
});
