import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

// c46: right after a self-update test the installer said canary.59, the binary it put on disk, while the service
// still ran canary.60. The service is restarted onto the installed binary, and the summary names what runs.
async function run(runs: "installed" | "other", body: string) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-running-version-"));
  const bin = join(dir, "deplo-agent");
  await copyFile("/bin/sleep", bin);
  const fns = await Promise.all(
    ["agent_pid", "sha_of", "run_installed_agent", "agent_version_label"].map(
      (f) => shellFn("install-agent.sh", f),
    ),
  );
  try {
    return await bash(`set -euo pipefail
exec 9>/dev/null
cp /bin/sleep ${dir}/proc-exe
${runs === "other" ? `printf x >> ${dir}/proc-exe` : ""}
${dir}/proc-exe 30 & PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
systemctl() {
  case "$1" in
    show) echo "$PID" ;;
    restart) RESTARTED="RESTARTED "; kill $PID; cp ${bin} ${dir}/proc-exe2; ${dir}/proc-exe2 30 & PID=$! ;;
  esac
}
RESTARTED=""; AGENT_BIN=${bin}; AGENT_VERSION=0.5.3-canary.59
AGENT_SHA256=$(sha256sum ${bin} | awk '{print $1}')
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
