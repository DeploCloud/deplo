import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ANSWER_ALIAS,
  ANSWER_ENTRYPOINT,
  ANSWER_PORT,
  ANSWER_TRANSPORT,
  answerPorts,
  answerRoutes,
} from "./answer";
import { ANSWER_ROUTES_FILE } from "./traefik-stack";

// The routes this renders and the forms the server agent accepts are one contract across two repos
// (docs/agents/cluster-rollout.md): the agent keeps the same file and parses it as its own test.
const golden = JSON.parse(
  readFileSync(join(__dirname, "answer-routes.golden.json"), "utf8"),
);

test("the routes rendered for one App are the reference the server agent checks", () => {
  assert.deepEqual(
    answerRoutes(golden.appId, golden.hosts, golden.slot),
    golden.routes,
  );
  assert.deepEqual(answerPorts(golden.slot), {
    tls: golden.tlsPort,
    web: golden.webPort,
  });
  assert.deepEqual(
    {
      alias: ANSWER_ALIAS,
      transport: `${ANSWER_TRANSPORT}@file`,
      routesFile: ANSWER_ROUTES_FILE,
      entrypoint: ANSWER_ENTRYPOINT,
      entrypointPort: ANSWER_PORT,
    },
    {
      alias: golden.alias,
      transport: golden.transport,
      routesFile: golden.routesFile,
      entrypoint: golden.entrypoint,
      entrypointPort: golden.entrypointPort,
    },
  );
});

test("the server agent's copy of the reference, beside this repo, says the same", (t) => {
  const repo =
    process.env.DEPLO_AGENT_REPO ?? join(__dirname, "../../../deplo-agent");
  const theirs = join(
    repo,
    "internal/server/testdata/answer-routes.golden.json",
  );
  if (!existsSync(theirs)) {
    t.skip("no deplo-agent checkout beside this repo (set DEPLO_AGENT_REPO)");
    return;
  }
  assert.deepEqual(JSON.parse(readFileSync(theirs, "utf8")), golden);
});
