import { test } from "node:test";
import assert from "node:assert/strict";
import { status as GrpcStatus } from "@grpc/grpc-js";

import {
  fileBindsUnderFilesDir,
  looksLikeFile,
  looksLikeFileMount,
} from "./file-binds";
import { ensureFileBinds } from "./agent-deploy";
import { buildComposeStack } from "./compose-stack";
import { renderCompose } from "./build";

/**
 * Docker invents an empty FOLDER for a missing bind source, so a `./config.yml`
 * nobody wrote yet came up as a directory. The deploy now creates file-shaped
 * binds empty first; these pin down which binds count as files and what the
 * pre-flight does on the host.
 */

test("looksLikeFile: a known extension or a known name is a file", () => {
  for (const p of [
    "config.yml",
    "nginx.conf",
    "conf/app.toml",
    "data.db",
    "init.sql",
    "server.key",
    "Caddyfile",
    "caddyfile",
    "Dockerfile",
    ".env",
    ".env.production",
    ".htpasswd",
    "load.ts",
  ]) {
    assert.equal(looksLikeFile(p), true, p);
  }
});

test("looksLikeFile: folders, dot-dirs, `.d` and domain names are not files", () => {
  for (const p of [
    "html",
    "data",
    "conf.d",
    "mysql.conf.d",
    ".ssh",
    ".config",
    "example.com",
    "config/",
    "config.yml/",
    "app.custom",
    "",
  ]) {
    assert.equal(looksLikeFile(p), false, p);
  }
});

test("looksLikeFileMount: either side of the bind decides", () => {
  assert.equal(
    looksLikeFileMount("/x/files/app/nginx", "/etc/nginx/nginx.conf"),
    true,
  );
  assert.equal(looksLikeFileMount("/x/files/app/config.yml", "/config"), true);
  assert.equal(
    looksLikeFileMount("/x/files/app/html", "/usr/share/nginx/html"),
    false,
  );
});

const filesDir = "/data/stacks/files/app";

test("fileBindsUnderFilesDir: file-shaped binds under the files dir, relative", () => {
  const yaml = `services:
  web:
    image: nginx
    volumes:
      - ${filesDir}/config.yml:/app/config.yml:ro
      - ${filesDir}/conf.d:/etc/nginx/conf.d
      - ${filesDir}/html:/usr/share/nginx/html:ro
      - ${filesDir}/conf/app.toml:/etc/app/app.toml
      - /srv/media/notes.txt:/media/notes.txt
      - uploads:/data
  worker:
    image: busybox
    volumes:
      - type: bind
        source: ${filesDir}/nginx
        target: /etc/nginx/nginx.conf
        read_only: true
      - type: volume
        source: cache
        target: /cache
volumes:
  uploads: {}
  cache: {}
`;
  assert.deepEqual(fileBindsUnderFilesDir(yaml, filesDir), [
    "config.yml",
    "conf/app.toml",
    "nginx",
  ]);
});

test("fileBindsUnderFilesDir: the config files the agent writes are left out", () => {
  const yaml = `services:
  web:
    image: nginx
    volumes:
      - ${filesDir}/config.yml:/app/config.yml
      - ${filesDir}/conf/nginx.conf:/etc/nginx/nginx.conf
`;
  assert.deepEqual(
    fileBindsUnderFilesDir(yaml, filesDir, [
      "./config.yml",
      "conf/nginx.conf/",
    ]),
    [],
  );
});

test("fileBindsUnderFilesDir: one path mounted twice is one bind", () => {
  const yaml = `services:
  a:
    image: x
    volumes: ["${filesDir}/shared.json:/a/shared.json"]
  b:
    image: y
    volumes: ["${filesDir}/shared.json:/b/shared.json:ro"]
`;
  assert.deepEqual(fileBindsUnderFilesDir(yaml, filesDir + "/"), [
    "shared.json",
  ]);
});

