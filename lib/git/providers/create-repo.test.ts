import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakeFetch, jsonResponse } from "../clone-test-helpers";
import { batches, nameTaken, repoCreatorFor } from "./create-repo";
import type { GitCredential } from "./types";

const realFetch = globalThis.fetch;
const files = [
  { path: "index.js", bytes: Buffer.from("console.log(1)"), executable: false },
  { path: "run.sh", bytes: Buffer.from("#!/bin/sh"), executable: true },
];
const spec = {
  name: "my-app",
  private: true,
  description: "An app",
  message: "Initial commit",
};

describe("create-repo", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("batches split by size and count, keeping order", () => {
    const big = (n: number) => ({ bytes: Buffer.alloc(n) });
    assert.deepEqual(
      batches([big(10), big(10), big(10)], 30).map((b) => b.length),
      [2, 1],
    );
    assert.deepEqual(
      batches([big(1), big(1), big(1)], 1000, 2).map((b) => b.length),
      [2, 1],
    );
    assert.deepEqual(batches([]), []);
  });

  test("GitLab: a private project, then one commit with every file", async () => {
    const cred: GitCredential = {
      provider: "gitlab",
      baseUrl: "https://gitlab.com",
      username: "oauth2",
      token: "glpat",
    };
    const { fn, calls } = fakeFetch([
      (c) =>
        c.method === "POST" && c.url === "https://gitlab.com/api/v4/projects"
          ? jsonResponse({
              id: 7,
              path_with_namespace: "team/my-app",
              web_url: "https://gitlab.com/team/my-app",
            })
          : null,
      (c) =>
        c.url.endsWith("/api/v4/projects/7/repository/commits")
          ? jsonResponse({ id: "abc" })
          : null,
    ]);
    globalThis.fetch = fn;
    const created = await repoCreatorFor("gitlab")!.create(
      cred,
      { id: "42", login: "team", personal: false, avatarUrl: "" },
      spec,
      files,
    );
    assert.deepEqual(created, {
      fullName: "team/my-app",
      url: "https://gitlab.com/team/my-app",
      branch: "main",
    });
    const project = calls[0].body as Record<string, unknown>;
    assert.equal(project.namespace_id, 42);
    assert.equal(project.visibility, "private");
    const commit = calls[1].body as {
      branch: string;
      actions: {
        file_path: string;
        content: string;
        execute_filemode?: boolean;
      }[];
    };
    assert.equal(commit.branch, "main");
    assert.deepEqual(
      commit.actions.map((a) => [a.file_path, a.execute_filemode ?? false]),
      [
        ["index.js", false],
        ["run.sh", true],
      ],
    );
    assert.equal(
      Buffer.from(commit.actions[0].content, "base64").toString(),
      "console.log(1)",
    );
    assert.ok(
      calls.every((c) => c.method !== "DELETE"),
      "never deletes anything",
    );
  });

  test("a name already in use reads as such", async () => {
    const cred: GitCredential = {
      provider: "gitea",
      baseUrl: "https://git.example.com",
      username: "",
      token: "t",
    };
    globalThis.fetch = fakeFetch([
      (c) =>
        c.url.endsWith("/api/v1/user/repos")
          ? jsonResponse({ message: "The repository already exists." }, 409)
          : null,
    ]).fn;
    await assert.rejects(
      repoCreatorFor("gitea")!.create(
        cred,
        { id: "1", login: "me", personal: true, avatarUrl: "" },
        spec,
        files,
      ),
      /me already has a repository called my-app/,
    );
    assert.equal(nameTaken(new Error("Gitea request failed (500)")), false);
  });

  test("a plain git server cannot create repositories", () => {
    assert.equal(repoCreatorFor("git"), null);
  });
});
