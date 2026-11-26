import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

// c46: right after a self-update test the installer said canary.59, the binary it put on disk, while the service
// still ran canary.60. The service is restarted onto the installed binary, and the summary names what runs.
async function run(runs: "installed" | "other", body: string) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-running-version-"));
  const fns = await Promise.all(
    ["agent_pid", "sha_of", "run_installed_agent", "agent_version_label"].map(
      (f) => shellFn("install-agent.sh", f),
    ),
  );
  try {
    return await bash(`set -euo pipefail
exec 9>/dev/null
PROC_ROOT=${dir}/proc; PID=41; mkdir -p $PROC_ROOT/41 $PROC_ROOT/42
AGENT_BIN=${dir}/deplo-agent; echo canary.59 > $AGENT_BIN
echo ${runs === "other" ? "canary.60" : "canary.59"} > $PROC_ROOT/41/exe
systemctl() {
  case "$1" in
    show) echo "$PID" ;;
    restart) RESTARTED="RESTARTED "; PID=42; cp $AGENT_BIN $PROC_ROOT/42/exe ;;
  esac
}
RESTARTED=""; AGENT_VERSION=0.5.3-canary.59
AGENT_SHA256=$(sha256sum $AGENT_BIN | awk '{print $1}')
${fns.join("\n")}
${body}
`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an agent left running from another binary is restarted onto the one installed", async () => {
  assert.equal(
    await run(
      "other",
      'run_installed_agent; printf %s "$RESTARTED"; agent_version_label',
    ),
    "RESTARTED v0.5.3-canary.59",
  );
  assert.equal(
    await run(
      "installed",
      'run_installed_agent; printf %s "$RESTARTED"; agent_version_label',
    ),
    "v0.5.3-canary.59",
  );
});

test("an agent Deplo updated during the install is not named by the installed version", async () => {
  assert.equal(
    await run("other", "agent_version_label"),
    "updated by Deplo since v0.5.3-canary.59",
  );
});

// Started by enable --now, a Type=simple service can still be systemd's own fork: it is checked before that.
test("the running agent is checked before the service is started, never right after", async () => {
  const script = await readFile("install-agent.sh", "utf8");
  const check = script.indexOf("\nrun_installed_agent\n");
  const start = script.indexOf("\nsystemctl enable --now deplo-agent ");
  assert.ok(check > 0 && start > 0 && check < start);
});
