import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakeFetch, jsonResponse } from "../git/clone-test-helpers";
import {
  createGithubRepository,
  isInlineText,
  pushGithubFiles,
} from "./create-repo";

const realFetch = globalThis.fetch;
const API = "https://api.github.com";

describe("github create-repo", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("text goes inline, binary and NUL bytes do not", () => {
    assert.equal(isInlineText(Buffer.from("hello ✓")), true);
    assert.equal(isInlineText(Buffer.from([0x68, 0, 0x69])), false);
    assert.equal(isInlineText(Buffer.from([0xff, 0xfe, 0x00])), false);
  });

  test("an organisation repository goes to /orgs, a personal one to /user", async () => {
    const { fn, calls } = fakeFetch([
      (c) =>
        c.method === "POST" && c.url.endsWith("/repos")
          ? jsonResponse({
              id: 1,
              full_name: "acme/app",
              html_url: "https://github.com/acme/app",
              default_branch: "main",
            })
          : null,
    ]);
    globalThis.fetch = fn;
    const spec = {
      name: "app",
      private: true,
      description: "",
      message: "m",
    };
    await createGithubRepository({
      token: "t",
      owner: "acme",
      personal: false,
      spec,
    });
    await createGithubRepository({
      token: "t",
      owner: "me",
      personal: true,
      spec,
    });
    assert.deepEqual(
      calls.map((c) => c.url),
      [`${API}/orgs/acme/repos`, `${API}/user/repos`],
    );
    assert.equal((calls[0].body as { private: boolean }).private, true);
  });

  test("a taken name reads as such", async () => {
    globalThis.fetch = fakeFetch([
      () => jsonResponse({ message: "Repository creation failed." }, 422),
    ]).fn;
    await assert.rejects(
      createGithubRepository({
        token: "t",
        owner: "acme",
        personal: false,
        spec: { name: "app", private: false, description: "", message: "m" },
      }),
      /acme already has a repository called app/,
    );
  });

  test("files land as one root commit on the default branch", async () => {
    const { fn, calls } = fakeFetch([
      (c) =>
        c.url.endsWith("/git/blobs") ? jsonResponse({ sha: "blob1" }) : null,
      (c) =>
        c.url.endsWith("/git/trees") ? jsonResponse({ sha: "tree1" }) : null,
      (c) =>
        c.url.endsWith("/git/commits")
          ? jsonResponse({ sha: "commit1" })
          : null,
      (c) =>
        c.method === "PATCH" ? jsonResponse({ ref: "refs/heads/main" }) : null,
    ]);
    globalThis.fetch = fn;
    const out = await pushGithubFiles({
      token: "t",
      fullName: "acme/app",
      branch: "main",
      message: "Initial commit",
      files: [
        { path: "a.txt", bytes: Buffer.from("hi"), executable: false },
        { path: "run", bytes: Buffer.from("#!/bin/sh"), executable: true },
        { path: "logo.png", bytes: Buffer.from([0x89, 0]), executable: false },
      ],
    });
    assert.equal(out.fullName, "acme/app");
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.replace(API, "")}`),
      [
        "POST /repos/acme/app/git/blobs",
        "POST /repos/acme/app/git/trees",
        "POST /repos/acme/app/git/commits",
        "PATCH /repos/acme/app/git/refs/heads/main",
      ],
    );
    const tree = (
      calls[1].body as {
        tree: { path: string; mode: string; content?: string; sha?: string }[];
      }
    ).tree;
    assert.deepEqual(
      tree.map((t) => [t.path, t.mode, t.content ?? t.sha]),
      [
        ["a.txt", "100644", "hi"],
        ["run", "100755", "#!/bin/sh"],
        ["logo.png", "100644", "blob1"],
      ],
    );
    assert.deepEqual((calls[2].body as { parents: string[] }).parents, []);
    assert.equal((calls[3].body as { force: boolean }).force, true);
  });
});
