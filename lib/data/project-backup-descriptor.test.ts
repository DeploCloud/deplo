import { test } from "node:test";
import assert from "node:assert/strict";

import {
  namedVolumeHostNames,
  composeStackVolumeHostNames,
  serviceMoveVolumeNames,
  assertSafeVolumeNames,
} from "./project-backup-descriptor";
import type { VolumeMount } from "../types";

/**
 * The descriptor's volume-name resolution is the load-bearing correctness point
 * of project backup: the agent tars/wipes each name VERBATIM (`-v <name>:/v`), so
 * a wrong name silently backs up nothing — or, on restore, wipes the wrong
 * volume. Two render paths produce two naming schemes:
 *
 *  - single-container (renderCompose): each named volume is pinned to
 *    `deplo-<slug>-<name>` via `hostVolumeName`; host + project mounts are NOT
 *    docker named volumes and must be excluded.
 *  - compose-stack (buildComposeStack): the user's `volumes:` pass through
 *    untouched, so Docker Compose names each `deplo-<slug>_<key>` unless an
 *    explicit `name:` (or `external:`) overrides.
 */

const vol = (v: Partial<VolumeMount>): VolumeMount => ({
  id: "vol_x",
  name: "data",
  mountPath: "/data",
  readOnly: false,
  ...v,
});

test("named volumes → deplo-<slug>-<name>, host + project mounts excluded", () => {
  const volumes: VolumeMount[] = [
    vol({ name: "pgdata", type: "named" }),
    vol({ name: "cache" }), // type absent ⇒ named (back-compat)
    vol({ type: "host", name: "ignored", hostPath: "/srv/shared" }),
    vol({ type: "service", name: "cfg", projectPath: "config" }),
  ];
  assert.deepEqual(namedVolumeHostNames("my-app", volumes), [
    "deplo-my-app-pgdata",
    "deplo-my-app-cache",
  ]);
});

test("named volume resolution tolerates null/empty", () => {
  assert.deepEqual(namedVolumeHostNames("my-app", null), []);
  assert.deepEqual(namedVolumeHostNames("my-app", []), []);
});

test("compose-stack: a bare volume key → deplo-<slug>_<key>", () => {
  const yaml = `
services:
  web:
    image: nginx
    volumes:
      - dbdata:/var/lib/data
volumes:
  dbdata: {}
`;
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), ["deplo-shop_dbdata"]);
});

test("compose-stack: a null volume spec → deplo-<slug>_<key>", () => {
  // `volumes:\n  dbdata:` parses dbdata as null, the most common shape.
  const yaml = `
volumes:
  dbdata:
  cache:
`;
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), [
    "deplo-shop_dbdata",
    "deplo-shop_cache",
  ]);
});

test("compose-stack: an explicit name: wins verbatim", () => {
  const yaml = `
volumes:
  dbdata:
    name: my-pinned-volume
`;
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), ["my-pinned-volume"]);
});

test("compose-stack: external volume is referenced by key, never project-prefixed", () => {
  const yaml = `
volumes:
  shared:
    external: true
  alsoshared:
    external:
      name: legacy-vol
`;
  // `external: true` with no name ⇒ the bare key; `external: { name }` ⇒ that name.
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), ["shared", "legacy-vol"]);
});

test("compose-stack: no top-level volumes → empty", () => {
  const yaml = `
services:
  web:
    image: nginx
`;
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), []);
});

/* ------------------------------------------------------------------ */
/* Service MOVE volume enumeration (excludes external volumes)         */
/* ------------------------------------------------------------------ */

// A minimal Service shaped just enough for serviceMoveVolumeNames (usesComposeStack
// + slug + volumes). Cast keeps the test focused on the enumeration logic.
const composeService = (slug: string) =>
  ({
    slug,
    source: "compose",
    compose: "services:\n  web:\n    image: nginx\n",
    repo: null,
    dockerImage: null,
    volumes: [],
  }) as unknown as Parameters<typeof serviceMoveVolumeNames>[0];

const singleImageService = (slug: string, volumes: VolumeMount[]) =>
  ({
    slug,
    source: "docker-image",
    compose: null,
    repo: null,
    dockerImage: "nginx",
    volumes,
  }) as unknown as Parameters<typeof serviceMoveVolumeNames>[0];

test("serviceMoveVolumeNames (compose): owns volumes are copied, external EXCLUDED", () => {
  const yaml = `
volumes:
  dbdata: {}
  cache:
  shared:
    external: true
  legacy:
    external:
      name: legacy-vol
  pinned:
    name: my-pinned-volume
`;
  // Contrast with backup (composeStackVolumeHostNames) which INCLUDES externals: a
  // move must NOT relocate a volume Deplo doesn't own.
  assert.deepEqual(serviceMoveVolumeNames(composeService("shop"), yaml), [
    "deplo-shop_dbdata",
    "deplo-shop_cache",
    "my-pinned-volume",
  ]);
});

test("serviceMoveVolumeNames (single-container): named volumes, host mounts excluded", () => {
  const volumes: VolumeMount[] = [
    vol({ name: "pgdata", type: "named" }),
    vol({ name: "hostbind", type: "host", hostPath: "/srv/x" }),
  ];
  // The rendered YAML is irrelevant for a single-container service (no compose
  // volumes:), so pass "".
  assert.deepEqual(serviceMoveVolumeNames(singleImageService("api", volumes), ""), [
    "deplo-api-pgdata",
  ]);
});

test("serviceMoveVolumeNames (compose): no volumes → empty", () => {
  assert.deepEqual(
    serviceMoveVolumeNames(composeService("shop"), "services:\n  web:\n    image: nginx\n"),
    [],
  );
});

test("compose-stack: malformed YAML → empty (never throws)", () => {
  assert.deepEqual(composeStackVolumeHostNames("shop", ":::not yaml:::\n  - ["), []);
  assert.deepEqual(composeStackVolumeHostNames("shop", ""), []);
});

/* ------------------------------------------------------------------ */
/* Volume-name safety (mirrors the agent's volumeNamePattern)          */
/* ------------------------------------------------------------------ */

test("assertSafeVolumeNames accepts the names the renderers actually produce", () => {
  assert.doesNotThrow(() =>
    assertSafeVolumeNames("my-app", [
      "deplo-my-app-pgdata", // single-container (hyphens)
      "deplo-my-app_dbdata", // compose-stack default (underscore)
      "my-pinned-volume", // explicit name
      "legacy.vol", // dots allowed
    ]),
  );
});

test("assertSafeVolumeNames rejects an interpolated compose name with guidance", () => {
  assert.throws(
    () => assertSafeVolumeNames("shop", ["${VOLUME_NAME}"]),
    /compose variable/i,
  );
  assert.throws(
    () => assertSafeVolumeNames("shop", ["deplo-shop_${PROJECT}"]),
    /compose variable/i,
  );
});

test("assertSafeVolumeNames rejects names the agent's pattern forbids", () => {
  // Leading _/-/. and '..' are all rejected by ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$.
  assert.throws(() => assertSafeVolumeNames("shop", ["_shared"]), /valid Docker volume name/i);
  assert.throws(() => assertSafeVolumeNames("shop", ["-legacy"]), /valid Docker volume name/i);
  assert.throws(() => assertSafeVolumeNames("shop", [".hidden"]), /valid Docker volume name/i);
  assert.throws(() => assertSafeVolumeNames("shop", ["a/b"]), /valid Docker volume name/i);
  assert.throws(() => assertSafeVolumeNames("shop", ["a..b"]), /valid Docker volume name/i);
});
