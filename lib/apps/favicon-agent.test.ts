// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { gzipSync } from "node:zlib";

import {
  collectAgentFaviconCandidates,
  readFilesDirBytes,
  detectServedFaviconVia,
  servedIconTarget,
} from "./favicon-agent";
import { buildTar, tarStream } from "../infra/tar-test-helpers";
import { pickBestFavicon } from "./favicon-shared";

/**
 * Compose-stack favicon detection talks to the owning agent through two narrow
 * seams, so a fake agent pins both halves without a server: - the WALK drives
 * ListFiles one directory at a time - what it descends into, what it prunes, what
 */

interface FakeEntry {
  name: string;
  kind: "dir" | "file";
  size?: number;
}

/** A fake files dir: map of directory path ("" is the root) → its children. */
function fakeLister(tree: Record<string, FakeEntry[]>, calls: string[] = []) {
  return {
    calls,
    async listFiles(_slug: string, path: string) {
      calls.push(path);
      const entries = tree[path];
      if (!entries) throw new Error(`no such directory: ${path}`);
      return entries.map((e) => ({
        path: path ? `${path}/${e.name}` : e.name,
        name: e.name,
        kind: e.kind,
        size: e.size ?? 0,
      }));
    },
  };
}

test("walk: collects favicons from the root and from nested dirs", async () => {
  const lister = fakeLister({
    "": [
      { name: "site", kind: "dir" },
      { name: "favicon.ico", kind: "file", size: 4286 },
      { name: "docker-compose.yml", kind: "file", size: 900 },
    ],
    site: [
      { name: "public", kind: "dir" },
      { name: "index.html", kind: "file", size: 120 },
    ],
    "site/public": [{ name: "favicon.svg", kind: "file", size: 700 }],
  });
  const found = await collectAgentFaviconCandidates(lister, "web");
  assert.deepEqual(found.map((f) => f.path).sort(), [
    "favicon.ico",
    "site/public/favicon.svg",
  ]);
  // The shared ranker then picks the scalable one over the root .ico.
  assert.equal(pickBestFavicon(found)?.path, "site/public/favicon.svg");
});

test("walk: keeps the real size so the logo cap applies before any byte moves", async () => {
  const lister = fakeLister({
    "": [{ name: "favicon.png", kind: "file", size: 12_345 }],
  });
  const found = await collectAgentFaviconCandidates(lister, "web");
  assert.deepEqual(found, [{ path: "favicon.png", size: 12_345 }]);
});

test("walk: ignores files that are not named favicon", async () => {
  const lister = fakeLister({
    "": [
      { name: "logo.svg", kind: "file", size: 100 },
      { name: "icon.png", kind: "file", size: 100 },
      { name: "apple-touch-icon.png", kind: "file", size: 100 },
      { name: "favicon.txt", kind: "file", size: 100 },
    ],
  });
  assert.deepEqual(await collectAgentFaviconCandidates(lister, "web"), []);
});

test("walk: never descends into dependency/build dirs", async () => {
  const lister = fakeLister({
    "": [
      { name: "node_modules", kind: "dir" },
      { name: "dist", kind: "dir" },
      { name: ".git", kind: "dir" },
      { name: "public", kind: "dir" },
    ],
    node_modules: [{ name: "favicon.ico", kind: "file", size: 10 }],
    dist: [{ name: "favicon.ico", kind: "file", size: 10 }],
    ".git": [{ name: "favicon.ico", kind: "file", size: 10 }],
    public: [{ name: "favicon.ico", kind: "file", size: 10 }],
  });
  const found = await collectAgentFaviconCandidates(lister, "web");
  assert.deepEqual(
    found.map((f) => f.path),
    ["public/favicon.ico"],
  );
  assert.deepEqual(lister.calls.sort(), ["", "public"]);
});

test("walk: is breadth-first, so a shallow icon is found before a deep tree is explored", async () => {
  const tree: Record<string, FakeEntry[]> = {
    "": [
      { name: "deep", kind: "dir" },
      { name: "public", kind: "dir" },
    ],
    public: [{ name: "favicon.png", kind: "file", size: 50 }],
  };
  // A long chain below `deep/` that would swallow the budget depth-first.
  let path = "deep";
  tree.deep = [{ name: "a", kind: "dir" }];
  for (let i = 0; i < 10; i++) {
    const child = `${path}/a`;
    tree[path] = [{ name: "a", kind: "dir" }];
    path = child;
  }
  tree[path] = [];
  const lister = fakeLister(tree);
  const found = await collectAgentFaviconCandidates(lister, "web");
  assert.deepEqual(
    found.map((f) => f.path),
    ["public/favicon.png"],
  );
  // `public` is listed on the second level, long before the deep chain's tail.
  assert.equal(lister.calls.indexOf("public") <= 2, true);
});

