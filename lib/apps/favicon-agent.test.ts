import test from "node:test";
import assert from "node:assert/strict";

import { gzipSync } from "node:zlib";

import {
  collectAgentFaviconCandidates,
  readFilesDirBytes,
} from "./favicon-agent";
import { buildTar, tarStream } from "../infra/tar-test-helpers";
import { pickBestFavicon } from "./favicon-shared";

/**
 * Compose-stack favicon detection talks to the owning agent through two narrow
 * seams, so a fake agent pins both halves without a server:
 *  - the WALK drives ListFiles one directory at a time — what it descends into,
 *    what it prunes, what it collects, and where it stops;
 *  - the READ decides between the text RPC and the ExportFiles tar, which is
 *    where an icon would quietly get corrupted if the choice were wrong.
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
  assert.deepEqual(
    found.map((f) => f.path).sort(),
    ["favicon.ico", "site/public/favicon.svg"],
  );
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
  assert.equal(lister.calls.length <= 48, true, `listed ${lister.calls.length} dirs`);
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
      // The agent hands back a UTF-8 STRING plus the file's real byte size —
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
        Object.entries(opts.files).map(([path, bytes]) => [`files/${path}`, bytes]),
      );
      return tarStream(gzipSync(tar), 4096);
    },
  };
}

test("read: an SVG comes back over the text RPC, no tar", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  const conn = fakeReader({ files: { "public/favicon.svg": svg } });
  assert.deepEqual(
    await readFilesDirBytes(conn, "web", "public/favicon.svg"),
    svg,
  );
  assert.deepEqual(conn.used, ["readFile:public/favicon.svg"]);
});

test("read: an SVG that is not valid UTF-8 falls through to the tar, byte-exact", async () => {
  // latin1 `è` — a UTF-8 round trip would silently rewrite it, so the length
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
  assert.deepEqual(await readFilesDirBytes(conn, "web", "public/favicon.svg"), svg);
});

test("read: a binary icon comes out of the tar", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
  const conn = fakeReader({ files: { "favicon.png": png, "other.txt": Buffer.from("x") } });
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
  assert.equal(await readFilesDirBytes(conn, "web", "public/favicon.png"), null);
});
