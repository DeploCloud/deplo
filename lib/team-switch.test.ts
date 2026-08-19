import { test } from "node:test";
import assert from "node:assert/strict";

import { teamSwitchDestination } from "./team-switch";

/** Section pages exist in every team — switching keeps the viewer on them. */
test("stays on team-agnostic section pages", () => {
  for (const path of [
    "/",
    "/deployments",
    "/logs",
    "/storage",
    "/variables",
    "/templates",
    "/members",
    "/settings/members",
    "/settings/roles",
    "/activity",
    "/monitoring",
    "/new",
    "/settings",
    "/settings/registries",
    "/settings/git",
    "/settings/account",
    "/settings/servers",
  ]) {
    assert.equal(teamSwitchDestination(path), path);
  }
});

test("drops the query string — filters and selections name the old team's rows", () => {
  assert.equal(teamSwitchDestination("/variables?tab=shared"), "/variables");
  assert.equal(teamSwitchDestination("/?project=prc_1&env=environ_1"), "/");
  assert.equal(teamSwitchDestination("/templates?folder=fld_1"), "/templates");
  assert.equal(teamSwitchDestination("/new?template=t&repo=o%2Fr"), "/new");
});

test("leaves an App page for the Overview", () => {
  assert.equal(teamSwitchDestination("/apps/my-app"), "/");
  assert.equal(teamSwitchDestination("/apps/my-app/logs"), "/");
  assert.equal(teamSwitchDestination("/apps/my-app/settings/resources"), "/");
  assert.equal(teamSwitchDestination("/apps/my-app/deployments/dep_1"), "/");
});

test("leaves a Database page for Storage, not the Overview", () => {
  assert.equal(teamSwitchDestination("/storage/databases/db_1"), "/storage");
  assert.equal(teamSwitchDestination("/storage/databases/db_1/logs"), "/storage");
  assert.equal(
    teamSwitchDestination("/storage/databases/db_1/settings/connection"),
    "/storage",
  );
});

test("leaves a Project stub for the Overview", () => {
  assert.equal(teamSwitchDestination("/projects"), "/");
  assert.equal(teamSwitchDestination("/projects/my-project"), "/");
});

test("normalizes odd paths", () => {
  assert.equal(teamSwitchDestination("/variables/"), "/variables");
  assert.equal(teamSwitchDestination("/apps/"), "/");
  assert.equal(teamSwitchDestination(""), "/");
  assert.equal(teamSwitchDestination("/logs#tail"), "/logs");
});

/** A section must not be mistaken for a resource by prefix alone. */
test("does not confuse a section with a resource route", () => {
  assert.equal(teamSwitchDestination("/storage"), "/storage");
  assert.equal(teamSwitchDestination("/settings/servers"), "/settings/servers");
});
