import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCompose, parseStackVolumes } from "./build";
import type { RoutableDomain } from "../data/domains";

/**
 * Volumes injection into the single-container stack. The load-bearing contract:
 *  1. NO volumes ⇒ output byte-identical to the long-standing stack (so a
 *     reroute of an unchanged routing set never restarts the container).
 *  2. Named volumes ⇒ a service `- alias:/path[:ro]` list + a top-level
 *     `volumes.<alias>.name: deplo-<slug>-<alias>` (host name namespaced).
 *  3. A render→parse round-trip recovers the same {name, mountPath, readOnly}
 *     (the reroute path reads volumes back from the on-disk stack).
 */

const route: RoutableDomain = {
  name: "demo.example.com",
  port: null,
  entrypoint: "websecure",
  tls: true,
  certResolver: "letsencrypt",
  middlewares: [],
  pathPrefix: "",
  stripPrefix: false,
  service: null,
  redirectTo: "",
};

const base = {
  name: "deplo-demo",
  image: "deplo/demo:abc123",
  port: 3000,
  appId: "p1",
  slug: "demo",
  routes: [route],
  env: { FOO: "bar" },
};

test("no volumes: output is byte-identical with [], undefined, and missing key", () => {
  const withMissing = renderCompose(base);
  const withEmpty = renderCompose({ ...base, volumes: [] });
  assert.equal(withEmpty, withMissing);
  // The no-volumes stack must contain no `volumes:` key at all.
  assert.ok(!/\bvolumes:/.test(withMissing), "no volumes: key when empty");
});

test("PORT is injected for a built source (default) but NOT for a prebuilt image", () => {
  // Built sources (git/upload/dockerfile): PORT tells the 12-factor
  // app where Traefik forwards. Default behaviour, so the flag is omitted.
  const built = renderCompose(base);
  assert.match(built, /PORT: "3000"/, "built source gets PORT injected");

  // A prebuilt docker image is deployed as-is — it owns its own listen address,
  // so Deplo must not inject PORT (which would silently override e.g. an :8080
  // image onto :3000). The rest of the env is untouched.
  const image = renderCompose({ ...base, injectPort: false });
  assert.ok(!/\bPORT:/.test(image), "prebuilt image stack carries no PORT env");
  assert.match(image, /FOO: "bar"/, "user env is still rendered");
});

test("named volumes: emits service list + namespaced top-level volume", () => {
  const yaml = renderCompose({
    ...base,
    volumes: [
      { name: "data", mountPath: "/data", readOnly: false },
      { name: "cache", mountPath: "/var/cache", readOnly: true },
    ],
  });
  assert.match(yaml, /\n {6}- data:\/data\n/);
  assert.match(yaml, /\n {6}- cache:\/var\/cache:ro\n/);
  // Top-level volumes block with per-project namespaced host names.
  assert.match(yaml, /\nvolumes:\n {2}data:\n {4}name: deplo-demo-data\n/);
  assert.match(yaml, /\n {2}cache:\n {4}name: deplo-demo-cache\n/);
});

test("read-only flag emits :ro on the mount and not otherwise", () => {
  const ro = renderCompose({
    ...base,
    volumes: [{ name: "ro", mountPath: "/ro", readOnly: true }],
  });
  assert.match(ro, /- ro:\/ro:ro/);
  const rw = renderCompose({
    ...base,
    volumes: [{ name: "rw", mountPath: "/rw", readOnly: false }],
  });
  assert.ok(!/- rw:\/rw:ro/.test(rw));
});

test("render → parseStackVolumes round-trips the mount set", () => {
  const volumes = [
    { name: "data", mountPath: "/data", readOnly: false },
    { name: "cache", mountPath: "/var/cache", readOnly: true },
  ];
  const yaml = renderCompose({ ...base, volumes });
  const parsed = parseStackVolumes(yaml, base.name);
  assert.deepEqual(parsed, [
    { name: "data", mountPath: "/data", readOnly: false },
    { name: "cache", mountPath: "/var/cache", readOnly: true },
  ]);
});

test("parseStackVolumes: empty / missing-service stacks yield []", () => {
  assert.deepEqual(parseStackVolumes("services:\n  deplo-demo:\n    image: x\n", "deplo-demo"), []);
  assert.deepEqual(parseStackVolumes("services: {}", "missing"), []);
});

test("renderCompose emits Docker Compose's `services:` top-level key, never `apps:`", () => {
  // Docker Compose's schema only allows `services:`. A top-level `apps:` (a
  // services→apps vocabulary over-rename) makes the agent's `docker compose up`
  // reject the stack with "additional properties 'apps' not allowed". Pin the
  // real wire contract so the round-trip's self-consistency can't mask a regression.
  const yaml = renderCompose(base);
  assert.match(yaml, /^services:$/m);
  assert.doesNotMatch(yaml, /^apps:/m);
});

test("host bind mount: emits hostPath source and NO top-level volumes entry", () => {
  const yaml = renderCompose({
    ...base,
    volumes: [
      { type: "host", name: "", hostPath: "/srv/data", mountPath: "/data", readOnly: false },
    ],
  });
  // App line binds the host path directly.
  assert.match(yaml, /\n {6}- \/srv\/data:\/data\n/);
  // A host bind is NOT a named volume, so no TOP-LEVEL (column-0) volumes: key is
  // emitted (the service-level `    volumes:` list is still present).
  assert.ok(!/\nvolumes:/.test(yaml), "no top-level volumes block for a pure host bind");
});

