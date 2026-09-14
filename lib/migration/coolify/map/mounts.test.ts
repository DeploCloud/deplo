import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyMounts } from "./mounts";
import { mapMounts } from "../../map/mounts";

test("coolifyMounts splits volumes, binds and files", () => {
  const { mounts, notes } = coolifyMounts({
    persistent_storages: [
      { uuid: "s1", name: "app-data-ewc08w0", mount_path: "/app/storage" },
      { uuid: "s2", mount_path: "/etc/thing", host_path: "/srv/thing" },
      { uuid: "s3", name: "no-path" },
    ],
    file_storages: [
      { uuid: "f1", mount_path: "/etc/nginx/nginx.conf", content: "server {}" },
      { uuid: "f2", mount_path: "/var/lib/blobs", is_directory: true },
      { uuid: "f3", mount_path: "/etc/secret.conf" },
    ],
  });

  assert.deepEqual(
    mounts.map((m) => [m.type, m.volumeName ?? m.hostPath ?? m.filePath]),
    [
      ["volume", "app-data-ewc08w0"],
      ["bind", "/srv/thing"],
      ["file", "nginx.conf"],
    ],
  );
  // A directory and a file whose bytes did not come are both said out loud.
  assert.equal(notes.length, 2);
  assert.match(notes[0], /mounted DIRECTORY/);
  assert.match(notes[1], /did not come with its contents/);
});

test("coolifyMounts sends each storage down the channel that can carry it", () => {
  // Coolify files EVERY bind mount as a "file storage" and `fs_path` is the only column saying where it is on the host: unread, a directory and a binary file were dropped by BOTH channels.
  const { mounts, notes } = coolifyMounts({
    file_storages: [
      {
        uuid: "f1",
        fs_path: "/srv/site/nginx.conf",
        mount_path: "/etc/nginx/nginx.conf",
        content: "server {}",
      },
      {
        uuid: "f2",
        fs_path: "/srv/site/data",
        mount_path: "/data",
        is_directory: true,
      },
      {
        uuid: "f3",
        fs_path: "/srv/site/app.db",
        mount_path: "/app/app.db",
        content: "SQLite\u0000fmt",
      },
      {
        uuid: "f4",
        fs_path: "/etc/localtime",
        mount_path: "/etc/localtime",
        content: "TZif2\u0000\u0000",
      },
      { uuid: "f5", fs_path: "/srv/site/big.bin", mount_path: "/app/big.bin" },
      // No fs_path at all: nothing can carry it, and that has to be said.
      { uuid: "f6", mount_path: "/app/orphan", is_directory: true },
    ],
  });

  assert.deepEqual(
    mounts.map((m) => [m.type, m.type === "file" ? m.filePath : m.hostPath]),
    [
      ["file", "nginx.conf"],
      ["bind", "/srv/site/data"],
      ["bind", "/srv/site/app.db"],
      ["bind", "/srv/site/big.bin"],
    ],
  );
  // The machine's own file is not worth a line; the one nothing can carry is.
  assert.deepEqual(notes, [
    "/app/orphan is a mounted DIRECTORY on {panel} and it named no path on the host, so nothing of it could be copied.",
  ]);
});

// The name on the host has to stay whole - it is what the data copy reads - and the name the owner sees has to lose the panel's own id.
test("a volume keeps its host name and loses the panel's id", () => {
  const uuid = "q70abqiwnol18hhjwtxp1hnf";
  const { mounts } = coolifyMounts(
    {
      persistent_storages: [
        { uuid: "s1", name: `${uuid}-tinydata`, mount_path: "/data" },
        { uuid: "s2", name: `${uuid}_underscored`, mount_path: "/var/lib/x" },
        { uuid: "s3", name: "chosen-by-hand", mount_path: "/srv" },
      ],
    },
    uuid,
  );
  assert.deepEqual(
    mounts.map((m) => [m.volumeName, m.volumeAlias]),
    [
      [`${uuid}-tinydata`, "tinydata"],
      [`${uuid}_underscored`, "underscored"],
      ["chosen-by-hand", null],
    ],
  );

  // And it is the alias that becomes the volume this app mounts here.
  const { value } = mapMounts(mounts, { isCompose: false });
  assert.deepEqual(
    value.volumes.map((v) => v.name),
    ["tinydata", "underscored", "chosen-by-hand"],
  );
});

test("a file storage says where it is on the host", () => {
  const { mounts } = coolifyMounts({
    file_storages: [
      {
        uuid: "f1",
        fs_path: "/srv/mxb1/single.conf",
        mount_path: "/srv/mxb1/single.conf",
        content: "a = 1",
      },
    ],
  });
  assert.equal(mounts[0]!.type, "file");
  assert.equal(mounts[0]!.hostPath, "/srv/mxb1/single.conf");
});