test("fileBindsUnderFilesDir: a neighbour's dir, the whole dir and bad yaml give nothing", () => {
  const neighbour = `services:
  web:
    image: x
    volumes:
      - ${filesDir}2/config.yml:/app/config.yml
      - ${filesDir}:/app/files.json
`;
  assert.deepEqual(fileBindsUnderFilesDir(neighbour, filesDir), []);
  assert.deepEqual(fileBindsUnderFilesDir("services: [", filesDir), []);
  assert.deepEqual(fileBindsUnderFilesDir("", filesDir), []);
  assert.deepEqual(
    fileBindsUnderFilesDir("services: {web: {image: x}}", filesDir),
    [],
  );
});

// ---- the host side ----

type Calls = string[];

function grpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function fakeConn(
  disk: Record<string, "text" | "binary" | "folder" | "folder-with-content">,
  calls: Calls,
) {
  return {
    async readFile(slug: string, path: string) {
      calls.push(`read ${slug}:${path}`);
      const what = disk[path];
      if (!what)
        throw grpcError(GrpcStatus.NOT_FOUND, `read ${path}: no such file`);
      if (what.startsWith("folder"))
        throw grpcError(GrpcStatus.INVALID_ARGUMENT, "not a file");
      return {
        path,
        text: what === "text" ? "x" : null,
        size: 1,
        reason: what === "binary" ? ("binary" as const) : null,
      };
    },
    async listFiles(slug: string, path: string) {
      calls.push(`list ${slug}:${path}`);
      return disk[path] === "folder-with-content"
        ? [
            {
              path: `${path}/a`,
              name: "a",
              kind: "file",
              size: 1,
              modifiedAt: "",
            },
          ]
        : [];
    },
    async deleteFile(slug: string, path: string) {
      calls.push(`delete ${slug}:${path}`);
      delete disk[path];
    },
    async writeFile(slug: string, path: string, content: string) {
      calls.push(`write ${slug}:${path}=${JSON.stringify(content)}`);
      disk[path] = "text";
      return { path, name: path, kind: "file", size: 0, modifiedAt: "" };
    },
  };
}

test("ensureFileBinds: a missing bind is created as an empty file", async () => {
  const calls: Calls = [];
  const logs: string[] = [];
  await ensureFileBinds(fakeConn({}, calls), "app", ["config.yml"], (l, t) =>
    logs.push(`${l}: ${t}`),
  );
  assert.deepEqual(calls, ["read app:config.yml", 'write app:config.yml=""']);
  assert.deepEqual(logs, [
    "info: Created an empty config.yml in this app's Files, mounted as a file.",
  ]);
});

test("ensureFileBinds: a file that is there is never touched, binary included", async () => {
  const calls: Calls = [];
  await ensureFileBinds(
    fakeConn({ "config.yml": "text", "data.db": "binary" }, calls),
    "app",
    ["config.yml", "data.db"],
    () => {},
  );
  assert.deepEqual(calls, ["read app:config.yml", "read app:data.db"]);
});

test("ensureFileBinds: the empty folder a past deploy left is replaced by a file", async () => {
  const calls: Calls = [];
  await ensureFileBinds(
    fakeConn({ "load.ts": "folder" }, calls),
    "app",
    ["load.ts"],
    () => {},
  );
  assert.deepEqual(calls, [
    "read app:load.ts",
    "list app:load.ts",
    "delete app:load.ts",
    'write app:load.ts=""',
  ]);
});

test("ensureFileBinds: a folder with content is kept and named", async () => {
  const calls: Calls = [];
  const logs: string[] = [];
  await ensureFileBinds(
    fakeConn({ "config.yml": "folder-with-content" }, calls),
    "app",
    ["config.yml"],
    (l, t) => logs.push(`${l}: ${t}`),
  );
  assert.deepEqual(calls, ["read app:config.yml", "list app:config.yml"]);
  assert.deepEqual(logs, [
    "warn: config.yml in this app's Files is a folder with content, so it is mounted as a folder.",
  ]);
});

test("ensureFileBinds: any other agent failure is the deploy's failure", async () => {
  const conn = fakeConn({}, []);
  conn.readFile = async () => {
    throw grpcError(GrpcStatus.UNAVAILABLE, "connection refused");
  };
  await assert.rejects(
    ensureFileBinds(conn, "app", ["config.yml"], () => {}),
    /connection refused/,
  );
});

