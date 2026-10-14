import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

const TOKEN = "hostTokenSecret123";

async function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "deplo-token-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the agent installer takes `-` as: read the token from stdin", async () => {
  const text = await readFile(join(process.cwd(), "install-agent.sh"), "utf8");
  assert.match(text, /^read_token "\$\{ARGS\[0\]:-\}"$/m);
  assert.match(text, /token-stdin/, "the marker install.sh looks for");
  const out = await bash(`set -euo pipefail
${await shellFn("install-agent.sh", "read_token")}
read_token tok-arg; echo "1[$TOKEN]"
read_token - <<< "tok-stdin"; echo "2[$TOKEN]"
printf 'no-newline' | { read_token -; echo "3[$TOKEN]"; }
read_token - </dev/null; echo "4[$TOKEN]"
`);
  assert.equal(out, "1[tok-arg]\n2[tok-stdin]\n3[no-newline]\n4[]\n");
});

test("the panel installer hands this host's token over stdin", async () => {
  await inTmp(async (dir) => {
    const current = join(dir, "current.sh");
    const older = join(dir, "older.sh");
    await writeFile(
      current,
      '# token-stdin\necho "ARGS $*"; IFS= read -r t; echo "STDIN $t"\n',
    );
    await writeFile(older, 'echo "ARGS $*"\n');
    const out = await bash(`set -euo pipefail
HOST_TOKEN=${TOKEN}; AGENT_BOOTSTRAP_URL=http://127.0.0.1:3000
${await shellFn("install.sh", "run_agent_installer")}
run_agent_installer ${current}
run_agent_installer ${older}
`);
    assert.equal(
      out,
      `ARGS - http://127.0.0.1:3000 --quiet\nSTDIN ${TOKEN}\n` +
        `ARGS ${TOKEN} http://127.0.0.1:3000 --quiet\n`,
      "an older panel's installer still gets the token it understands",
    );
  });
});

test("the takeover calls keep the token out of curl's argv and the transcript", async () => {
  await inTmp(async (dir) => {
    const log = join(dir, "curl.log");
    const trace = join(dir, "trace.log");
    await bash(`set -euo pipefail
exec 9>/dev/null
HOST_TOKEN=${TOKEN}; TAKEOVER_API=http://127.0.0.1:3000/api/takeover
curl() { { set +x; } 2>/dev/null; printf 'ARGS %s\\nSTDIN %s\\n' "$*" "$(cat)" >>${log}; printf 204; }
${await shellFn("install.sh", "bearer_header")}
${await shellFn("install.sh", "takeover_get")}
${await shellFn("install.sh", "takeover_post")}
exec 8>${trace}; BASH_XTRACEFD=8; set -x
takeover_get >/dev/null
takeover_post done
`);
    const calls = await readFile(log, "utf8");
    const args = calls.split("\n").filter((l) => l.startsWith("ARGS"));
    assert.equal(args.length, 2);
    for (const line of args) {
      assert.doesNotMatch(line, new RegExp(TOKEN));
      assert.match(line, /-H @-/);
    }
    assert.equal(
      calls.split(`STDIN Authorization: Bearer ${TOKEN}`).length - 1,
      2,
    );
    assert.doesNotMatch(await readFile(trace, "utf8"), new RegExp(TOKEN));
  });
});
