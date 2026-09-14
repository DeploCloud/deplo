import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeBuildReachesHost,
  composeHostReach,
  composeNeedsHostPrivileges,
  composeUsesExternalMerge,
} from "./host-privileges";
import { composeMountsForeignStorage } from "./volumes";

test("composeNeedsHostPrivileges: every escape shape is caught", () => {
  const shapes = [
    "    privileged: true",
    '    cap_add: ["SYS_ADMIN"]',
    "    pid: host",
    "    ipc: host",
    "    userns_mode: host",
    '    devices: ["/dev/sda:/dev/sda"]',
    '    security_opt: ["apparmor:unconfined"]',
    "    cgroup_parent: /custom",
    '    device_cgroup_rules: ["c 1:3 mr"]',
  ];
  for (const line of shapes) {
    const yaml = `services:\n  app:\n    image: nginx\n${line}`;
    assert.equal(
      composeNeedsHostPrivileges(yaml),
      true,
      `not caught: ${line.trim()}`,
    );
  }
});

test("composeNeedsHostPrivileges: hardening is never gated", () => {
  const yaml = `services:\n  app:\n    image: nginx\n    security_opt: ["no-new-privileges:true"]\n    cap_drop: ["ALL"]\n    read_only: true`;
  assert.equal(composeNeedsHostPrivileges(yaml), false);
});

test("composeNeedsHostPrivileges: an unconfining security_opt IS gated", () => {
  const yaml = `services:\n  app:\n    image: nginx\n    security_opt: ["no-new-privileges:true", "seccomp:unconfined"]`;
  assert.equal(composeNeedsHostPrivileges(yaml), true);
});

test("composeNeedsHostPrivileges: an ordinary stack asks for nothing", () => {
  const yaml = `services:
  web:
    image: nginx:1.27
    privileged: false
    cap_add: []
    volumes:
      - ./conf:/etc/nginx
    ports:
      - "8080:80"
  worker:
    image: redis:7`;
  assert.equal(composeNeedsHostPrivileges(yaml), false);
});

test("composeNeedsHostPrivileges: pid/ipc/network_mode container: escapes (C-1)", () => {
  for (const line of [
    '    pid: "container:x"',
    '    ipc: "container:x"',
    '    network_mode: "container:x"',
  ]) {
    const yaml = `services:\n  app:\n    image: nginx\n${line}`;
    assert.equal(
      composeNeedsHostPrivileges(yaml),
      true,
      `not caught: ${line.trim()}`,
    );
  }
});

test("composeNeedsHostPrivileges: unparseable YAML is not a detection", () => {
  assert.equal(composeNeedsHostPrivileges("services: [oops"), false);
  assert.equal(composeNeedsHostPrivileges(""), false);
});

test("composeNeedsHostPrivileges: env_file is gated by its PATH, like a bind", () => {
  for (const ef of ["/data/stacks/victim.env", "../victim/.env"]) {
    const yaml = `services:\n  a:\n    image: x\n    env_file:\n      - ${ef}`;
    assert.equal(composeNeedsHostPrivileges(yaml), true, `env_file ${ef}`);
  }
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    env_file:\n      - path: /etc/secret\n        required: false`,
    ),
    true,
  );
  for (const ef of [".env", "./stack.env", "config/app.env"]) {
    const yaml = `services:\n  a:\n    image: x\n    env_file:\n      - ${ef}`;
    assert.equal(composeNeedsHostPrivileges(yaml), false, `env_file ${ef}`);
  }
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    env_file:\n      - path: .env\n        required: false`,
    ),
    false,
  );
});

test("composeHostReach names what tripped it, so a refusal can too", () => {
  assert.deepEqual(
    composeHostReach(`services:\n  a:\n    image: x\n    privileged: true`),
    ["`privileged`"],
  );
  assert.deepEqual(
    composeHostReach(
      `services:\n  a:\n    image: x\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]`,
    ),
    ["a bind mount of a folder on the server"],
  );
  assert.deepEqual(
    composeHostReach(`services:\n  a:\n    image: x\n    env_file: [.env]`),
    [],
  );
});

test("composeNeedsHostPrivileges: volumes_from container: escapes; a bare service is same-stack", () => {
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    volumes_from:\n      - "container:deplo-victim-web-1"`,
    ),
    true,
  );
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    volumes_from:\n      - db`,
    ),
    false,
  );
});

