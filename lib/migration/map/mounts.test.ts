import { test } from "node:test";
import assert from "node:assert/strict";

import { mapMounts, volumeLabel } from "./mounts";

test("volumeLabel produces the lowercase-kebab Deplo requires", () => {
  assert.equal(volumeLabel("PG Data", "x"), "pg-data");
  assert.equal(volumeLabel("acme-app_data", "x"), "acme-app-data");
  assert.equal(volumeLabel("///", "fallback"), "fallback");
});

test("mapMounts splits the three Dokploy kinds into Deplo's two writers", () => {
  const { value, notes } = mapMounts(
    [
      {
        mountId: "1",
        type: "file",
        filePath: "./config.toml",
        content: "a = 1",
        mountPath: "",
      },
      {
        mountId: "2",
        type: "volume",
        volumeName: "PG_DATA",
        mountPath: "/var/lib/data",
      },
      {
        mountId: "3",
        type: "bind",
        hostPath: "/srv/uploads",
        mountPath: "/uploads",
      },
    ],
    { isCompose: true },
  );
  assert.deepEqual(value.files, [
    { filePath: "config.toml", content: "a = 1", mountPath: "" },
  ]);
  assert.deepEqual(value.volumes, [
    {
      type: "named",
      name: "pg-data",
      mountPath: "/var/lib/data",
      readOnly: false,
    },
    {
      type: "host",
      name: "uploads",
      hostPath: "/srv/uploads",
      mountPath: "/uploads",
      readOnly: false,
    },
  ]);
  assert.deepEqual(notes, []);
});

// Dokploy writes an APPLICATION's file mount with filePath NULL: the container path is the whole address of the file.
test("mapMounts imports an application's file mount, which has no filePath", () => {
  const { value, notes } = mapMounts(
    [
      {
        mountId: "1",
        type: "file",
        filePath: null,
        content: "<h1>hi</h1>",
        mountPath: "/usr/share/nginx/html/index.html",
      },
    ],
    { isCompose: false },
  );
  assert.deepEqual(value.files, [
    {
      filePath: "index.html",
      content: "<h1>hi</h1>",
      mountPath: "/usr/share/nginx/html/index.html",
    },
  ]);
  // Paired with the Storage "File" entry that mounts it back where it was.
  assert.deepEqual(value.volumes, [
    {
      type: "app",
      name: "index-html",
      projectPath: "index.html",
      mountPath: "/usr/share/nginx/html/index.html",
      readOnly: false,
    },
  ]);
  assert.deepEqual(notes, []);
});

// A compose stack binds its own file (`../files/x` -> `./x`), and a second mount for it would fight that one.
test("mapMounts does not pair a compose stack's file mount with a volume", () => {
  const { value } = mapMounts(
    [
      {
        mountId: "1",
        type: "file",
        filePath: "fix.sh",
        content: "#!/bin/sh",
        mountPath: "/usr/local/bin/fix.sh",
      },
    ],
    { isCompose: true },
  );
  assert.deepEqual(value.files, [
    {
      filePath: "fix.sh",
      content: "#!/bin/sh",
      mountPath: "/usr/local/bin/fix.sh",
    },
  ]);
  assert.deepEqual(value.volumes, []);
});

// The files dir keeps only the last path segment, so two separate files both named app.ini would silently overwrite.
test("mapMounts keeps two file mounts with the same file name apart", () => {
  const { value, notes } = mapMounts(
    [
      {
        mountId: "1",
        type: "file",
        content: "one",
        mountPath: "/etc/a/app.ini",
      },
      {
        mountId: "2",
        type: "file",
        content: "two",
        mountPath: "/etc/b/app.ini",
      },
    ],
    { isCompose: false },
  );
  assert.deepEqual(value.files, [
    { filePath: "app.ini", content: "one", mountPath: "/etc/a/app.ini" },
    { filePath: "app-2.ini", content: "two", mountPath: "/etc/b/app.ini" },
  ]);
  assert.deepEqual(
    value.volumes.map((v) => `${v.projectPath}@${v.mountPath}`),
    ["app.ini@/etc/a/app.ini", "app-2.ini@/etc/b/app.ini"],
  );
  assert.match(notes.join(" "), /both called app\.ini/);
});

test("mapMounts keeps two volumes with the same label apart", () => {
  const { value } = mapMounts(
    [
      { mountId: "1", type: "volume", volumeName: "data", mountPath: "/a" },
      { mountId: "2", type: "volume", volumeName: "data", mountPath: "/b" },
    ],
    { isCompose: false },
  );
  assert.deepEqual(
    value.volumes.map((v) => v.name),
    ["data", "data-2"],
  );
});

test("mapMounts reports a mount it had to drop", () => {
  const { value, notes } = mapMounts(
    [
      { mountId: "1", type: "bind", hostPath: "", mountPath: "/x" },
      // Neither a name nor a path: nothing to write and nowhere to mount it.
      { mountId: "2", type: "file", filePath: "", content: "x", mountPath: "" },
    ],
    { isCompose: false },
  );
  assert.deepEqual(value.volumes, []);
  assert.deepEqual(value.files, []);
  assert.equal(notes.length, 2);
});

