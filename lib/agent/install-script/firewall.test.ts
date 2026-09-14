import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// The installer never edits a firewall, it only detects one and prints the command; this drives the real function against stub binaries.
async function firewallFn(): Promise<string> {
  const script = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  const start = script.indexOf("firewall_fix_command() {");
  const end = script.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "firewall_fix_command not found");
  return script.slice(start, end + 2);
}

async function runFirewallCheck(stubs: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-fw-"));
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(dir, name), body, { mode: 0o755 });
  }
  const { stdout } = await promisify(execFile)(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail\nAGENT_PORT=9443\n${await firewallFn()}\nfirewall_fix_command`,
    ],
    { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } },
  );
  await rm(dir, { recursive: true, force: true });
  return stdout;
}

const ufwStub = (...lines: string[]) =>
  `#!/bin/sh\n${lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n")}\n`;

test("a firewall holding the agent port prints the fix, per tool", async () => {
  assert.equal(
    await runFirewallCheck({
      ufw: ufwStub("Status: active", "22/tcp  ALLOW  Anywhere"),
    }),
    "ufw allow 9443/tcp",
  );
  assert.equal(
    await runFirewallCheck({
      "firewall-cmd": `#!/bin/sh\ncase "$1" in --state) exit 0 ;; --list-ports) echo "80/tcp 443/tcp" ;; esac\n`,
    }),
    "firewall-cmd --permanent --add-port=9443/tcp && firewall-cmd --reload",
  );
});

test("a firewall that already allows the agent port stays quiet", async () => {
  const cases: Record<string, string>[] = [
    { ufw: ufwStub("Status: active", "9443/tcp  ALLOW  Anywhere") },
    { ufw: ufwStub("Status: inactive") },
    {},
  ];
  for (const stubs of cases) {
    assert.equal(await runFirewallCheck(stubs), "");
  }
});

test("a port that merely CONTAINS the agent port is not a match", async () => {
  assert.equal(
    await runFirewallCheck({
      ufw: ufwStub("Status: active", "19443/tcp  ALLOW  Anywhere"),
    }),
    "ufw allow 9443/tcp",
  );
});

// A real `ufw status` prints progressively: `grep -q` closed the pipe mid-write and under `pipefail` the SIGPIPE read as "no firewall".
test("a firewall that writes slowly is still read, not lost to SIGPIPE", async () => {
  assert.equal(
    await runFirewallCheck({
      ufw: `#!/bin/sh\necho "Status: active"\nsleep 0.05\necho "22/tcp  ALLOW  Anywhere"\n`,
    }),
    "ufw allow 9443/tcp",
  );
});
