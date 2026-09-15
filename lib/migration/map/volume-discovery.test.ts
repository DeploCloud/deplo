import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeHostMounts,
  composeVolumeHostNames,
  composeVolumeMounts,
  declaredSourceVolumes,
  deploDatabaseVolumeName,
  deploVolumeName,
  sourceVolumesFrom,
} from "./volume-discovery";

test("sourceVolumesFrom keeps named volumes and drops bind mounts", () => {
  const volumes = sourceVolumesFrom({
    Mounts: [
      { Type: "volume", Name: "app_uploads", Destination: "/app/uploads/" },
      { Type: "bind", Source: "/srv/etc", Destination: "/etc/thing" },
      { Type: "volume", Name: "app_uploads", Destination: "/app/uploads" },
      { Type: "volume", Destination: "/anonymous" },
    ],
  });
  assert.deepEqual(volumes, [
    { name: "app_uploads", mountPath: "/app/uploads" },
  ]);
});

test("deploVolumeName knows which volumes carry an explicit name", () => {
  assert.equal(deploVolumeName("web", "uploads", true), "deplo-web-uploads");
  assert.equal(deploVolumeName("web", "uploads", false), "deplo-web_uploads");
  assert.equal(
    deploDatabaseVolumeName("db-main"),
    "deplo-db-main_db-main-data",
  );
});

test("composeVolumeMounts reads the named volumes and where they mount", () => {
  const compose = [
    "services:",
    "  web:",
    "    image: nginx",
    "    volumes:",
    "      - config:/etc/app",
    "      - /srv/host:/host",
    "      - ./rel:/rel",
    "  worker:",
    "    volumes:",
    "      - type: volume",
    "        source: data",
    "        target: /var/data/",
    "      - type: bind",
    "        source: /srv/x",
    "        target: /x",
    "volumes:",
    "  config: {}",
    "  data: {}",
  ].join("\n");
  assert.deepEqual(composeVolumeMounts(compose), [
    { name: "config", mountPath: "/etc/app" },
    { name: "data", mountPath: "/var/data" },
  ]);
});

test("composeVolumeMounts ignores a compose it cannot read", () => {
  assert.deepEqual(composeVolumeMounts("services:\n  web:\n   - : :"), []);
  assert.deepEqual(composeVolumeMounts(""), []);
});

test("declaredSourceVolumes reads a stopped service's volumes from its mounts", () => {
  const out = declaredSourceVolumes({
    kind: "postgres",
    appName: "test2-test-u9vb1j",
    mounts: [
      {
        type: "volume",
        volumeName: "test2-test-u9vb1j-data",
        mountPath: "/var/lib/postgresql/18/docker",
      },
      { type: "file", volumeName: null, mountPath: "/etc/thing.conf" },
      { type: "bind", volumeName: null, mountPath: "/srv/x" },
    ],
  });
  assert.deepEqual(out, [
    {
      name: "test2-test-u9vb1j-data",
      mountPath: "/var/lib/postgresql/18/docker",
    },
  ]);
});

test("declaredSourceVolumes prefixes a compose stack's volumes with its project", () => {
  const out = declaredSourceVolumes({
    kind: "compose",
    appName: "test-alltube-ab12",
    composeFile: [
      "services:",
      "  web:",
      "    volumes:",
      "      - data:/var/lib/app",
      "      - ./local:/etc/app",
      "volumes:",
      "  data:",
    ].join("\n"),
  });
  assert.deepEqual(out, [
    { name: "test-alltube-ab12_data", mountPath: "/var/lib/app" },
  ]);
});

test("composeVolumeHostNames reads the names only the file decides", () => {
  const compose = [
    "volumes:",
    "  plain:",
    "  empty: {}",
    "  pinned:",
    "    name: fixed-on-the-host",
    "  ext:",
    "    external: true",
    "  extName:",
    "    external: true",
    "    name: someone-elses",
    "  legacy:",
    "    external:",
    "      name: old-spelling",
    "  notExternal:",
    "    external: false",
  ].join("\n");
  assert.deepEqual(
    [...composeVolumeHostNames(compose)],
    [
      ["pinned", "fixed-on-the-host"],
      ["ext", "ext"],
      ["extName", "someone-elses"],
      ["legacy", "old-spelling"],
    ],
  );
  assert.equal(composeVolumeHostNames("").size, 0);
  assert.equal(composeVolumeHostNames("services:\n  web:\n   - : :").size, 0);
});

test("declaredSourceVolumes never prefixes a volume the compose pins", () => {
  const out = declaredSourceVolumes({
    kind: "compose",
    appName: "test-stack-ab12",
    composeFile: [
      "services:",
      "  web:",
      "    volumes:",
      "      - data:/var/lib/app",
      "      - ext:/data/ext",
      "      - pinned:/data/pinned",
      "      - dopts:/data/dopts",
      "volumes:",
      "  data:",
      "  ext:",
      "    external: true",
      "  pinned:",
      "    name: chosen-by-hand",
      "  dopts:",
      "    driver_opts:",
      "      type: none",
      "      device: /srv/r9-dopts",
      "      o: bind",
    ].join("\n"),
  });
  assert.deepEqual(out, [
    { name: "test-stack-ab12_data", mountPath: "/var/lib/app" },
    { name: "ext", mountPath: "/data/ext" },
    { name: "chosen-by-hand", mountPath: "/data/pinned" },
    { name: "test-stack-ab12_dopts", mountPath: "/data/dopts" },
  ]);
});

test("declaredSourceVolumes has nothing to say about a service with no volumes", () => {
  assert.deepEqual(
    declaredSourceVolumes({ kind: "application", appName: "x" }),
    [],
  );
});

test("sourceVolumesFrom drops the image's own parent mount", () => {
  const out = sourceVolumesFrom({
    Mounts: [
      {
        Type: "volume",
        Name: "svc-data",
        Destination: "/var/lib/postgresql/18/docker",
      },
      {
        Type: "volume",
        Name: "ff2ec11d77f7e019a1911e354db2112fc211fa2ce18a84529ce4a4ef272cc0d8",
        Destination: "/var/lib/postgresql",
      },
    ],
  });
  assert.deepEqual(out, [
    { name: "svc-data", mountPath: "/var/lib/postgresql/18/docker" },
  ]);
});

test("sourceVolumesFrom keeps siblings that merely share a prefix", () => {
  const out = sourceVolumesFrom({
    Mounts: [
      { Type: "volume", Name: "a", Destination: "/data/db" },
      { Type: "volume", Name: "b", Destination: "/data/dbx" },
    ],
  });
  assert.equal(out.length, 2);
});

test("composeHostMounts resolves a `./x` bind against the stack's directory", () => {
  const source = [
    "services:",
    "  web:",
    "    image: nginx",
    "    volumes:",
    "      - ./content:/usr/share/nginx/html",
    "      - ./nginx.conf:/etc/nginx/nginx.conf",
    "      - /etc/app:/cfg",
    "      - appdata:/var/lib/app",
  ].join("\n");

  assert.deepEqual(composeHostMounts(source), [
    { hostPath: "/etc/app", mountPath: "/cfg" },
  ]);

  assert.deepEqual(composeHostMounts(source, "/data/coolify/services/abc"), [
    {
      hostPath: "/data/coolify/services/abc/content",
      mountPath: "/usr/share/nginx/html",
      stackRelative: true,
    },
    {
      hostPath: "/data/coolify/services/abc/nginx.conf",
      mountPath: "/etc/nginx/nginx.conf",
      stackRelative: true,
    },
    { hostPath: "/etc/app", mountPath: "/cfg" },
  ]);
});
