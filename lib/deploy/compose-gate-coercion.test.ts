import { test } from "node:test";
import assert from "node:assert/strict";

import { composeTruthy, interpolates } from "./compose-lint/document";
import { composePublishesPorts } from "./compose-lint/host-ports";
import {
  composeBuildReachesHost,
  composeHostPrivilegeKeys,
} from "./compose-lint/host-privileges";
import {
  composeInterpolatedHostname,
  composeJoinsForeignNetwork,
} from "./compose-lint/networks";
import {
  composeHasHostBindMount,
  composeMountsForeignStorage,
} from "./compose-lint/volumes";

const svc = (body: string): string =>
  `services:\n  a:\n    image: alpine\n${body}`;

test("compose's own booleans are true: yes, on, y and a quoted true", () => {
  for (const v of [true, 1, "yes", "Yes", "YES", "on", "y", "1", "true"])
    assert.equal(composeTruthy(v), true, `${String(v)} should read as true`);
  for (const v of [
    false,
    0,
    "no",
    "off",
    "n",
    "false",
    "",
    "banana",
    null,
    undefined,
  ])
    assert.equal(composeTruthy(v), false, `${String(v)} should read as false`);
});

test("`privileged: yes` takes the host grant, exactly like `privileged: true`", () => {
  for (const value of ["yes", "on", "'true'", "1", "true"])
    assert.deepEqual(
      composeHostPrivilegeKeys(svc(`    privileged: ${value}`)),
      ["privileged"],
      `privileged: ${value} was not gated`,
    );
  for (const value of ["false", "no", "off"])
    assert.deepEqual(
      composeHostPrivilegeKeys(svc(`    privileged: ${value}`)),
      [],
    );
});

test("`oom_kill_disable: yes` is the same class and the same grant", () => {
  assert.deepEqual(composeHostPrivilegeKeys(svc("    oom_kill_disable: yes")), [
    "oom_kill_disable",
  ]);
});

test("a privileged BUILD reads yes too", () => {
  assert.equal(
    composeBuildReachesHost(
      svc("    build:\n      context: .\n      privileged: yes"),
    ),
    true,
  );
});

test("`$$` is compose's escape and interpolates nothing", () => {
  assert.equal(interpolates("${HOST}"), true);
  assert.equal(interpolates("$HOST"), true);
  assert.equal(interpolates("/data/$X/y"), true);
  assert.equal(interpolates("$$HOME"), false);
  assert.equal(interpolates("/plain/path"), false);
});

test("an interpolated volume source is a host bind until proven otherwise", () => {
  assert.equal(
    composeHasHostBindMount(svc('    volumes:\n      - "${HOSTPATH}:/host"')),
    true,
  );
  assert.equal(
    composeHasHostBindMount(svc("    volumes:\n      - ${MOUNT}")),
    true,
  );
  assert.equal(
    composeHasHostBindMount(
      svc('    volumes:\n      - source: "${SRC}"\n        target: /x'),
    ),
    true,
  );
  assert.equal(
    composeHasHostBindMount(svc("    volumes:\n      - ./conf:/etc/conf")),
    false,
  );
  assert.equal(
    composeHasHostBindMount(svc('    volumes:\n      - "./${REL}:/etc/conf"')),
    true,
  );
});

test("an interpolated build context, env_file or secret file reaches the server", () => {
  assert.equal(
    composeBuildReachesHost(svc('    build:\n      context: "${CTX}"')),
    true,
  );
  assert.deepEqual(composeHostPrivilegeKeys(svc('    env_file: "${EF}"')), [
    "env_file",
  ]);
  assert.equal(
    composeMountsForeignStorage(
      "services:\n  a:\n    image: alpine\nsecrets:\n  s:\n    file: ${F}\n",
    ),
    true,
  );
});

test("an interpolated namespace or volumes_from is the escape it names", () => {
  assert.deepEqual(composeHostPrivilegeKeys(svc('    pid: "${PID}"')), ["pid"]);
  assert.deepEqual(composeHostPrivilegeKeys(svc('    ipc: "${I}"')), ["ipc"]);
  assert.deepEqual(
    composeHostPrivilegeKeys(svc('    volumes_from:\n      - "${VF}"')),
    ["volumes_from"],
  );
  assert.deepEqual(
    composeHostPrivilegeKeys(svc('    oom_score_adj: "${OOM}"')),
    ["oom_score_adj"],
  );
});

test("`no-new-privileges:false` is the option turned OFF, not a hardening", () => {
  assert.deepEqual(
    composeHostPrivilegeKeys(
      svc("    security_opt:\n      - no-new-privileges:false"),
    ),
    ["security_opt"],
  );
  for (const value of ["no-new-privileges:true", "no-new-privileges"])
    assert.deepEqual(
      composeHostPrivilegeKeys(svc(`    security_opt:\n      - ${value}`)),
      [],
      `${value} must stay free`,
    );
});

test("an interpolated port mapping publishes on the host", () => {
  assert.equal(
    composePublishesPorts(svc('    ports:\n      - "${PORT}:80"')),
    true,
  );
  assert.equal(composePublishesPorts(svc("    expose:\n      - 80")), false);
});

test("a volume pinned with `external: yes` is storage this app does not own", () => {
  assert.equal(
    composeMountsForeignStorage(
      "services:\n  a:\n    image: alpine\nvolumes:\n  data:\n    external: yes\n",
    ),
    true,
  );
  assert.equal(
    composeMountsForeignStorage(
      "services:\n  a:\n    image: alpine\nvolumes:\n  data:\n    external: no\n",
    ),
    false,
  );
});

test("a network joined through a variable is joined all the same", () => {
  const compose =
    "services:\n  a:\n    image: alpine\n    networks:\n      - ${NET}\n" +
    "networks:\n  other:\n    external: true\n    name: someone_default\n";
  assert.equal(composeJoinsForeignNetwork(compose), true);
});

test("an interpolated hostname is refused: it decides which name answers", () => {
  assert.equal(composeInterpolatedHostname(svc("    hostname: ${H}")), "a");
  assert.equal(composeInterpolatedHostname(svc("    hostname: db")), null);
});

test("a privileged lifecycle hook is `privileged:` one level down", () => {
  assert.deepEqual(
    composeHostPrivilegeKeys(
      svc("    post_start:\n      - command: id\n        privileged: yes"),
    ),
    ["post_start"],
  );
  assert.deepEqual(
    composeHostPrivilegeKeys(svc("    post_start:\n      - command: id")),
    [],
  );
});

test("a device RESERVATION hands over host hardware like `devices:` does", () => {
  assert.deepEqual(
    composeHostPrivilegeKeys(
      svc(
        "    deploy:\n      resources:\n        reservations:\n" +
          "          devices:\n            - capabilities: [gpu]",
      ),
    ),
    ["deploy.resources.reservations.devices"],
  );
  assert.deepEqual(
    composeHostPrivilegeKeys(
      svc(
        "    deploy:\n      resources:\n        limits:\n          cpus: '0.5'",
      ),
    ),
    [],
  );
});
