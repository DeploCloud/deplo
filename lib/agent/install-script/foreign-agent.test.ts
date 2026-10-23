import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

async function foreignPanel(
  files: Record<string, string>,
  url = "https://new.acme.test/api/agent/bootstrap",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deplo-agent-data-"));
  try {
    for (const [name, body] of Object.entries(files))
      await writeFile(join(dir, name), body);
    const fn = await shellFn("install-agent.sh", "foreign_agent_panel");
    return await bash(
      `set -euo pipefail\nAGENT_DATA=${JSON.stringify(dir)}\nURL=${JSON.stringify(url)}\n${fn}\nforeign_agent_panel`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an agent another Deplo enrolled is named, so a migration never takes it over", async () => {
  assert.equal(
    await foreignPanel({
      "bootstrap.env":
        "DEPLO_BOOTSTRAP_URL=https://old.acme.test:3000/api/agent/bootstrap\n",
    }),
    "old.acme.test",
  );
});

test("re-running the same panel's line is not a foreign agent", async () => {
  assert.equal(
    await foreignPanel({
      "bootstrap.env":
        "DEPLO_BOOTSTRAP_URL=https://new.acme.test/api/agent/bootstrap\n",
    }),
    "",
  );
});

test("a host with no agent passes, and an enrolled one with no record is refused", async () => {
  assert.equal(await foreignPanel({}), "");
  assert.equal(await foreignPanel({ "ca.crt": "x" }), "an earlier install");
});
