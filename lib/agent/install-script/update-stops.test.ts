import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

// What each tag declares (ADR-0041): the stop it requires, "" for none, null for a release
// from before stops (no `deplo` block at all). A tag left out is not on GitHub.
type Tags = Record<string, string | null>;

const PACKAGE = readFileSync(join(process.cwd(), "package.json"), "utf8");

function packageAt(
  version: string,
  requires: string | null,
  isStop: boolean,
): string {
  const json = PACKAGE.replace(/"version": "[^"]*"/, `"version": "${version}"`);
  if (requires === null) return json.replace(/\n {2}"deplo": \{[^}]*\},/, "");
  return json
    .replace(/"requiresStop": "[^"]*"/, `"requiresStop": "${requires}"`)
    .replace(/"updateStop": (true|false)/, `"updateStop": ${isStop}`);
}

async function fakeGitHub(dir: string, tags: Tags, stops: string[]) {
  for (const [v, requires] of Object.entries(tags)) {
    await mkdir(join(dir, `v${v}`), { recursive: true });
    await writeFile(
      join(dir, `v${v}`, "package.json"),
      packageAt(v, requires, stops.includes(v)),
    );
    await writeFile(
      join(dir, `v${v}`, "install.sh"),
      `echo "the v${v} installer ran: $*"; echo "routed from $DEPLO_ROUTED_FROM"\n`,
    );
  }
}

interface Host {
  tags: Tags;
  installed: string;
  // The panel's record of the stops passed: null = no record yet, "down" = can't be read.
  passed: string[] | null | "down";
  version: string;
  mode?: "update" | "install";
  env?: string;
  noInstallers?: boolean;
  // The tags that declare themselves an update stop; the stop alone when left out.
  isStop?: string[];
}

