import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

// Every agent links out to its panel and listens on nothing (ADR-0040), so no firewall is in its way.
const AGENT = `#!/bin/sh\n[ "$1" = --capabilities ] && printf 'deploy.network\\nagent-link\\nhostops\\n' && exit 0\nexit 1\n`;
const ACTIVE_UFW = `#!/bin/sh\necho "Status: active"\necho "22/tcp  ALLOW  Anywhere"\n`;

async function install() {
  const dir = await mkdtemp(join(tmpdir(), "deplo-agent-listener-"));
  await writeFile(join(dir, "deplo-agent"), AGENT, { mode: 0o755 });
  await writeFile(join(dir, "ufw"), ACTIVE_UFW, { mode: 0o755 });
  const out = await bash(
    `set -euo pipefail
exec 9>/dev/null
AGENT_BIN=${dir}/deplo-agent; UNIT=${dir}/deplo-agent.service; AGENT_DATA=/var/lib/deplo-agent
BOOTSTRAP_ENV=$AGENT_DATA/bootstrap.env; AGENT_VERSION=0.6.0
UNIT_AFTER=network-online.target; DOCKER_UNIT_LINES=""
HOST_ROLE=server; URL=https://deplo.example.com; AGENT_STATE=running; PROVISIONED=true
card_open() { echo "CARD $1"; }; card_kv() { echo "  $1: $2"; }; card_close() { :; }
ok() { echo "OK $1"; }; note() { echo "NOTE $1"; }; warn() { echo "WARN $1"; }; err() { echo "ERR $1"; }
${await shellFn("install-agent.sh", "write_agent_unit")}
${await shellFn("install-agent.sh", "print_summary")}
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

test("the agent is installed with no listen address and no word about ports or firewalls", async () => {
  const { out, execStart } = await install();
  assert.doesNotMatch(execStart, /--addr/, execStart);
  assert.match(execStart, /--agent-dir \/var\/lib\/deplo-agent\n/);
  assert.match(
    out,
    /^OK The agent enrolled with https:\/\/deplo\.example\.com\.$/m,
  );
  assert.doesNotMatch(out, /9443|port|firewall|ufw|TCP/i, out);
});

// ADR-0043: canary.47 died by SIGPIPE, a stop systemd takes as clean, and nothing started it again.
test("the agent's unit starts it again on any exit, without a start limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-agent-unit-"));
  await bash(
    `set -euo pipefail
UNIT=${dir}/deplo-agent.service; AGENT_BIN=/usr/local/bin/deplo-agent; AGENT_DATA=/var/lib/deplo-agent
BOOTSTRAP_ENV=$AGENT_DATA/bootstrap.env; UNIT_AFTER=network-online.target; DOCKER_UNIT_LINES=""
${await shellFn("install-agent.sh", "write_agent_unit")}
write_agent_unit
`,
    dir,
  );
  const unit = await readFile(join(dir, "deplo-agent.service"), "utf8");
  await rm(dir, { recursive: true, force: true });
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=1$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
});

test("the install script has no agent port setting and prints no firewall command", async () => {
  const script = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  for (const word of [
    /AGENT_PORT/,
    /--addr\b/,
    /\b9443\b/,
    /\bufw\b/,
    /firewall-cmd/,
    /FIREWALL_FIX/,
  ])
    assert.doesNotMatch(script, word);
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
    // A copy the panel refused: the new identity is its own (ADR-0050).
    "identity-in-use",
    // The cluster network key of the server it was copied from.
    "cluster-mesh.json",
  ])
    await writeFile(join(dir, f), "old");
  // The leader that ran there: its key opens that server's bundles, its events are that server's history.
  await mkdir(join(dir, "cluster", "leader", "bundles"), { recursive: true });
  for (const f of ["leader.key", "events.jsonl", "epochs.json"])
    await writeFile(join(dir, "cluster", "leader", f), "old");
  await writeFile(join(dir, "build-cache.salt"), "kept");
  await bash(`set -euo pipefail
exec 9>/dev/null
AGENT_DATA=${dir}
systemctl() { :; }; step() { :; }; ok() { :; }
${await shellFn("install-agent.sh", "clear_old_materials")}
clear_old_materials
`);
  const left = await readdir(dir, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(left.sort(), ["build-cache.salt", "cluster"]);
});
