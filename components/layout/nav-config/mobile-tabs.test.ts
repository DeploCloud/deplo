import { test } from "node:test";
import assert from "node:assert/strict";

import { activeMobileTab, visibleMobileTabs } from "./mobile-tabs";

test("each page lights the tab it belongs to", () => {
  const cases: [string, string][] = [
    ["/", "home"],
    ["/apps/blog/domains", "home"],
    ["/deployments", "deployments"],
    ["/storage/databases/db_1/backups", "storage"],
    ["/logs", "logs"],
    ["/variables", "more"],
    ["/settings/members", "more"],
    ["/deploymentsx", "home"],
  ];
  for (const [path, tab] of cases)
    assert.equal(activeMobileTab(path), tab, path);
});

test("a member without view_logs gets four tabs, never a Logs tab", () => {
  const ids = (caps: string[]) =>
    visibleMobileTabs(new Set(caps)).map((t) => t.id);
  assert.deepEqual(ids([]), ["home", "deployments", "storage", "more"]);
  assert.deepEqual(ids(["view_logs"]), [
    "home",
    "deployments",
    "storage",
    "logs",
    "more",
  ]);
});