test("composeNeedsHostPrivileges: cgroup host escapes; cgroup private does not", () => {
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    cgroup: host`,
    ),
    true,
  );
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    cgroup: private`,
    ),
    false,
  );
});

test("the five ungated escapes leave an ordinary compose free (no over-gating)", () => {
  const plain = `services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\nvolumes:\n  data: {}`;
  assert.equal(composeNeedsHostPrivileges(plain), false);
  assert.equal(composeMountsForeignStorage(plain), false);
});

test("oom_kill_disable is a cross-tenant DoS and needs the grant; false does not", () => {
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    oom_kill_disable: true`,
    ),
    true,
  );
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    oom_kill_disable: false`,
    ),
    false,
  );
});

test("composeBuildReachesHost: absolute/ssh/privileged build reaches the host; a relative build is free", () => {
  for (const b of [
    `build:\n      context: /etc`,
    `build: /etc`,
    `build:\n      context: ./app\n      additional_contexts:\n        - h=/root`,
    `build:\n      context: ./app\n      ssh:\n        - default`,
    `build:\n      context: ./app\n      privileged: true`,
  ]) {
    assert.equal(
      composeBuildReachesHost(`services:\n  a:\n    ${b}`),
      true,
      `should flag: ${b}`,
    );
  }
  assert.equal(
    composeBuildReachesHost(`services:\n  a:\n    build: ./app`),
    false,
  );
  assert.equal(
    composeBuildReachesHost(
      `services:\n  a:\n    build:\n      context: ./app\n      dockerfile: Dockerfile`,
    ),
    false,
  );
});

test("gpus, a non-default runtime and extra_hosts host-gateway are host privileges", () => {
  const svc = (body: string) =>
    composeNeedsHostPrivileges(`services:\n  x:\n    image: alpine\n${body}\n`);
  assert.equal(svc("    gpus: all"), true);
  assert.equal(
    svc("    gpus:\n      - driver: nvidia\n        count: all"),
    true,
  );
  assert.equal(svc("    runtime: nvidia"), true);
  assert.equal(svc("    runtime: sysbox-runc"), true);
  assert.equal(svc("    runtime: runc"), false);
  assert.equal(svc('    extra_hosts:\n      - "gw:host-gateway"'), true);
  assert.equal(svc("    extra_hosts:\n      gw: host-gateway"), true);
  assert.equal(svc('    extra_hosts:\n      - "gw:${GW}"'), true);
  assert.equal(svc('    extra_hosts:\n      - "db:10.0.0.9"'), false);
});

test("oom_score_adj is a privilege only when NEGATIVE; group_add and a foreign logging driver always are", () => {
  const svc = (line: string) =>
    composeNeedsHostPrivileges(`services:\n  a:\n    image: x\n${line}`);
  assert.equal(svc("    oom_score_adj: -1000"), true);
  assert.equal(svc("    oom_score_adj: 500"), false);
  assert.equal(svc(`    group_add: ["docker"]`), true);
  assert.equal(
    svc(
      `    logging:\n      driver: syslog\n      options:\n        syslog-address: "tcp://evil:514"`,
    ),
    true,
  );
  assert.equal(
    svc(
      `    logging:\n      driver: json-file\n      options:\n        max-size: 10m`,
    ),
    false,
  );
});

test("composeUsesExternalMerge: extends-file, include, label_file are refused; same-file extends is not", () => {
  assert.equal(
    composeUsesExternalMerge(
      `services:\n  a:\n    image: x\n    extends:\n      file: base.yml\n      service: b`,
    ),
    "extends",
  );
  assert.equal(
    composeUsesExternalMerge(
      `include:\n  - extra.yml\nservices:\n  a:\n    image: x`,
    ),
    "include",
  );
  assert.equal(
    composeUsesExternalMerge(
      `services:\n  a:\n    image: x\n    label_file: ./evil.labels`,
    ),
    "label_file",
  );
  assert.equal(
    composeUsesExternalMerge(
      `services:\n  a:\n    image: x\n    extends:\n      service: b`,
    ),
    null,
  );
  assert.equal(composeUsesExternalMerge(`services:\n  a:\n    image: x`), null);
});