test("host bind read-only flag emits :ro", () => {
  const yaml = renderCompose({
    ...base,
    volumes: [
      { type: "host", name: "", hostPath: "/srv/ro", mountPath: "/ro", readOnly: true },
    ],
  });
  assert.match(yaml, /- \/srv\/ro:\/ro:ro/);
});

test("host bind propagation renders as an option, alongside :ro", () => {
  // The whole point of the field: without it docker's rprivate default hands the
  // container a snapshot of the submounts that existed at startup, so a FUSE
  // share or a network disk mounted under the folder later never appears.
  const follows = renderCompose({
    ...base,
    volumes: [
      { type: "host", name: "", hostPath: "/srv/neon", mountPath: "/srv/neon", readOnly: false, propagation: "rslave" },
    ],
  });
  assert.match(follows, /- \/srv\/neon:\/srv\/neon:rslave\n/);

  // Read-only first, then propagation — one comma-separated option list.
  const both = renderCompose({
    ...base,
    volumes: [
      { type: "host", name: "", hostPath: "/srv/neon", mountPath: "/srv/neon", readOnly: true, propagation: "rslave" },
    ],
  });
  assert.match(both, /- \/srv\/neon:\/srv\/neon:ro,rslave\n/);
});

test("propagation round-trips through parseStackVolumes, :ro included", () => {
  // The reroute path re-renders from what it reads back here. Reading the option
  // field as a single word (`flag === "ro"`) dropped BOTH flags off this line,
  // which would have silently re-rendered the mount read-write and rprivate.
  const volumes = [
    { type: "host" as const, name: "", hostPath: "/srv/neon", mountPath: "/srv/neon", readOnly: true, propagation: "rslave" as const },
    { type: "host" as const, name: "", hostPath: "/srv/plain", mountPath: "/plain", readOnly: false },
  ];
  const yaml = renderCompose({ ...base, volumes });
  assert.deepEqual(parseStackVolumes(yaml, base.name), [
    { type: "host", name: "", hostPath: "/srv/neon", mountPath: "/srv/neon", readOnly: true, propagation: "rslave" },
    // No propagation ⇒ the key stays absent, so an untouched mount is unchanged.
    { type: "host", name: "", hostPath: "/srv/plain", mountPath: "/plain", readOnly: false },
  ]);
});

test("mixed named + host: named gets a top-level entry, host does not", () => {
  const yaml = renderCompose({
    ...base,
    volumes: [
      { name: "data", mountPath: "/data", readOnly: false },
      { type: "host", name: "", hostPath: "/srv/h", mountPath: "/h", readOnly: false },
    ],
  });
  assert.match(yaml, /\n {6}- data:\/data\n/);
  assert.match(yaml, /\n {6}- \/srv\/h:\/h\n/);
  // Exactly one named volume in the top-level block.
  assert.match(yaml, /\nvolumes:\n {2}data:\n {4}name: deplo-demo-data\n/);
  assert.ok(!/name: deplo-demo-h\b/.test(yaml), "host bind has no namespaced volume name");
});

test("host bind round-trips through parseStackVolumes as type: host", () => {
  const volumes = [
    { name: "data", mountPath: "/data", readOnly: false },
    { type: "host" as const, name: "", hostPath: "/srv/h", mountPath: "/h", readOnly: true },
  ];
  const yaml = renderCompose({ ...base, volumes });
  const parsed = parseStackVolumes(yaml, base.name);
  assert.deepEqual(parsed, [
    { name: "data", mountPath: "/data", readOnly: false },
    { type: "host", name: "", hostPath: "/srv/h", mountPath: "/h", readOnly: true },
  ]);
});

test("project file mount: source resolves to the project's files dir, NO top-level entry", () => {
  const yaml = renderCompose({
    ...base,
    volumes: [
      { type: "app", name: "", projectPath: "config.toml", mountPath: "/app/config.toml", readOnly: false },
    ],
  });
  // The source is the absolute per-project files dir (…/files/<slug>/<rel>),
  // never a raw "./" that docker would resolve against the stack dir.
  assert.match(yaml, /\n {6}- \/.*\/files\/demo\/config\.toml:\/app\/config\.toml\n/);
  // A project bind, like a host bind, gets NO top-level volumes block.
  assert.ok(!/\nvolumes:/.test(yaml), "no top-level volumes block for a project bind");
});

test("project file mount: nested path and :ro flag render correctly", () => {
  const yaml = renderCompose({
    ...base,
    volumes: [
      { type: "app", name: "", projectPath: "volumes/db/init.sql", mountPath: "/init.sql", readOnly: true },
    ],
  });
  assert.match(yaml, /\n {6}- \/.*\/files\/demo\/volumes\/db\/init\.sql:\/init\.sql:ro\n/);
});

test("project file mount round-trips through parseStackVolumes as type: project", () => {
  const volumes = [
    { name: "data", mountPath: "/data", readOnly: false },
    { type: "app" as const, name: "", projectPath: "config.toml", mountPath: "/app/config.toml", readOnly: false },
  ];
  const yaml = renderCompose({ ...base, volumes });
  const parsed = parseStackVolumes(yaml, base.name);
  assert.deepEqual(parsed, [
    { name: "data", mountPath: "/data", readOnly: false },
    { type: "app", name: "", projectPath: "config.toml", mountPath: "/app/config.toml", readOnly: false },
  ]);
});
