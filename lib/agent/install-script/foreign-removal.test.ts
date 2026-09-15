import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bash, shellFn } from "./install-script-test-helpers";

const DOCKER_STUB = `#!/bin/bash
S="$STUB_STATE"
NAMES="oldplatform oldplatform-db app-abc worker-xyz"
short() { case "$1" in oldplatform) echo 4fb8c486a61e ;; oldplatform-db) echo aaaaaaaaaaaa ;;
  app-abc) echo bbbbbbbbbbbb ;; worker-xyz) echo cccccccccccc ;; esac; }
name_of() { local n; for n in $NAMES; do
  case "$1" in "$n"|"$(short "$n")"*) echo "$n"; return 0 ;; esac; done; return 1; }
case "$1" in
  ps) case "$*" in *-aq*) for n in $NAMES; do short "$n"; done ;;
                   *) echo oldplatform; echo oldplatform-db ;; esac ;;
  inspect)
    shift; fmt=""; targets=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2 ;;
      *) targets="$targets $1"; shift ;; esac; done
    for t in $targets; do n="$(name_of "$t")" || exit 1
      case "$fmt" in
        *.Id*) printf '%s%s\\n' "$(short "$n")" "0000000000000000000000000000000000000000000000000000" ;;
        *.managed*) echo true ;;
        *working_dir*) echo ;;
        *RestartPolicy*) printf '%s:%s\\n' "$(cat "$S/$n.pol")" "$(cat "$S/$n.run")" ;;
      esac; done ;;
  update) shift; pol="\${1#--restart=}"; shift
    for c in "$@"; do echo "$pol" > "$S/$(name_of "$c").pol"; done ;;
  stop)  shift; for c in "$@"; do echo 0 > "$S/$(name_of "$c").run"; done ;;
  start) shift; for c in "$@"; do echo 1 > "$S/$(name_of "$c").run"; done ;;
esac
exit 0
`;

const BEFORE = [
  ["oldplatform", "always", "1"],
  ["oldplatform-db", "always", "0"],
  ["app-abc", "unless-stopped", "1"],
  ["worker-xyz", "always", "0"],
];

test("the takeover stops each container once and rolls every policy back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-takeover-"));
  const state = join(dir, "state");
  await bash(`mkdir -p ${state}`);
  await writeFile(join(dir, "docker"), DOCKER_STUB, { mode: 0o755 });
  for (const [n, pol, run] of BEFORE) {
    await writeFile(join(state, `${n}.pol`), `${pol}\n`);
    await writeFile(join(state, `${n}.run`), `${run}\n`);
  }
  const fns = (
    await Promise.all(
      [
        "foreign_containers",
        "foreign_services",
        "foreign_workloads",
        "foreign_ids",
        "foreign_stop",
        "foreign_start",
      ].map((n) => shellFn("install.sh", n)),
    )
  ).join("\n");

  const out = await bash(
    `set -euo pipefail
export STUB_STATE=${state}
STATE_FILE=${dir}/state.env; DEPLO_DIR=${dir}; TAKEOVER=oldplatform
: > "$STATE_FILE"; exec 9>/dev/null
state_set() { printf '%s=%s\\n' "$1" "$2" >> "$STATE_FILE"; }
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" | tail -n1; }
platform_dir() { printf '%s' "${dir}"; }
${fns}
echo "ids=$(foreign_ids | wc -l)"
foreign_stop
echo "recorded=$(state_get foreign_restart | wc -w)"
foreign_start
for n in ${BEFORE.map(([n]) => n).join(" ")}; do
  printf '%s:%s:%s\\n' "$n" "$(cat ${state}/$n.pol)" "$(cat ${state}/$n.run)"
done`,
    dir,
  );
  await rm(dir, { recursive: true, force: true });

  const lines = out.trim().split("\n");
  assert.equal(lines[0], "ids=4");
  assert.equal(lines[1], "recorded=4");
  assert.deepEqual(
    lines.slice(2),
    BEFORE.map(([n, pol, run]) => `${n}:${pol}:${run}`),
    "a rollback must put every restart policy back and start only what was up",
  );
});

