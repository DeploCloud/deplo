import { test } from "node:test";
import assert from "node:assert/strict";

import {
  namedVolumeHostNames,
  composeStackVolumeHostNames,
  appMoveVolumeNames,
  assertSafeVolumeNames,
} from "./project-backup-descriptor";
import type { VolumeMount } from "../types/container";

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
    vol({ name: "cache" }),
    vol({ type: "host", name: "ignored", hostPath: "/srv/shared" }),
    vol({ type: "app", name: "cfg", projectPath: "config" }),
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
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), [
    "deplo-shop_dbdata",
  ]);
});

test("compose-stack: a null volume spec → deplo-<slug>_<key>", () => {
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
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), [
    "my-pinned-volume",
  ]);
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
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), [
    "shared",
    "legacy-vol",
  ]);
});

test("compose-stack: a user-pinned `deplo-` name is REFUSED (reserved namespace)", () => {
  const yaml = `
volumes:
  sneaky:
    name: deplo-victim-pgdata
`;
  assert.throws(() => composeStackVolumeHostNames("shop", yaml), /reserved/i);
});

test("compose-stack: the app's OWN Storage volume is enumerated, not refused", () => {
  const yaml = `
volumes:
  uploads:
    name: deplo-shop-uploads
  dbdata: {}
`;
  assert.deepEqual(
    composeStackVolumeHostNames("shop", yaml, ["deplo-shop-uploads"]),
    ["deplo-shop-uploads", "deplo-shop_dbdata"],
  );
  assert.throws(
    () => composeStackVolumeHostNames("shop", yaml, ["deplo-shop-other"]),
    /reserved/i,
  );
});

test("compose-stack: no top-level volumes → empty", () => {
  const yaml = `
services:
  web:
    image: nginx
`;
  assert.deepEqual(composeStackVolumeHostNames("shop", yaml), []);
});

const composeService = (slug: string) =>
  ({
    slug,
    source: "compose",
    compose: "services:\n  web:\n    image: nginx\n",
    repo: null,
    dockerImage: null,
    volumes: [],
  }) as unknown as Parameters<typeof appMoveVolumeNames>[0];

const singleImageApp = (slug: string, volumes: VolumeMount[]) =>
  ({
    slug,
    source: "docker-image",
    compose: null,
    repo: null,
    dockerImage: "nginx",
    volumes,
  }) as unknown as Parameters<typeof appMoveVolumeNames>[0];

test("appMoveVolumeNames (compose): owns volumes are copied, external EXCLUDED", () => {
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
  assert.deepEqual(appMoveVolumeNames(composeService("shop"), yaml), [
    "deplo-shop_dbdata",
    "deplo-shop_cache",
    "my-pinned-volume",
  ]);
});

test("appMoveVolumeNames (single-container): named volumes, host mounts excluded", () => {
  const volumes: VolumeMount[] = [
    vol({ name: "pgdata", type: "named" }),
    vol({ name: "hostbind", type: "host", hostPath: "/srv/x" }),
  ];
  assert.deepEqual(appMoveVolumeNames(singleImageApp("api", volumes), ""), [
    "deplo-api-pgdata",
  ]);
});

test("appMoveVolumeNames (compose): the app's own Storage volume moves with it", () => {
  const app = {
    slug: "shop",
    source: "compose",
    compose: "services:\n  web:\n    image: nginx\n",
    repo: null,
    dockerImage: null,
    volumes: [vol({ name: "uploads", type: "named" })],
  } as unknown as Parameters<typeof appMoveVolumeNames>[0];
  const yaml = `
volumes:
  uploads:
    name: deplo-shop-uploads
`;
  assert.deepEqual(appMoveVolumeNames(app, yaml), ["deplo-shop-uploads"]);
});

test("appMoveVolumeNames (compose): no volumes → empty", () => {
  assert.deepEqual(
    appMoveVolumeNames(
      composeService("shop"),
      "services:\n  web:\n    image: nginx\n",
    ),
    [],
  );
});

test("compose-stack: malformed YAML → empty (never throws)", () => {
  assert.deepEqual(
    composeStackVolumeHostNames("shop", ":::not yaml:::\n  - ["),
    [],
  );
  assert.deepEqual(composeStackVolumeHostNames("shop", ""), []);
});

test("assertSafeVolumeNames accepts the names the renderers actually produce", () => {
  assert.doesNotThrow(() =>
    assertSafeVolumeNames("my-app", [
      "deplo-my-app-pgdata",
      "deplo-my-app_dbdata",
      "my-pinned-volume",
      "legacy.vol",
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
  assert.throws(
    () => assertSafeVolumeNames("shop", ["_shared"]),
    /valid Docker volume name/i,
  );
  assert.throws(
    () => assertSafeVolumeNames("shop", ["-legacy"]),
    /valid Docker volume name/i,
  );
  assert.throws(
    () => assertSafeVolumeNames("shop", [".hidden"]),
    /valid Docker volume name/i,
  );
  assert.throws(
    () => assertSafeVolumeNames("shop", ["a/b"]),
    /valid Docker volume name/i,
  );
  assert.throws(
    () => assertSafeVolumeNames("shop", ["a..b"]),
    /valid Docker volume name/i,
  );
});