test("walk: stops descending past the depth cap", async () => {
  const tree: Record<string, FakeEntry[]> = {};
  let path = "";
  for (let depth = 0; depth < 10; depth++) {
    tree[path] = [{ name: "d", kind: "dir" }];
    path = path ? `${path}/d` : "d";
  }
  tree[path] = [{ name: "favicon.ico", kind: "file", size: 10 }];
  const lister = fakeLister(tree);
  assert.deepEqual(await collectAgentFaviconCandidates(lister, "web"), []);
  // 6 levels below the root is as far as it goes (root + 6 listings).
  assert.equal(lister.calls.length, 7);
});

test("walk: bounds the number of directories it opens", async () => {
  const tree: Record<string, FakeEntry[]> = { "": [] };
  for (let i = 0; i < 500; i++) {
    tree[""].push({ name: `d${i}`, kind: "dir" });
    tree[`d${i}`] = [{ name: "readme.txt", kind: "file", size: 1 }];
  }
  const lister = fakeLister(tree);
  await collectAgentFaviconCandidates(lister, "web");
  assert.equal(
    lister.calls.length <= 48,
    true,
    `listed ${lister.calls.length} dirs`,
  );
});

test("walk: a directory that fails to list is skipped, not fatal", async () => {
  const lister = fakeLister({
    "": [
      { name: "broken", kind: "dir" },
      { name: "public", kind: "dir" },
    ],
    // `broken` is deliberately absent from the tree → listFiles throws.
    public: [{ name: "favicon.ico", kind: "file", size: 10 }],
  });
  const found = await collectAgentFaviconCandidates(lister, "web");
  assert.deepEqual(
    found.map((f) => f.path),
    ["public/favicon.ico"],
  );
});

test("walk: an empty files dir yields nothing (and one RPC)", async () => {
  const lister = fakeLister({ "": [] });
  assert.deepEqual(await collectAgentFaviconCandidates(lister, "web"), []);
  assert.deepEqual(lister.calls, [""]);
});

/* ------------------------------------------------------------------ */
/* Reading the chosen icon's bytes: text RPC for an SVG when it is      */
/* byte-exact, the ExportFiles tar for everything else.                 */
/* ------------------------------------------------------------------ */

/** A fake agent that records which read path was used. */
function fakeReader(opts: {
  files: Record<string, Buffer>;
  capabilities?: string[];
  /** Force ReadFile to withhold a body (the agent's binary/too-large answer). */
  withholdText?: boolean;
}) {
  const used: string[] = [];
  return {
    used,
    async readFile(_slug: string, path: string) {
      used.push(`readFile:${path}`);
      const bytes = opts.files[path];
      if (!bytes) throw new Error("not found");
      // The agent hands back a UTF-8 STRING plus the file's real byte size -
      // the two disagree exactly when the bytes are not valid UTF-8.
      return {
        text: opts.withholdText ? null : bytes.toString("utf8"),
        size: bytes.length,
      };
    },
    async hello() {
      used.push("hello");
      return { capabilities: opts.capabilities ?? ["files-copy"] };
    },
    exportFiles() {
      used.push("exportFiles");
      const tar = buildTar(
        Object.entries(opts.files).map(([path, bytes]) => [
          `files/${path}`,
          bytes,
        ]),
      );
      return tarStream(gzipSync(tar), 4096);
    },
  };
}

test("read: an SVG comes back over the text RPC, no tar", async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  );
  const conn = fakeReader({ files: { "public/favicon.svg": svg } });
  assert.deepEqual(
    await readFilesDirBytes(conn, "web", "public/favicon.svg"),
    svg,
  );
  assert.deepEqual(conn.used, ["readFile:public/favicon.svg"]);
});

