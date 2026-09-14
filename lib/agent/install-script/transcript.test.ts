import { test } from "node:test";
import assert from "node:assert/strict";

import { bash, shellFn } from "./install-script-test-helpers";

// A `set -u` violation is a shell error, not a failed command, so installs died on a bare "unbound variable" with no transcript and no next step.
test("a fatal shell error still names the transcript", async () => {
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const harness = (file: string, body: string) => `set -Eeuo pipefail
UI_ACTION=install; UI_PHASE="Reverse proxy"; UI_LOG=/tmp/deplo-test.log; UI_TTY=0
spin_kill() { :; }; blank() { :; }
err() { printf 'ERR %s\\n' "$1"; }; note() { printf 'NOTE %s\\n' "$1"; }
UI_ERR_SEEN=0
__CLEANUP__
__ON_ERR__
trap 'ui_cleanup' EXIT
trap 'on_err $LINENO' ERR
${body}`;

  for (const file of ["install.sh", "install-agent.sh", "uninstall.sh"]) {
    const script = harness(file, "")
      .replace("__CLEANUP__", await shellFn(file, "ui_cleanup"))
      .replace("__ON_ERR__", await shellFn(file, "on_err"));

    const fatal = await bash(
      `bash -c ${quote(`${script}\necho "$NEVER_SET"`)} 2>&1 || true`,
    );
    assert.match(fatal, /unbound variable/, file);
    assert.match(
      fatal,
      /ERR The install failed during: Reverse proxy \(exit 1\)\./,
      file,
    );
    assert.match(fatal, /NOTE Full transcript: \/tmp\/deplo-test\.log/, file);

    // A failed command still reports through the ERR trap, and still says WHERE.
    const failed = await bash(
      `bash -c ${quote(`${script}\nfalse`)} 2>&1 || true`,
    );
    assert.match(
      failed,
      /ERR The install failed during: Reverse proxy \(line \d+, exit 1\)\./,
      file,
    );
    // Reported once, not once per trap.
    assert.equal(failed.match(/ERR The install failed/g)?.length, 1, file);
  }
});

test("spin_ok renders the caller's detail AND the elapsed time", async () => {
  for (const file of ["install.sh", "install-agent.sh"]) {
    const out = await bash(`set -euo pipefail
UI_SPIN_MSG="the spinner's own message"
spin_elapsed() { printf '80s'; }
spin_kill() { :; }
ok() { printf '%s|%s\\n' "$1" "\${2:-}"; }
${await shellFn(file, "spin_ok")}
spin_ok "Old platform and its apps stopped" "nothing of it was removed"
spin_ok "no detail, only the clock"
`);
    assert.equal(
      out,
      "Old platform and its apps stopped|nothing of it was removed (80s)\n" +
        "no detail, only the clock|80s\n",
      `${file}: spin_ok dropped its second argument`,
    );
  }
});