async function route(host: Host): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deplo-stops-"));
  try {
    await fakeGitHub(join(dir, "gh"), host.tags, host.isStop ?? [A]);
    if (host.noInstallers)
      for (const v of Object.keys(host.tags))
        await rm(join(dir, "gh", `v${v}`, "install.sh"));
    const db =
      host.passed === "down"
        ? "down"
        : host.passed === null
          ? "none"
          : host.passed.join(" ");
    const fns = await Promise.all(
      [
        "semver_lt",
        "installed_version",
        "passed_stops",
        "stop_passed",
        "required_stop",
        "release_is_stop",
        "run_stop_installer",
        "route_through_stops",
      ].map((n) => shellFn("install.sh", n)),
    );
    return await bash(`set -Eeuo pipefail
trap 'echo "on_err line $LINENO"' ERR
exec 9>/dev/null
MODE=${host.mode ?? "update"}; DEPLO_DIR=${dir}; DEPLO_VERSION=${host.version}
ORIG_ARGS=(--yes --plain); UI_ERR_SEEN=0; DB="${db}"
${host.env ?? ""}
warn() { echo "warn: $1"; }; note() { echo "note: $1"; }
state_get() { case "$1" in version) printf '%s' "${host.installed}" ;; esac; }
docker() {
  [ "$DB" = down ] && return 1
  case "$*" in
    *to_regclass*) [ "$DB" = none ] || echo passed_update_stops ;;
    *passed_update_stops*) for v in $DB; do echo "$v"; done ;;
  esac
}
curl() {
  local url="" out=""
  while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done
  local f="${dir}/gh/\${url#https://raw.githubusercontent.com/DeploCloud/deplo/}"
  [ -f "$f" ] || return 22
  if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi
}
${fns.join("\n")}
( route_through_stops; echo "installs $DEPLO_VERSION" ) && echo "exit 0" || echo "exit $?"
`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const A = "0.6.0";
const B = "0.7.0";
const stops: Tags = { [B]: A, [A]: "" };

test("below the stop a version asked for by name requires, the stop's own installer runs instead", async () => {
  const out = await route({
    tags: stops,
    installed: "0.4.0",
    passed: null,
    version: B,
  });
  assert.equal(
    out,
    [
      `warn: Deplo v${B} has to come after v${A}, so this update installs v${A} first.`,
      `note: Update again once v${A} has finished getting ready.`,
      `the v${A} installer ran: --yes --plain --version ${A}`,
      `routed from ${B}`,
      "exit 0",
      "",
    ].join("\n"),
  );
});

const installs = (out: string) =>
  out.match(/the v(\S+) installer ran/)?.[1] ??
  out.match(/^installs (\S+)$/m)?.[1];

test("a chain of stops is walked back to the first one this instance has not passed", async () => {
  const chain: Tags = { "0.8.0": B, ...stops };
  const from = (installed: string, passed: string[] | null) =>
    route({ tags: chain, installed, passed, version: "0.8.0" });
  assert.equal(installs(await from("0.4.0", null)), A);
  const onA = await from(A, [A]);
  assert.equal(installs(onA), B);
  assert.match(onA, /Deplo v0\.8\.0 has to come after v0\.7\.0/);
});

test("a stop passed, or a later one, lets the version through as asked; a first install is never routed", async () => {
  for (const passed of [[A], ["0.6.1-canary.2"], ["0.5.0", B]]) {
    const out = await route({ tags: stops, installed: A, passed, version: B });
    assert.equal(out, `installs ${B}\nexit 0\n`, String(passed));
  }
  const canaryOfA = await route({
    tags: stops,
    installed: "0.6.0-canary.4",
    passed: ["0.6.0-canary.4"],
    version: B,
  });
  assert.equal(installs(canaryOfA), A, "a canary of the stop is not the stop");
  assert.equal(
    await route({
      tags: stops,
      installed: "",
      passed: null,
      version: B,
      mode: "install",
    }),
    `installs ${B}\nexit 0\n`,
  );
});

test("on the stop before it has passed, nothing is installed and the reason names what comes first", async () => {
  const out = await route({
    tags: stops,
    installed: A,
    passed: [],
    version: B,
  });
  assert.equal(
    out,
    [
      `warn: Deplo v${B} becomes available once v${A} has finished getting ready.`,
      "note: Settings > Deplo > Updates shows what it is still waiting on.",
      "exit 1",
      "",
    ].join("\n"),
  );
});

test("past a stop it never passed, nothing is installed rather than going back to the stop", async () => {
  const out = await route({
    tags: stops,
    installed: "0.6.5",
    passed: ["0.5.0"],
    version: B,
  });
  assert.equal(
    out,
    `warn: Deplo v${B} has to come after v${A}, which this instance skipped.\nexit 1\n`,
  );
});

test("on a patch of the stop, itself a stop, it is getting ready as the panel says, not skipped", async () => {
  const out = await route({
    tags: { ...stops, "0.6.1": "" },
    isStop: [A, "0.6.1"],
    installed: "0.6.1",
    passed: ["0.5.0"],
    version: B,
  });
  assert.equal(
    out,
    [
      `warn: Deplo v${B} becomes available once v0.6.1 has finished getting ready.`,
      "note: Settings > Deplo > Updates shows what it is still waiting on.",
      "exit 1",
      "",
    ].join("\n"),
  );
});

test("when the panel's record can't be read, the installed version decides, so a broken database never blocks the repair", async () => {
  const down = (installed: string) =>
    route({ tags: stops, installed, passed: "down", version: B });
  assert.equal(installs(await down(A)), B);
  assert.equal(installs(await down("0.4.0")), A);
});

test("when the stop's own installer can't be fetched, this one installs the stop", async () => {
  const out = await route({
    tags: stops,
    installed: "0.4.0",
    passed: null,
    version: B,
    noInstallers: true,
  });
  assert.match(out, /\ninstalls 0\.6\.0\nexit 0\n$/);
});

test("the stop's installer never routes again, and neither does a run with no version to look up", async () => {
  const below = { tags: stops, installed: "0.4.0", passed: null };
  for (const env of [
    "export DEPLO_ROUTED_FROM=0.8.0",
    "DEPLO_SKIP_NET_CHECKS=1",
  ]) {
    const out = await route({ ...below, version: B, env });
    assert.equal(out, `installs ${B}\nexit 0\n`, env);
  }
  assert.equal(
    await route({ ...below, version: "latest" }),
    "installs latest\nexit 0\n",
  );
});

test("every version the installer settles on, asked for or looked up, goes through the stops first", () => {
  const script = readFileSync(join(process.cwd(), "install.sh"), "utf8");
  const derived = [
    ...script.matchAll(
      /^(.*)\n\s*DEPLO_IMAGE="ghcr\.io\/deplocloud\/deplo:\$\{DEPLO_VERSION\}"$/gm,
    ),
  ];
  assert.equal(
    derived.length,
    2,
    "the image follows the version in two places",
  );
  for (const [, before] of derived)
    assert.equal(before.trim(), "route_through_stops");
});

test("a release from before stops, or one whose declaration can't be read, installs as asked", async () => {
  for (const tags of [{ "0.5.0": null }, {}] as Tags[]) {
    const out = await route({
      tags,
      installed: "0.4.0",
      passed: null,
      version: "0.5.0",
    });
    assert.equal(out, "installs 0.5.0\nexit 0\n", JSON.stringify(tags));
  }
});
