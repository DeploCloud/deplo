import { test } from "node:test";
import assert from "node:assert/strict";

import { describeAppSource } from "./app-source";

const repo = {
  provider: "github" as const,
  url: "https://github.com/acme/web",
  repo: "acme/web",
  branch: "main",
};

test("a repository that deploys its own compose file is still described by its repo", () => {
  const d = describeAppSource({
    source: "github",
    compose: "services: {}",
    repo,
    dockerImage: null,
  });
  assert.equal(d.isGit, true);
  assert.equal(d.label, "acme/web");
});

test("a pasted compose stack is described as Compose", () => {
  const d = describeAppSource({
    source: "compose",
    compose: "services: {}",
    repo: null,
    dockerImage: null,
  });
  assert.equal(d.label, "Compose");
  assert.equal(d.isGit, false);
});
