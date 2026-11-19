import { test } from "node:test";
import assert from "node:assert/strict";

import type { DeploymentRow } from "./deployments-table/deployment-row";
import {
  matchesDateWindow,
  searchHaystack,
  serverSweep,
} from "./deployments-table/use-deployment-filters";

const row: DeploymentRow = {
  id: "dep_abc123",
  appId: "prj_1",
  appSlug: "my-api",
  serviceName: "My API",
  serverId: "srv_1",
  serverName: "eu-main-1",
  buildServerName: null,
  commitMessage: "fix(auth): stop the retry loop",
  commitSha: "9f3c1de",
  commitUrl: "https://github.com/acme/my-api/commit/9f3c1de",
  pullRequestUrl: "https://github.com/acme/my-api/pull/42",
  prNumber: 42,
  status: "ready",
  branch: "feat/login",
  createdAt: "2026-08-25T00:00:00.000Z",
  creator: "octocat",
  url: "https://my-api.example.com",
};

test("a deployment is findable by id, sha, PR number, branch and app", () => {
  const hay = searchHaystack(row);
  for (const needle of [
    "dep_abc123",
    "9f3c1de",
    "#42",
    "feat/login",
    "my-api",
    "eu-main-1",
    "octocat",
    "retry loop",
  ]) {
    assert.ok(hay.includes(needle.toLowerCase()), `expected to find ${needle}`);
  }
  assert.ok(!hay.includes("staging"));
});

test("the Created windows split at their edge, and 'older' is the complement", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  const at = (hoursAgo: number) =>
    new Date(now - hoursAgo * 3_600_000).toISOString();

  assert.ok(matchesDateWindow(at(1), "24h", now));
  assert.ok(!matchesDateWindow(at(25), "24h", now));
  assert.ok(matchesDateWindow(at(25), "7d", now));
  assert.ok(!matchesDateWindow(at(24 * 8), "7d", now));
  assert.ok(matchesDateWindow(at(24 * 8), "30d", now));
  assert.ok(!matchesDateWindow(at(24 * 31), "30d", now));
  assert.ok(matchesDateWindow(at(24 * 31), "older", now));
  assert.ok(!matchesDateWindow(at(1), "older", now));
});

test("Delete all sweeps on the server only while each filter holds one value", () => {
  assert.deepEqual(
    serverSweep({ app: [], server: ["srv_1"], status: ["error"] }),
    {
      appId: null,
      serverId: "srv_1",
      status: "error",
    },
  );
  assert.equal(
    serverSweep({ app: [], server: [], status: ["error", "canceled"] }),
    null,
  );
  assert.equal(serverSweep({ app: ["a", "b"], server: [], status: [] }), null);
  assert.equal(
    serverSweep({ app: [], server: [], status: [] }, "prj_1")?.appId,
    "prj_1",
  );
});