test("read: an SVG that is not valid UTF-8 falls through to the tar, byte-exact", async () => {
  // latin1 `è` - a UTF-8 round trip would silently rewrite it, so the length
  // check must reject the text and take the tar path instead.
  const svg = Buffer.concat([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><!-- caff'),
    Buffer.from([0xe8]),
    Buffer.from(" --></svg>"),
  ]);
  const conn = fakeReader({ files: { "public/favicon.svg": svg } });
  assert.deepEqual(
    await readFilesDirBytes(conn, "web", "public/favicon.svg"),
    svg,
  );
  assert.deepEqual(conn.used, [
    "readFile:public/favicon.svg",
    "hello",
    "exportFiles",
  ]);
});

test("read: an SVG the agent withholds still comes out of the tar", async () => {
  const svg = Buffer.from("<svg/>");
  const conn = fakeReader({
    files: { "public/favicon.svg": svg },
    withholdText: true,
  });
  assert.deepEqual(
    await readFilesDirBytes(conn, "web", "public/favicon.svg"),
    svg,
  );
});

test("read: a binary icon comes out of the tar", async () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2,
  ]);
  const conn = fakeReader({
    files: { "favicon.png": png, "other.txt": Buffer.from("x") },
  });
  assert.deepEqual(await readFilesDirBytes(conn, "web", "favicon.png"), png);
  // No pointless text read for a format that can never come back as text.
  assert.deepEqual(conn.used, ["hello", "exportFiles"]);
});

test("read: an agent without files-copy reads nothing binary (and no stream)", async () => {
  const conn = fakeReader({
    files: { "favicon.ico": Buffer.from([0, 0, 1, 0]) },
    capabilities: ["metrics"],
  });
  assert.equal(await readFilesDirBytes(conn, "web", "favicon.ico"), null);
  assert.deepEqual(conn.used, ["hello"]);
});

test("read: a file missing from the archive yields null", async () => {
  const conn = fakeReader({ files: { "favicon.png": Buffer.from([1, 2, 3]) } });
  assert.equal(
    await readFilesDirBytes(conn, "web", "public/favicon.png"),
    null,
  );
});

/* ------------------------------------------------------------------ */
/* The icon a RUNNING app serves - the case a files walk can never see: */
/* a compose stack of prebuilt images keeps its favicon in the image.   */
/* ------------------------------------------------------------------ */

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);
const ICO_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00, 1, 0, 16, 16]);

/** One canned HTTP response. */
interface FakeResponse {
  status?: number;
  contentType?: string;
  body?: Buffer;
  truncated?: boolean;
  location?: string;
}

/** A fake agent that answers ProbeHttp from a path → response map and records
 * every request, so what the detector ASKS FOR is as testable as what it picks. */
function fakeProber(
  responses: Record<string, FakeResponse>,
  opts: { capabilities?: string[] } = {},
) {
  const asked: string[] = [];
  const hosts: string[] = [];
  return {
    asked,
    hosts,
    async hello() {
      return { capabilities: opts.capabilities ?? ["http-probe"] };
    },
    async probeHttp(req: { path: string; host: string }) {
      asked.push(req.path);
      hosts.push(req.host);
      const res = responses[req.path];
      if (!res) throw new Error("connection refused");
      return {
        status: res.status ?? 200,
        contentType: res.contentType ?? "",
        body: res.body ?? Buffer.alloc(0),
        truncated: res.truncated ?? false,
        location: res.location ?? "",
      };
    },
  };
}

const TARGET = {
  appId: "prj_1",
  slug: "web",
  service: "app",
  port: 3000,
  host: "app.example.com",
  basePath: "",
};

test("served: takes the icon the page declares, over the /favicon.ico fallback", async () => {
  const conn = fakeProber({
    "/": {
      contentType: "text/html; charset=utf-8",
      body: Buffer.from(
        `<html><head><link rel="icon" type="image/png" href="/assets/icon-192.png"></head></html>`,
      ),
    },
    "/assets/icon-192.png": { contentType: "image/png", body: PNG_BYTES },
    "/favicon.ico": { contentType: "image/x-icon", body: ICO_BYTES },
  });
  const found = await detectServedFaviconVia(conn, TARGET);
  assert.equal(found?.path, "/assets/icon-192.png");
  assert.equal(found?.mime, "image/png");
  assert.deepEqual(found?.bytes, PNG_BYTES);
  assert.deepEqual(conn.asked, ["/", "/assets/icon-192.png"]);
  // The app is asked on its OWN hostname - what an app with host authorization
  // (ALLOWED_HOSTS, a configured site URL) requires before it answers at all.
  assert.deepEqual(new Set(conn.hosts), new Set(["app.example.com"]));
});

