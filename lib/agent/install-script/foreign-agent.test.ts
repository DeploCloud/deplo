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

test("two Deplos on IPv6 addresses are told apart past the first colon", async () => {
  assert.equal(
    await foreignPanel(
      { "bootstrap.env": "DEPLO_BOOTSTRAP_URL=https://[2a12:bec4::1]:3000\n" },
      "https://[2a12:dead::1]/api/agent/bootstrap",
    ),
    "[2a12:bec4::1]",
  );
  assert.equal(
    await foreignPanel(
      { "bootstrap.env": "DEPLO_BOOTSTRAP_URL=https://[2a12:dead::1]:3000\n" },
      "https://[2a12:dead::1]/api/agent/bootstrap",
    ),
    "",
  );
});

test("the update knows this host's own agent when it was enrolled at an IPv6 address", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-agent-env-"));
  try {
    const env = join(dir, "bootstrap.env");
    const fn = (await shellFn("install.sh", "agent_is_ours")).replace(
      "/var/lib/deplo-agent/bootstrap.env",
      env,
    );
    const ours = async (url: string) => {
      await writeFile(env, `DEPLO_BOOTSTRAP_URL=${url}\n`);
      return (
        await bash(
          `SERVER_IP=2a12:bec4::2 TARGET_IP= FALLBACK_HOST= PANEL_HOST=\n${fn}\nagent_is_ours && echo yes || echo no`,
        )
      ).trim();
    };
    assert.equal(await ours("http://[2a12:bec4::2]:3000"), "yes");
    assert.equal(await ours("http://[2a12:bec4::9]:3000"), "no");
    assert.equal(await ours("http://127.0.0.1:3000"), "yes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
