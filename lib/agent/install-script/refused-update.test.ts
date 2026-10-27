import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { refusalReason, UPDATE_REFUSED } from "../../db/update-stops";
import { bash, shellFn } from "./install-script-test-helpers";

const A = "0.6.0";
const B = "0.7.0";
// The one line a release that refuses to start logs, once per restart (ADR-0041).
const REFUSAL = refusalReason(A);
const IMAGE = (v: string) => `ghcr.io/deplocloud/deplo:${v}`;

// The failed version's container: its log until `up -d` recreates it, then a fresh one.
async function rollBack(opts: {
  logs: string[];
  comesBack?: boolean;
  then?: string;
}) {
  const dir = await mkdtemp(join(tmpdir(), "deplo-rollback-"));
  try {
    await writeFile(
      join(dir, "docker-compose.yml"),
      `services:\n  deplo:\n    image: ${IMAGE(B)}\n`,
    );
    await writeFile(join(dir, "logs"), opts.logs.join("\n") + "\n");
    const fns = await Promise.all(
      ["roll_back_update", "panel_started"].map((n) =>
        shellFn("install.sh", n),
      ),
    );
    return await bash(`set -Eeuo pipefail
trap 'echo "on_err line $LINENO"' ERR
exec 9>/dev/null
DEPLO_DIR=${dir}; ENV_FILE=${dir}/.env; DUMP_PATH=""
REFUSED_NOTE=${dir}/data/refused-update
DEPLO_VERSION=${B}; DEPLO_IMAGE=${IMAGE(B)}; PREV_IMAGE=${IMAGE(A)}
warn() { echo "warn: $1"; }; note() { echo "note: $1"; }; ok() { echo "ok: $1"; }
state_set() { echo "state $1=$2"; }
docker() {
  case "$*" in
    *" logs "*) cat ${dir}/logs >&2 ;;
    *" up -d"*) : >${dir}/logs ;;
  esac
}
wait_for_panel() { ${opts.comesBack === false ? "return 1" : "return 0"}; }
${fns.join("\n")}
roll_back_update && echo "rolled back" || echo "rollback failed"
${opts.then ?? ""}
echo "--- note"; cat ${dir}/data/refused-update 2>/dev/null || echo "(none)"
echo "--- compose"; grep 'image:' ${dir}/docker-compose.yml
`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const noteOf = (out: string) =>
  out.split("--- note\n")[1].split("--- compose")[0];

test("a refused update goes back to the previous version and leaves the panel the version and the reason", async () => {
  const out = await rollBack({
    logs: [
      `deplo-1  | ${UPDATE_REFUSED}${refusalReason("0.5.0")}`,
      `deplo-1  | ${UPDATE_REFUSED}${REFUSAL}`,
      `deplo-1  | Error: An error occurred while loading instrumentation hook: ${REFUSAL}`,
      `deplo-1  | 2026-10-27T14:00:05.120Z ${UPDATE_REFUSED}${REFUSAL}`,
      "deplo-1  |     at migrateOnBoot (/app/server.js:1:1)",
    ],
  });
  assert.match(out, /^rolled back$/m);
  assert.ok(out.includes(`\nnote: ${REFUSAL}\n`), out);
  assert.ok(out.endsWith(`--- compose\n    image: ${IMAGE(A)}\n`), out);
  const note = noteOf(out);
  assert.ok(note.startsWith(`version=${B}\nreason=${REFUSAL}\nat=`), note);
  assert.match(note, /\nat=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
});

test("a version that crashed without refusing still leaves a note, in plain words", async () => {
  const out = await rollBack({
    logs: ["deplo-1  | Error: relation already exists"],
    comesBack: false,
  });
  assert.match(out, /^rollback failed$/m);
  assert.ok(
    noteOf(out).startsWith(
      `version=${B}\nreason=The new version did not start, so Deplo went back to the one that was running.\nat=`,
    ),
  );
});

test("the note stays until an update succeeds", async () => {
  const out = await rollBack({
    logs: [`${UPDATE_REFUSED}${REFUSAL}`],
    then: "DEPLO_VERSION=0.6.0; panel_started",
  });
  assert.match(out, /^state version=0\.6\.0$/m);
  assert.equal(noteOf(out), "(none)\n");
});