test("served: an app that declares nothing still gets /favicon.ico tried", async () => {
  const conn = fakeProber({
    "/": {
      contentType: "text/html",
      body: Buffer.from("<html><head></head></html>"),
    },
    "/favicon.ico": { contentType: "image/x-icon", body: ICO_BYTES },
  });
  const found = await detectServedFaviconVia(conn, TARGET);
  assert.equal(found?.path, "/favicon.ico");
  assert.equal(found?.mime, "image/x-icon");
});

test("served: an API that serves no HTML at all still gets /favicon.ico tried", async () => {
  const conn = fakeProber({
    "/": { contentType: "application/json", body: Buffer.from("{}") },
    "/favicon.ico": { contentType: "image/x-icon", body: ICO_BYTES },
  });
  assert.equal(
    (await detectServedFaviconVia(conn, TARGET))?.path,
    "/favicon.ico",
  );
});

test("served: follows the redirect apps put in front of their home page", async () => {
  const conn = fakeProber({
    "/": { status: 302, location: "/login" },
    "/login": {
      contentType: "text/html",
      body: Buffer.from(`<head><link rel="icon" href="/static/f.png"></head>`),
    },
    "/static/f.png": { contentType: "image/png", body: PNG_BYTES },
  });
  assert.equal(
    (await detectServedFaviconVia(conn, TARGET))?.path,
    "/static/f.png",
  );
});

test("served: a redirect off this app is not followed", async () => {
  const conn = fakeProber({
    "/": { status: 302, location: "https://accounts.google.com/signin" },
    "/favicon.ico": { contentType: "image/x-icon", body: ICO_BYTES },
  });
  // The home page is abandoned, but the app's own well-known path is still ours
  // to ask for.
  assert.equal(
    (await detectServedFaviconVia(conn, TARGET))?.path,
    "/favicon.ico",
  );
  assert.ok(!conn.asked.some((p) => p.includes("google")));
});

test("served: an SPA answering /favicon.ico with index.html is NOT an icon", async () => {
  const html = Buffer.from("<!DOCTYPE html><html><body>app</body></html>");
  const conn = fakeProber({
    "/": { contentType: "text/html", body: Buffer.from("<head></head>") },
    // A 200, and even an image content type - only the bytes give it away.
    "/favicon.ico": { contentType: "image/x-icon", body: html },
  });
  assert.equal(await detectServedFaviconVia(conn, TARGET), null);
});

test("served: moves on to the next candidate when one is missing or oversized", async () => {
  const conn = fakeProber({
    "/": {
      contentType: "text/html",
      body: Buffer.from(
        `<head><link rel="icon" type="image/svg+xml" href="/huge.svg">` +
          `<link rel="icon" type="image/png" href="/gone.png">` +
          `<link rel="icon" sizes="16x16" type="image/png" href="/ok.png"></head>`,
      ),
    },
    // Truncated => the agent cut it at the logo cap, so we hold a fragment.
    "/huge.svg": {
      contentType: "image/svg+xml",
      body: Buffer.from("<svg"),
      truncated: true,
    },
    // `/gone.png` is absent from the map => the probe throws (404/refused).
    "/ok.png": { contentType: "image/png", body: PNG_BYTES },
  });
  assert.equal((await detectServedFaviconVia(conn, TARGET))?.path, "/ok.png");
});

test("served: an icon the page inlined needs no request", async () => {
  const conn = fakeProber({
    "/": {
      contentType: "text/html",
      body: Buffer.from(
        `<head><link rel="icon" href="data:image/png;base64,${PNG_BYTES.toString("base64")}"></head>`,
      ),
    },
  });
  const found = await detectServedFaviconVia(conn, TARGET);
  assert.equal(found?.mime, "image/png");
  assert.deepEqual(found?.bytes, PNG_BYTES);
  assert.deepEqual(conn.asked, ["/"]);
});

test("served: an agent too old to probe reports no icon, not an error", async () => {
  const conn = fakeProber(
    { "/favicon.ico": { body: ICO_BYTES } },
    { capabilities: ["metrics"] },
  );
  assert.equal(await detectServedFaviconVia(conn, TARGET), null);
  assert.deepEqual(conn.asked, []);
});

