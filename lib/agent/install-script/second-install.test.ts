import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

// One machine, one server, caught on the machine rather than by its address (ADR-0050).
async function check(
  files: string[],
  env: { importOnly?: boolean; reinstall?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-second-install-"));
  for (const f of files) await writeFile(join(dir, f), "x");
  const out = await bash(
    `set -euo pipefail
AGENT_DATA=${dir}; IMPORT_ONLY=${env.importOnly ? 1 : 0}
${env.reinstall ? "export DEPLO_REINSTALL=1" : "unset DEPLO_REINSTALL"}
ok() { echo "OK $1"; }; pf_fail() { echo "FAIL $1 | $2"; }
${await shellFn("install-agent.sh", "second_install_check")}
second_install_check
`,
    dir,
  );
  await rm(dir, { recursive: true, force: true });
  return out;
}

test("a new server's install on a machine that already is one stops and says how to proceed", async () => {
  const out = await check(["agent.crt", "agent.key"]);
  assert.match(
    out,
    /^FAIL This machine is already connected to Deplo as a server\. \| .*Reinstall on that server's page.*--force\.$/m,
  );
});

test("a reinstall of the same server and a fresh machine go ahead", async () => {
  assert.equal(await check(["agent.crt"], { reinstall: true }), "");
  assert.equal(await check([]), "");
  // A migration source keeps its own check: an agent of another Deplo.
  assert.equal(await check(["agent.crt"], { importOnly: true }), "");
});

test("a machine the panel refused as a copy gets its own identity without --force", async () => {
  const out = await check(["agent.crt", "identity-in-use"]);
  assert.match(out, /^OK This machine is a copy of another server$/m);
  assert.doesNotMatch(out, /FAIL/);
});
