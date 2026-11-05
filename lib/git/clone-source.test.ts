import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanRepoName,
  parseCloneSource,
  repoNameProblem,
  suggestedRepoName,
} from "./clone-source";

describe("clone-source", () => {
  test("a GitHub repository link names the repository and no branch", () => {
    assert.deepEqual(
      parseCloneSource({ repo: "https://github.com/arthelokyo/astrowind" }),
      {
        host: "github",
        fullName: "arthelokyo/astrowind",
        ref: null,
        composeFile: null,
        url: "https://github.com/arthelokyo/astrowind",
      },
    );
    assert.equal(
      parseCloneSource({ repo: "github.com/acme/app.git" })?.fullName,
      "acme/app",
    );
  });

  test("a tree link keeps its branch", () => {
    assert.equal(
      parseCloneSource({ repo: "https://github.com/acme/app/tree/next" })?.ref,
      "next",
    );
  });

  test("compose= alone names the repository, the branch and the file", () => {
    for (const compose of [
      "https://github.com/acme/app/blob/v1.2.0/deploy/docker-compose.yml",
      "https://raw.githubusercontent.com/acme/app/v1.2.0/deploy/docker-compose.yml",
    ]) {
      const s = parseCloneSource({ compose });
      assert.equal(s?.fullName, "acme/app");
      assert.equal(s?.ref, "v1.2.0");
      assert.equal(s?.composeFile, "deploy/docker-compose.yml");
    }
  });

  test("GitLab, subgroups included", () => {
    const s = parseCloneSource({
      compose: "https://gitlab.com/group/sub/app/-/blob/main/compose.yaml",
    });
    assert.equal(s?.host, "gitlab");
    assert.equal(s?.fullName, "group/sub/app");
    assert.equal(s?.composeFile, "compose.yaml");
    assert.equal(
      parseCloneSource({ repo: "https://gitlab.com/group/app" })?.url,
      "https://gitlab.com/group/app",
    );
  });

  test("repo= and compose= must name the same repository", () => {
    assert.equal(
      parseCloneSource({
        repo: "https://github.com/acme/app",
        compose: "https://github.com/other/app/blob/main/docker-compose.yml",
      }),
      null,
    );
    const both = parseCloneSource({
      repo: "https://github.com/acme/app",
      compose: "https://github.com/acme/app/blob/main/docker-compose.yml",
    });
    assert.equal(both?.composeFile, "docker-compose.yml");
    assert.equal(both?.ref, "main");
  });

  test("other hosts, climbing paths and credentials are refused", () => {
    for (const repo of [
      "https://example.com/acme/app",
      "https://github.com/acme",
      "https://user:pw@github.com/acme/app",
      "ftp://github.com/acme/app",
      "https://github.com/acme/app/pulls",
    ])
      assert.equal(parseCloneSource({ repo }), null, repo);
    assert.equal(
      parseCloneSource({
        compose: "https://github.com/acme/app/blob/main/%2E%2E/x.yml",
      }),
      null,
    );
    assert.equal(
      parseCloneSource({ compose: "https://github.com/acme/app" }),
      null,
      "a compose link must name a file",
    );
  });

  test("repository names", () => {
    assert.equal(suggestedRepoName({ fullName: "acme/My App!" }), "My-App");
    assert.equal(cleanRepoName("..dots.."), "dots");
    assert.equal(repoNameProblem("good-name_1.0"), null);
    assert.ok(repoNameProblem(""));
    assert.ok(repoNameProblem("has space"));
    assert.ok(repoNameProblem("thing.git"));
  });
});
