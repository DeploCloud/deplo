import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { buildSchema, execute, parse, validate } from "graphql";

import { UPDATE_SOURCE, updateSourceVariables } from "./apps-configure";
import type { GitRepo } from "../../types/build";

const repo: GitRepo = {
  provider: "github",
  url: "https://github.com/acme/api",
  repo: "acme/api",
  branch: "main",
  installationId: "inst_1",
  triggerType: "tag",
  watchPaths: ["apps/api"],
  submodules: true,
};

test("a branch change keeps the GitHub App and the trigger settings", () => {
  const { input } = updateSourceVariables(
    { appId: "prj_1", source: "GITHUB", branch: "beta" },
    { repo, dockerImage: null },
  );
  assert.deepEqual(input.repo, {
    ...repo,
    branch: "beta",
    connectionId: undefined,
  });
});

test("a server move alone keeps the whole repo", () => {
  const { input } = updateSourceVariables(
    { appId: "prj_1", source: "GITHUB", serverId: "srv_2" },
    { repo, dockerImage: null },
  );
  assert.equal(input.serverId, "srv_2");
  assert.equal(input.repo?.installationId, "inst_1");
  assert.equal(input.repo?.url, repo.url);
});

test("a git connection keeps its provider and credential", () => {
  const gitlab: GitRepo = {
    provider: "gitlab",
    url: "https://gitlab.com/acme/api.git",
    repo: "acme/api",
    branch: "main",
    connectionId: "gc_1",
  };
  const { input } = updateSourceVariables(
    { appId: "prj_1", source: "GIT", branch: "dev" },
    { repo: gitlab, dockerImage: null },
  );
  assert.equal(input.repo?.provider, "gitlab");
  assert.equal(input.repo?.connectionId, "gc_1");
});

test("explicit arguments win over the current values", () => {
  const { input } = updateSourceVariables(
    {
      appId: "prj_1",
      source: "GITHUB",
      repoUrl: "https://github.com/acme/web",
      repo: "acme/web",
      installationId: "inst_2",
    },
    { repo, dockerImage: null },
  );
  assert.equal(input.repo?.url, "https://github.com/acme/web");
  assert.equal(input.repo?.installationId, "inst_2");
});

test("an image app keeps its image on a server move", () => {
  const { input } = updateSourceVariables(
    { appId: "prj_1", source: "DOCKER_IMAGE", serverId: "srv_2" },
    { repo: null, dockerImage: "nginx:1.27" },
  );
  assert.equal(input.dockerImage, "nginx:1.27");
  assert.equal(input.repo, undefined);
});

test("leaving git drops the repo", () => {
  const { input } = updateSourceVariables(
    { appId: "prj_1", source: "DOCKER_IMAGE", dockerImage: "nginx" },
    { repo, dockerImage: null },
  );
  assert.equal(input.repo, undefined);
});

test("the merged variables coerce against the schema", async () => {
  const schema = buildSchema(readFileSync("schema.graphql", "utf8"));
  const document = parse(UPDATE_SOURCE);
  assert.deepEqual(validate(schema, document), []);
  const result = await execute({
    schema,
    document,
    variableValues: updateSourceVariables(
      { appId: "prj_1", source: "GITHUB", branch: "beta" },
      { repo, dockerImage: null },
    ),
    contextValue: {},
  });
  const coercion = (result.errors ?? []).filter((e) =>
    /got invalid value|was not provided|cannot represent/i.test(e.message),
  );
  assert.deepEqual(
    coercion.map((e) => e.message),
    [],
  );
});