const REMOVE_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG"
cmd="$1"; shift
case "$cmd" in
  ps) case "$*" in *-aq*) echo aaaabbbbcccc ;; *) echo the-old-panel ;; esac ;;
  inspect)
    fmt=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2 ;; *) shift ;; esac; done
    case "$fmt" in
      *.Id*) echo aaaabbbbcccc ;;
      *managed*) echo true ;;
      *working_dir*) echo ;;
      *.Mounts*) echo foreign-data; echo deplo-keep ;;
      *NetworkSettings*) echo old-panel-net; echo bridge ;;
    esac ;;
  service) case "$1" in ls) echo dokploy; echo dokploy-postgres ;; esac ;;
  images) echo dokploy/dokploy:latest; echo coollabsio/coolify:latest; echo myapp:latest ;;
esac
exit 0
`;

const REMOVAL_CASES = [
  {
    platform: "dokploy",
    label: "Dokploy",
    expected: [
      "service rm dokploy dokploy-postgres",
      "swarm leave --force",
      "volume rm -f dokploy dokploy-postgres dokploy-redis",
      "network rm dokploy-network",
    ],
    key: false,
  },
  {
    platform: "coolify",
    label: "Coolify",
    expected: ["volume rm -f coolify-db coolify-redis", "network rm coolify"],
    key: true,
  },
];

for (const c of REMOVAL_CASES) {
  test(`removing ${c.label} takes its own infrastructure too`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "deplo-remove-"));
    const log = join(dir, "docker.log");
    const platform = join(dir, "platform-dir");
    const keys = join(dir, ".ssh", "authorized_keys");
    await bash(`mkdir -p ${platform} ${dir}/.ssh && : > ${log}`);
    await writeFile(
      keys,
      "ssh-ed25519 AAAAmine admin@acme.com\nssh-ed25519 AAAAtheirs coolify\n",
    );
    await writeFile(join(dir, "docker"), REMOVE_STUB, { mode: 0o755 });

    const fns = (
      await Promise.all(
        [
          "foreign_containers",
          "foreign_services",
          "foreign_workloads",
          "foreign_ids",
          "platform_own_volumes",
          "platform_own_networks",
          "foreign_networks_of",
          "remove_platform_dir",
          "remove_platform_dir_below",
          "foreign_remove",
        ].map((n) => shellFn("install.sh", n)),
      )
    ).join("\n");

    await bash(
      `set -euo pipefail
export STUB_LOG=${log}
unset HOME
TAKEOVER=${c.platform}; FOREIGN_LABEL=${c.label}; exec 9>/dev/null
blank() { :; }; phase() { :; }; step() { :; }; note() { :; }
spin_start() { :; }; spin_ok() { :; }
state_set() { :; }; takeover_post() { :; }
${fns.replaceAll("${HOME:-/root}", dir)}
platform_dir() { printf '%s' "${platform}"; }
foreign_remove`,
      dir,
    );

    const calls = (await readFile(log, "utf8")).trim().split("\n");
    const left = await readFile(keys, "utf8");
    await rm(dir, { recursive: true, force: true });

    for (const want of c.expected)
      assert.ok(
        calls.includes(want),
        `missing "${want}": ${calls.join(" | ")}`,
      );
    assert.ok(
      !calls.some((x) => x.includes("prune")),
      "the removal must never prune the daemon",
    );
    assert.ok(!calls.some((x) => x.includes("foreign-data")));
    assert.ok(!calls.some((x) => x.includes("deplo-keep")));
    assert.ok(!calls.some((x) => x.includes("myapp:latest")));
    assert.equal(
      left.includes("AAAAtheirs"),
      !c.key,
      "only the removed platform's own key comes out of authorized_keys",
    );
    assert.ok(left.includes("AAAAmine"), "nobody else's key is touched");
  });
}
