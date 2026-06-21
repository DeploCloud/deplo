import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDeployRequest } from "./agent-deploy";
import { SourceKind, BuildKind } from "../agent/gen/agent";

/**
 * A multi-service compose stack deploys to a REMOTE server through the agent
 * (Part C). buildDeployRequest is the wire contract: the agent dispatches on
 * source_kind, writes env to a --env-file (the compose interpolates `${VAR}` —
 * NOT a baked `environment:` map like the single-image path), and materialises
 * the mount files. These assertions pin that mapping so the agent's COMPOSE case
 * keeps matching what the control plane sends.
 */

const base = {
  deployId: "dep_1",
  slug: "myapp",
  projectId: "proj_1",
  imageRef: "",
  composeYaml: "services:\n  web:\n    image: nginx\n",
  env: { API_KEY: "secret", PORT: "8080" },
};

test("compose plan → SOURCE_KIND_COMPOSE, no build, no pull", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_COMPOSE);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_NONE);
  assert.equal(req.pullImage, false);
  // No build context is tarred for a compose stack.
  assert.equal(req.contextTar.length, 0);
});

test("compose plan carries the rendered YAML and the decrypted env for the --env-file", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(req.composeYaml, base.composeYaml);
  // The env rides separately (the agent writes it to a 0600 env-file); it is NOT
  // expected to be inlined into the compose YAML for the multi-service path.
  assert.deepEqual(req.env, base.env);
});

test("compose plan maps project mounts to MountFile{path, content}", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: {
      kind: "compose",
      mounts: [
        { filePath: "config.yml", content: "a: 1" },
        { filePath: "nested/app.conf", content: "key=val" },
      ],
    },
  });
  assert.deepEqual(req.mounts, [
    { path: "config.yml", content: "a: 1" },
    { path: "nested/app.conf", content: "key=val" },
  ]);
});

test("compose plan with no mounts sends an empty mounts list", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.deepEqual(req.mounts, []);
});
