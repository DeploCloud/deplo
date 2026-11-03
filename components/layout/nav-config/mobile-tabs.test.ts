import { test } from "node:test";
import assert from "node:assert/strict";

import { activeMobileTab, MOBILE_TABS, tabHref } from "./mobile-tabs";

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

test("a tab reopens where you left it; the tab you are in goes back to its root", () => {
  const [home, deployments, storage, more] = MOBILE_TABS;
  const places = {
    storage: "/storage/databases/db_1/backups",
    home: "/apps/blog",
  };
  assert.equal(tabHref(storage, "home", places), places.storage);
  assert.equal(tabHref(storage, "storage", places), "/storage");
  assert.equal(tabHref(home, "storage", places), "/apps/blog");
  assert.equal(tabHref(deployments, "home", places), "/deployments");
  assert.equal(tabHref(more, "home", places), undefined);
});
