import { test } from "node:test";
import assert from "node:assert/strict";

import { activeMobileTab, MOBILE_TABS } from "./mobile-tabs";

test("each page lights the tab it belongs to", () => {
  const cases: [string, string][] = [
    ["/", "home"],
    ["/apps/blog/domains", "home"],
    ["/deployments", "deployments"],
    ["/storage/databases/db_1/backups", "storage"],
    ["/logs", "more"],
    ["/variables", "more"],
    ["/settings/members", "more"],
    ["/deploymentsx", "home"],
  ];
  for (const [path, tab] of cases)
    assert.equal(activeMobileTab(path), tab, path);
});

test("the tab bar holds four slots, More last", () => {
  assert.equal(MOBILE_TABS.length, 4);
  assert.equal(MOBILE_TABS.at(-1)?.id, "more");
});