test("ensureFileBinds: nothing to ensure dials nothing", async () => {
  const calls: Calls = [];
  await ensureFileBinds(fakeConn({}, calls), "app", [], () => {});
  assert.deepEqual(calls, []);
});

// ---- second pass: edge shapes, Storage File rows, and the real renderers ----

test("looksLikeFile: case, dotfiles and double extensions", () => {
  for (const p of [
    "CONFIG.YML",
    ".env.local",
    "Makefile",
    "a.b.yml",
    "yarn.lock",
    "server.cert",
    "data.bin",
  ]) {
    assert.equal(looksLikeFile(p), true, p);
  }
  for (const p of [".git", "nginx.conf.d", "node_modules", "site.local"]) {
    assert.equal(looksLikeFile(p), false, p);
  }
});

test("fileBindsUnderFilesDir: a Storage File row is a file whatever its name", () => {
  const yaml = `services:
  web:
    image: nginx
    volumes:
      - ${filesDir}/myconfig:/app/myconfig
      - ${filesDir}/data:/data
`;
  assert.deepEqual(fileBindsUnderFilesDir(yaml, filesDir), []);
  assert.deepEqual(fileBindsUnderFilesDir(yaml, filesDir, [], ["./myconfig"]), [
    "myconfig",
  ]);
  // A File row the agent also writes as a config file is still left to the agent.
  assert.deepEqual(
    fileBindsUnderFilesDir(yaml, filesDir, ["myconfig"], ["myconfig"]),
    [],
  );
});

test("a rendered compose stack: ./x binds, Storage Files and named volumes sort themselves out", () => {
  const rendered = buildComposeStack({
    network: "deplo-team-team_test",
    compose: `services:
  web:
    image: nginx
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./html:/usr/share/nginx/html
      - ./conf.d/:/etc/nginx/conf.d
      - appdata:/var/lib/app
  worker:
    image: busybox
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
volumes:
  appdata: {}
`,
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [],
    filesDir: "/srv/stacks/files/demo",
    volumes: [
      {
        id: "v1",
        type: "app",
        name: "notes",
        projectPath: "notes",
        mountPath: "/app/notes",
        readOnly: false,
      },
      {
        id: "v2",
        type: "named",
        name: "uploads",
        mountPath: "/uploads",
        readOnly: false,
      },
      {
        id: "v3",
        type: "host",
        name: "media",
        hostPath: "/srv/media",
        mountPath: "/media",
        readOnly: true,
      },
    ],
  });
  assert.deepEqual(
    fileBindsUnderFilesDir(
      rendered,
      "/srv/stacks/files/demo",
      [],
      ["notes"],
    ).sort(),
    ["Caddyfile", "nginx.conf", "notes"],
  );
  // Without the Storage row's word for it, `notes` reads as a folder.
  assert.deepEqual(
    fileBindsUnderFilesDir(rendered, "/srv/stacks/files/demo").sort(),
    ["Caddyfile", "nginx.conf"],
  );
});

test("a rendered single-image stack: a File row lands in the files dir and is found", () => {
  const rendered = renderCompose({
    network: "deplo-team-team_test",
    name: "deplo-demo",
    image: "deplo/demo:abc123",
    port: 3000,
    appId: "p1",
    deployKey: "demo",
    routes: [],
    env: {},
    volumes: [
      {
        type: "app",
        name: "settings",
        projectPath: "conf/settings",
        mountPath: "/app/conf/settings",
        readOnly: false,
      },
      {
        type: "app",
        name: "app",
        projectPath: "app.toml",
        mountPath: "/app/app.toml",
        readOnly: true,
      },
      {
        type: "named",
        name: "uploads",
        mountPath: "/app/uploads",
        readOnly: false,
      },
    ],
  });
  const dir = process.env.DEPLO_DATA_DIR
    ? `${process.env.DEPLO_DATA_DIR}/stacks/files/demo`
    : "/data/stacks/files/demo";
  assert.deepEqual(
    fileBindsUnderFilesDir(
      rendered,
      dir,
      [],
      ["conf/settings", "app.toml"],
    ).sort(),
    ["app.toml", "conf/settings"],
  );
  assert.deepEqual(fileBindsUnderFilesDir(rendered, dir), ["app.toml"]);
});