test("a compose stack gets no Storage row for a path its own YAML mounts", () => {
  // The renderer skips a Storage volume the authored file declares, so the data copy filled one the deploy never mounted.
  const mounts = [
    {
      mountId: "m1",
      type: "volume" as const,
      volumeName: "96eqafc7-it-tools-data",
      mountPath: "/data",
    },
    {
      mountId: "m2",
      type: "volume" as const,
      volumeName: "other",
      mountPath: "/elsewhere",
    },
  ];
  const compose =
    "services:\n  a:\n    image: x\n    volumes:\n      - d:/data\n";
  assert.deepEqual(
    mapMounts(mounts, { isCompose: true, compose }).value.volumes.map(
      (v) => v.mountPath,
    ),
    ["/elsewhere"],
  );
  // A single-image app has no YAML of its own, so both rows stay.
  assert.equal(mapMounts(mounts, { isCompose: false }).value.volumes.length, 2);
});

test("mapMounts drops the machine's own files and anything not text", () => {
  // Both panels hand a bind over WITH its content, and `/etc/localtime`'s binary TZif blob killed the import on a Postgres encoding error.
  const mapped = mapMounts(
    [
      {
        mountId: "1",
        type: "file",
        filePath: "localtime",
        content: "TZif2\u0000\u0000",
        mountPath: "/etc/localtime",
      },
      {
        mountId: "2",
        type: "file",
        filePath: "timezone",
        content: "Europe/Rome\n",
        mountPath: "/etc/timezone",
      },
      {
        mountId: "3",
        type: "file",
        filePath: "resolv.conf",
        content: "nameserver 1.1.1.1\n",
        mountPath: "/etc/resolv.conf",
      },
      // A real file of the app's, but binary: its bytes belong to the data phase.
      {
        mountId: "4",
        type: "file",
        filePath: "data.sqlite",
        content: "SQLite\u0000fmt",
        mountPath: "/app/data.sqlite",
      },
      {
        mountId: "5",
        type: "file",
        filePath: "app.conf",
        content: "listen 8080;\n",
        mountPath: "/etc/app.conf",
      },
    ],
    { isCompose: false },
  );
  assert.deepEqual(
    mapped.value.files.map((f) => f.filePath),
    ["app.conf"],
  );
  assert.deepEqual(
    mapped.value.volumes.map((v) => v.mountPath),
    ["/etc/app.conf"],
  );
  // The binary one is SAID; a machine's own file is not worth a line.
  assert.deepEqual(mapped.notes, [
    "/app/data.sqlite is not a text file, so it does not come across as a config file - its bytes travel with the data.",
  ]);
});

test("mapMounts keeps the panel's own files dir out of a stack's Storage", () => {
  const compose = `services:\n  app:\n    image: nginx\n    volumes:\n      - ./content:/usr/share/nginx/html\n`;
  const { value } = mapMounts(
    [
      {
        mountId: "m1",
        type: "bind",
        hostPath: "/data/coolify/services/abc123/content",
        mountPath: "/usr/share/nginx/html",
      },
    ],
    { isCompose: true, compose },
  );
  assert.deepEqual(value.volumes, []);
});

test("mapMounts lands a panel files dir as an app file mount, not a host bind", () => {
  const { value } = mapMounts(
    [
      {
        mountId: "m1",
        type: "bind",
        hostPath: "/data/coolify/applications/abc123/content",
        mountPath: "/app/content",
      },
      {
        mountId: "m2",
        type: "bind",
        hostPath: "/srv/shared",
        mountPath: "/app/shared",
      },
    ],
    { isCompose: false },
  );
  assert.equal(value.volumes.length, 2);
  assert.equal(value.volumes[0]!.type, "app");
  assert.equal(value.volumes[0]!.projectPath, "content");
  assert.equal(value.volumes[1]!.type, "host");
  assert.equal(value.volumes[1]!.hostPath, "/srv/shared");
});

test("a stack's config file on a real host path travels as a bind", () => {
  const compose = `services:\n  app:\n    image: nginx\n    volumes:\n      - /srv/mxb1/single.conf:/etc/app/single.conf\n`;
  const file = {
    mountId: "f1",
    type: "file" as const,
    hostPath: "/srv/mxb1/single.conf",
    filePath: "single.conf",
    content: "a = 1",
    mountPath: "/etc/app/single.conf",
  };
  const stack = mapMounts([file], { isCompose: true, compose });
  assert.deepEqual(stack.value.files, []);
  assert.equal(stack.value.volumes[0]!.type, "host");
  assert.equal(stack.value.volumes[0]!.hostPath, "/srv/mxb1/single.conf");

  // An application is the other way round: Deplo writes the file into its own Files dir and mounts it from there.
  const app = mapMounts([file], { isCompose: false });
  assert.equal(app.value.files[0]!.filePath, "single.conf");
  assert.equal(app.value.volumes[0]!.type, "app");
});
