import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetDnsLookupForTest,
  __setDnsLookupForTest,
} from "../outbound-url";
import {
  archiveUrl,
  filesFromTarGz,
  readSourceFiles,
  resolveSource,
  stripTopFolder,
} from "./clone-archive";
import { parseCloneSource } from "./clone-source";
import { chunksOf, fakeFetch, jsonResponse, tarGz } from "./clone-test-helpers";

const realFetch = globalThis.fetch;
const source = parseCloneSource({ repo: "https://github.com/acme/app" })!;

describe("clone-archive", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetDnsLookupForTest();
  });

  test("the archive's top folder is dropped, and nothing climbs out of it", () => {
    assert.equal(stripTopFolder("app-1a2b/src/index.ts"), "src/index.ts");
    assert.equal(stripTopFolder("app-1a2b/"), null);
    assert.equal(stripTopFolder("app-1a2b/../etc/passwd"), null);
    assert.equal(stripTopFolder("app-1a2b/.git/config"), null);
    assert.equal(stripTopFolder("README.md"), null);
  });

  test("files come out with their bytes and executable bit, symlinks left out", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    const files = await filesFromTarGz(
      chunksOf(
        tarGz([
          { name: "package.json", content: '{"name":"app"}' },
          { name: "bin/start", content: "#!/bin/sh\n", mode: 0o755 },
          { name: "public/logo.png", content: png },
          { name: "link", content: "", type: "2" },
        ]),
      ),
    );
    assert.deepEqual(
      files.map((f) => [f.path, f.executable]),
      [
        ["package.json", false],
        ["bin/start", true],
        ["public/logo.png", false],
      ],
    );
    assert.deepEqual(files[2].bytes, png);
  });

  test("a private or missing repository is refused before anything is downloaded", async () => {
    __setDnsLookupForTest(async () => [{ address: "93.184.216.34" }]);
    const { fn, calls } = fakeFetch([
      (c) =>
        c.url === "https://api.github.com/repos/acme/app"
          ? jsonResponse({ private: true, default_branch: "main" })
          : null,
    ]);
    globalThis.fetch = fn;
    await assert.rejects(resolveSource(source), /isn't a public GitHub/);
    assert.equal(calls.length, 1);
  });

  test("the default branch is resolved and the archive read from it", async () => {
    __setDnsLookupForTest(async () => [{ address: "93.184.216.34" }]);
    const { fn } = fakeFetch([
      (c) =>
        c.url === "https://api.github.com/repos/acme/app"
          ? jsonResponse({
              private: false,
              default_branch: "trunk",
              description: "An app",
            })
          : null,
      (c) =>
        c.url === archiveUrl(source, "trunk")
          ? new Response(tarGz([{ name: "index.js", content: "1" }]))
          : null,
    ]);
    globalThis.fetch = fn;
    const info = await resolveSource(source);
    assert.deepEqual(info, { ref: "trunk", description: "An app" });
    const files = await readSourceFiles(source, info.ref);
    assert.deepEqual(
      files.map((f) => f.path),
      ["index.js"],
    );
  });

  test("an unknown branch says so", async () => {
    __setDnsLookupForTest(async () => [{ address: "93.184.216.34" }]);
    globalThis.fetch = fakeFetch([]).fn;
    await assert.rejects(
      readSourceFiles(source, "nope"),
      /has no branch or tag called nope/,
    );
  });
});
