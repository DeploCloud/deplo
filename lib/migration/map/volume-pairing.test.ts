import { test } from "node:test";
import assert from "node:assert/strict";

import { pairHostMounts, pairVolumes } from "./volume-pairing";

test("the docker socket is never paired as data to copy", () => {
  assert.deepEqual(
    pairHostMounts(
      [
        { hostPath: "/var/run/docker.sock", mountPath: "/var/run/docker.sock" },
        { hostPath: "/etc/dokploy/x", mountPath: "/app/config.json" },
      ],
      [
        { hostPath: "/var/run/docker.sock", mountPath: "/var/run/docker.sock" },
        { hostPath: "/data/x", mountPath: "/app/config.json" },
      ],
    ),
    [
      {
        sourcePath: "/etc/dokploy/x",
        targetPath: "/data/x",
        mountPath: "/app/config.json",
        stackRelative: false,
      },
    ],
  );
});

test("pairVolumes matches on the container path, whatever either side calls them", () => {
  const { value, notes } = pairVolumes(
    [
      { name: "dok_uploads", mountPath: "/app/uploads" },
      { name: "dok_cache", mountPath: "/app/cache" },
    ],
    [
      { name: "deplo-web-cache", mountPath: "/app/cache" },
      { name: "deplo-web-uploads", mountPath: "/app/uploads" },
    ],
  );
  assert.deepEqual(
    value.map((p) => `${p.sourceVolume}->${p.targetVolume}@${p.mountPath}`),
    [
      "dok_uploads->deplo-web-uploads@/app/uploads",
      "dok_cache->deplo-web-cache@/app/cache",
    ],
  );
  assert.deepEqual(notes, []);
});

test("pairVolumes tells two volumes on the same path apart by their alias", () => {
  const { value, notes } = pairVolumes(
    [
      { name: "b5-compose-vol_alphadata", mountPath: "/data" },
      { name: "b5-compose-vol_betadata", mountPath: "/data" },
    ],
    [
      {
        name: "deplo-b5-compose-vol_betadata",
        mountPath: "/data",
        alias: "betadata",
      },
      {
        name: "deplo-b5-compose-vol_alphadata",
        mountPath: "/data",
        alias: "alphadata",
      },
    ],
  );
  assert.deepEqual(
    value.map((p) => `${p.sourceVolume}->${p.targetVolume}`).sort(),
    [
      "b5-compose-vol_alphadata->deplo-b5-compose-vol_alphadata",
      "b5-compose-vol_betadata->deplo-b5-compose-vol_betadata",
    ],
  );
  assert.deepEqual(notes, []);
});

test("pairVolumes lets the longer alias claim its own volume", () => {
  const { value } = pairVolumes(
    [
      { name: "proj_data", mountPath: "/data" },
      { name: "proj_mydata", mountPath: "/data" },
    ],
    [
      { name: "deplo-x_data", mountPath: "/data", alias: "data" },
      { name: "deplo-x_mydata", mountPath: "/data", alias: "mydata" },
    ],
  );
  assert.deepEqual(
    value.map((p) => `${p.sourceVolume}->${p.targetVolume}`).sort(),
    ["proj_data->deplo-x_data", "proj_mydata->deplo-x_mydata"],
  );
});

test("pairVolumes reports both kinds of leftover", () => {
  const { value, notes } = pairVolumes(
    [{ name: "dok_data", mountPath: "/var/data" }],
    [{ name: "deplo-app-other", mountPath: "/srv/other" }],
  );
  assert.deepEqual(value, []);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /no volume of this app mounts that path/);
  assert.match(notes[1], /stays empty/);
});

test("pairVolumes pairs a database 1:1 even when the data dir moved", () => {
  const { value, notes } = pairVolumes(
    [{ name: "dok_pg", mountPath: "/var/lib/postgresql/18/docker" }],
    [{ name: "deplo-db-x_db-x-data", mountPath: "/var/lib/postgresql/data" }],
    { singleData: true },
  );
  assert.equal(value.length, 1);
  assert.equal(value[0].sourceVolume, "dok_pg");
  assert.match(value[0].note!, /data directory moved/);
  assert.match(value[0].note!, /pins the engine's data path/);
  assert.deepEqual(notes, []);
});

test("pairVolumes will not guess for an app, only for the single-data case", () => {
  const source = [{ name: "a", mountPath: "/one" }];
  const target = [{ name: "b", mountPath: "/two" }];
  assert.equal(pairVolumes(source, target).value.length, 0);
  assert.equal(
    pairVolumes(source, target, { singleData: true }).value.length,
    1,
  );
});

test("pairVolumes stays quiet about an unmatched anonymous volume", () => {
  const { notes } = pairVolumes(
    [
      { name: "svc-data", mountPath: "/data/db" },
      {
        name: "935208427f4c92e7cd97bd69fa7bc26dbbc9c8898a6d801dea55ad1f69256f8b",
        mountPath: "/data/configdb",
      },
    ],
    [{ name: "deplo-db-x_db-x-data", mountPath: "/data/db" }],
  );
  assert.deepEqual(notes, []);
});

// The one volume the importer has nowhere to put, on every Mongo that names it.
test("pairVolumes says why a standalone Mongo's configdb has no twin", () => {
  const { notes } = pairVolumes(
    [
      { name: "mongo-data", mountPath: "/data/db" },
      { name: "mongo-configdb", mountPath: "/data/configdb" },
    ],
    [{ name: "deplo-db-x_db-x-data", mountPath: "/data/db" }],
    { singleData: true },
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /sharded cluster/);
});

test("pairHostMounts drops what belongs to the MACHINE, not to the app", () => {
  // The target has its own `/etc/localtime`, and reading one is not a copy that can succeed.
  const host = [
    "/etc/localtime",
    "/etc/timezone",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/machine-id",
    "/etc/passwd",
    "/var/run/docker.sock",
    "/proc/cpuinfo",
    "/sys/fs/cgroup",
  ];
  const paired = pairHostMounts(
    host.map((p) => ({ hostPath: p, mountPath: p })),
    host.map((p) => ({ hostPath: p, mountPath: p })),
  );
  assert.deepEqual(paired, []);
  // A path that only LOOKS like one of them is still the app's own data.
  assert.equal(
    pairHostMounts(
      [{ hostPath: "/etc/localtime.bak", mountPath: "/cfg" }],
      [{ hostPath: "/etc/localtime.bak", mountPath: "/cfg" }],
    ).length,
    1,
  );
  assert.equal(
    pairHostMounts(
      [{ hostPath: "/srv/app/etc/hosts", mountPath: "/cfg" }],
      [{ hostPath: "/srv/app/etc/hosts", mountPath: "/cfg" }],
    ).length,
    1,
  );
});

test("pairHostMounts carries the stack-relative flag off the target", () => {
  const paired = pairHostMounts(
    [
      {
        hostPath: "/data/coolify/services/abc/content",
        mountPath: "/usr/share/nginx/html",
      },
      { hostPath: "/etc/app", mountPath: "/cfg" },
    ],
    [
      {
        hostPath: "/data/stacks/files/web/content",
        mountPath: "/usr/share/nginx/html",
        stackRelative: true,
      },
      { hostPath: "/etc/app", mountPath: "/cfg" },
    ],
  );
  assert.deepEqual(paired, [
    {
      sourcePath: "/data/coolify/services/abc/content",
      targetPath: "/data/stacks/files/web/content",
      mountPath: "/usr/share/nginx/html",
      stackRelative: true,
    },
    {
      sourcePath: "/etc/app",
      targetPath: "/etc/app",
      mountPath: "/cfg",
      stackRelative: false,
    },
  ]);
});
