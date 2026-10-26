import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

// The binary the script just installed: one that links (ADR-0040), or the pinned one before it.
const LINKING_AGENT = `#!/bin/sh\n[ "$1" = --capabilities ] && printf 'deploy.network\\nagent-link\\nhostops\\n' && exit 0\nexit 1\n`;
const AGENT_BEFORE_THE_LINK = `#!/bin/sh\necho "flag provided but not defined: $1" >&2\necho "Usage of deplo-agent:" >&2\nexit 2\n`;
const ACTIVE_UFW = `#!/bin/sh\necho "Status: active"\necho "22/tcp  ALLOW  Anywhere"\n`;

async function install(agent: string) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-agent-listener-"));
  await writeFile(join(dir, "deplo-agent"), agent, { mode: 0o755 });
  await writeFile(join(dir, "ufw"), ACTIVE_UFW, { mode: 0o755 });
  const out = await bash(
    `set -euo pipefail
exec 9>/dev/null
AGENT_BIN=${dir}/deplo-agent; UNIT=${dir}/deplo-agent.service; AGENT_DATA=/var/lib/deplo-agent
BOOTSTRAP_ENV=$AGENT_DATA/bootstrap.env; AGENT_PORT=9443; AGENT_VERSION=0.6.0
UNIT_AFTER=network-online.target; DOCKER_UNIT_LINES=""
HOST_ROLE=server; URL=https://deplo.example.com; AGENT_STATE=running; PROVISIONED=true
card_open() { echo "CARD $1"; }; card_kv() { echo "  $1: $2"; }; card_close() { :; }
ok() { echo "OK $1"; }; note() { echo "NOTE $1"; }; warn() { echo "WARN $1"; }; err() { echo "ERR $1"; }
${await shellFn("install-agent.sh", "firewall_fix_command")}
${await shellFn("install-agent.sh", "plan_listener")}
${await shellFn("install-agent.sh", "write_agent_unit")}
${await shellFn("install-agent.sh", "print_summary")}
plan_listener
write_agent_unit
print_summary
`,
    dir,
  );
  const unit = await readFile(join(dir, "deplo-agent.service"), "utf8");
  await rm(dir, { recursive: true, force: true });
  const execStart = unit.slice(
    unit.indexOf("ExecStart="),
    unit.indexOf("Restart="),
  );
  return { out, execStart };
}

test("a linking agent is installed with no listen address and no word about ports or firewalls", async () => {
  const { out, execStart } = await install(LINKING_AGENT);
  assert.doesNotMatch(execStart, /--addr/, execStart);
  assert.match(execStart, /--agent-dir \/var\/lib\/deplo-agent\n/);
  assert.match(
    out,
    /^OK The agent enrolled with https:\/\/deplo\.example\.com\.$/m,
  );
  assert.doesNotMatch(out, /9443|port|firewall|ufw|TCP/i, out);
});

test("an agent from before the link still listens, and still says which firewall rule it needs", async () => {
  const { out, execStart } = await install(AGENT_BEFORE_THE_LINK);
  assert.match(execStart, /--addr 0\.0\.0\.0:9443 \\\n {2}--data-dir \//);
  assert.match(out, /on port 9443/);
  assert.match(out, /^NOTE ufw allow 9443\/tcp$/m);
});

test("a reinstall clears the saved link state with the certificates, so it cannot outlive its panel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-agent-data-"));
  for (const f of [
    "agent.crt",
    "agent.key",
    "ca.crt",
    "link-addresses.json",
    // An agent that closed its own port once it linked.
    "no-listener",
  ])
    await writeFile(join(dir, f), "old");
  await writeFile(join(dir, "build-cache.salt"), "kept");
  await bash(`set -euo pipefail
exec 9>/dev/null
AGENT_DATA=${dir}
systemctl() { :; }; step() { :; }; ok() { :; }
${await shellFn("install-agent.sh", "clear_old_materials")}
clear_old_materials
`);
  const left = await readdir(dir);
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(left, ["build-cache.salt"]);
});
