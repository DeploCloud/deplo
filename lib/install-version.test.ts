import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(process.cwd(), "install.sh"), "utf8");
const fn = (name: string) =>
  script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"))![0];
const lib = fn("semver_lt") + fn("newest_version");

function bash(body: string): string {
  return execFileSync("bash", ["-c", `set -euo pipefail\n${lib}\n${body}`], {
    encoding: "utf8",
  }).trim();
}

const lt = (a: string, b: string) =>
  bash(`if semver_lt ${a} ${b}; then echo y; else echo n; fi`) === "y";

test("semver_lt orders cores numerically and a canary below its release", () => {
  assert.ok(lt("0.5.0", "0.10.0"));
  assert.ok(lt("0.5.0-canary.9", "0.5.0-canary.23"));
  assert.ok(lt("0.5.0-canary.23", "0.5.0"));
  assert.ok(lt("v0.4.9", "0.5.0-canary.1"));
  assert.ok(!lt("0.5.0", "0.5.0"));
  assert.ok(!lt("0.5.0", "0.5.0-canary.30"));
  assert.ok(!lt("0.5.1", "0.5.0"));
});

test("newest_version picks across stable and canary, ignoring junk", () => {
  assert.equal(
    bash(
      `printf '%s\\n' v0.4.0 v0.5.0-canary.9 v0.5.0-canary.23 nightly v0.5.0-canary.3 | newest_version`,
    ),
    "v0.5.0-canary.23",
  );
  assert.equal(
    bash(`printf '%s\\n' v0.5.0-canary.23 v0.5.0 | newest_version`),
    "v0.5.0",
  );
  assert.equal(bash(`printf '' | newest_version`), "");
});

test("deplo update follows the canary switch and never moves backwards", () => {
  assert.match(script, /select canary_releases from instance_settings/);
  assert.match(script, /semver_lt "\$DEPLO_VERSION" "\$current"/);
});

function resolve(canary: boolean, current: string): string {
  const stubs = `
exec 9>/dev/null
MODE=update
DEPLO_VERSION=latest
DEPLO_DIR=/nonexistent
state_get() { [ "$1" = version ] && echo ${current}; }
docker() { echo ${canary ? "t" : "f"}; }
curl() {
  case "$*" in
    *releases/latest*) echo '{"tag_name": "v0.4.0"}' ;;
    *) printf '%s\\n' '{' '"tag_name": "v0.5.0-canary.30",' '"tag_name": "v0.4.0",' '}' ;;
  esac
}
`;
  return bash(
    `${stubs}\n${fn("canary_channel")}${fn("installed_version")}${fn("resolve_version")}\nresolve_version; echo "$DEPLO_VERSION"`,
  );
}

test("canary on takes the newest pre-release; off never drops a canary to stable", () => {
  assert.equal(resolve(true, "0.5.0-canary.23"), "0.5.0-canary.30");
  assert.equal(resolve(false, "0.5.0-canary.23"), "0.5.0-canary.23");
  assert.equal(resolve(false, "0.3.0"), "0.4.0");
});