test("served: an app that is not answering has no icon, and does not throw", async () => {
  const conn = fakeProber({});
  assert.equal(await detectServedFaviconVia(conn, TARGET), null);
});

test("served: a path-routed app is read under the prefix it actually serves on", async () => {
  const conn = fakeProber({
    "/api/": {
      contentType: "text/html",
      body: Buffer.from(`<head><link rel="icon" href="icon.png"></head>`),
    },
    "/api/icon.png": { contentType: "image/png", body: PNG_BYTES },
  });
  const found = await detectServedFaviconVia(conn, {
    ...TARGET,
    basePath: "/api",
  });
  assert.equal(found?.path, "/api/icon.png");
});

/* ------------------------------------------------------------------ */
/* Which container/port/host to ask - the same one Traefik was given.   */
/* ------------------------------------------------------------------ */

const COMPOSE = `services:
  web:
    image: nginx
    ports: ["8080:80"]
  api:
    image: acme/api
    ports: ["4000"]
  db:
    image: postgres`;

const APP = { id: "prj_1", slug: "shop", compose: COMPOSE };

test("target: the primary domain decides the service, port and Host header", async () => {
  const target = servedIconTarget(
    APP,
    [
      {
        name: "api.example.com",
        service: "api",
        port: 4000,
        pathPrefix: "",
        stripPrefix: false,
      },
      {
        name: "shop.example.com",
        service: "web",
        port: 80,
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
    "shop.example.com",
  );
  assert.deepEqual(target, {
    appId: "prj_1",
    slug: "shop",
    service: "web",
    port: 80,
    host: "shop.example.com",
    basePath: "",
  });
});

test("target: an app with no domain yet is still reachable, via the compose default", async () => {
  // Not published is not the same as not running, and this is exactly the case
  // a fetch from the outside could never cover.
  const target = servedIconTarget(APP, [], "");
  assert.equal(target?.service, "web");
  assert.equal(target?.port, 80);
  assert.equal(target?.host, "");
});

test("target: a route with no port takes the service's own compose port", async () => {
  const target = servedIconTarget(
    APP,
    [
      {
        name: "x.example.com",
        service: "api",
        port: null,
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
    "x.example.com",
  );
  assert.equal(target?.port, 4000);
});

test("target: a stripped path prefix never reaches the container", async () => {
  const routes = [
    {
      name: "x.example.com",
      service: "web",
      port: 80,
      pathPrefix: "/api",
      stripPrefix: true,
    },
  ];
  assert.equal(servedIconTarget(APP, routes, "x.example.com")?.basePath, "");
  assert.equal(
    servedIconTarget(
      APP,
      [{ ...routes[0], stripPrefix: false }],
      "x.example.com",
    )?.basePath,
    "/api",
  );
});

test("target: null when there is no service to talk to at all", async () => {
  assert.equal(
    servedIconTarget({ id: "p", slug: "s", compose: null }, [], ""),
    null,
  );
  assert.equal(
    servedIconTarget({ id: "p", slug: "s", compose: "nonsense: [" }, [], ""),
    null,
  );
});

test("served: an icon URL that redirects within the app is followed", async () => {
  const conn = fakeProber({
    "/": { contentType: "text/html", body: Buffer.from("<head></head>") },
    // A hashed-asset rewrite in front of the well-known path - ordinary, and
    // giving up on it would cost the icon.
    "/favicon.ico": { status: 301, location: "/assets/favicon.a1b2.ico" },
    "/assets/favicon.a1b2.ico": {
      contentType: "image/x-icon",
      body: ICO_BYTES,
    },
  });
  const found = await detectServedFaviconVia(conn, TARGET);
  assert.equal(found?.path, "/assets/favicon.a1b2.ico");
  assert.deepEqual(conn.asked, [
    "/",
    "/favicon.ico",
    "/assets/favicon.a1b2.ico",
  ]);
});

test("served: a redirect loop cannot turn the search into a crawl", async () => {
  const conn = fakeProber({
    "/": { contentType: "text/html", body: Buffer.from("<head></head>") },
    "/favicon.ico": { status: 302, location: "/a" },
    "/a": { status: 302, location: "/b" },
    "/b": { status: 302, location: "/a" },
  });
  assert.equal(await detectServedFaviconVia(conn, TARGET), null);
  // The home page, then a bounded number of icon fetches, never unbounded.
  assert.ok(conn.asked.length <= 8, `asked ${conn.asked.length} times`);
});
