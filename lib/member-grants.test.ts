import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildGrants,
  groupNodes,
} from "@/app/(dashboard)/settings/members/[id]/member-detail-tabs";
import type { Capability } from "./types";

/**
 * The marshalling behind the member page's Save, which is a WHOLE-SET REPLACE:
 * a node left out of the payload is a node revoked. Two bugs lived here, and
 * both destroyed data rather than merely misreporting it.
 */

const node = (
  kind: "project" | "folder" | "app",
  nodeId: string,
  ...caps: Capability[]
) => ({
  kind,
  nodeId,
  name: nodeId,
  capabilities: caps,
});

const selection = (
  over: Partial<Record<"projectIds" | "folderIds" | "appIds", string[]>> = {},
) => ({
  teamIds: [],
  projectIds: over.projectIds ?? [],
  environmentIds: [],
  folderIds: over.folderIds ?? [],
  appIds: over.appIds ?? [],
});

test("two shares at different levels stay two, through a save", () => {
  const nodes = [
    node("folder", "fld_prod", "view", "manage_env"),
    node("folder", "fld_stg", "view", "manage_env"),
    node("app", "prj_api", "view", "deploy_apps"),
  ];
  const groups = groupNodes(nodes);
  assert.equal(groups.length, 2, "one group per distinct set");

  const out = buildGrants(
    selection({ folderIds: ["fld_prod", "fld_stg"], appIds: ["prj_api"] }),
    groups,
    ["view", "manage_env"],
    false,
  );
  assert.equal(out.length, 2, "and two payload entries, not one flattened set");
  const byCaps = new Map(
    out.map((g) => [[...g.capabilities].sort().join(","), g]),
  );
  assert.deepEqual(byCaps.get("manage_env,view")?.folderIds.sort(), [
    "fld_prod",
    "fld_stg",
  ]);
  assert.deepEqual(byCaps.get("deploy_apps,view")?.appIds, ["prj_api"]);
});

test("a node the admin just ticked carries the set the picker shows", () => {
  const groups = groupNodes([node("folder", "fld_prod", "view", "manage_env")]);
  const out = buildGrants(
    selection({ folderIds: ["fld_prod"], appIds: ["prj_new"] }),
    groups,
    ["view", "manage_env"],
    false,
  );
  // The new app joins the authored group (the picker's set, which is group 0),
  // so it is one entry rather than two identical ones.
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].folderIds, ["fld_prod"]);
  assert.deepEqual(out[0].appIds, ["prj_new"]);
});

test("unticking a node drops it, which is how a share is revoked", () => {
  const groups = groupNodes([
    node("folder", "fld_prod", "view", "manage_env"),
    node("app", "prj_api", "view", "manage_env"),
  ]);
  const out = buildGrants(
    selection({ folderIds: ["fld_prod"] }),
    groups,
    ["view", "manage_env"],
    false,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(
    out[0].appIds,
    [],
    "the untickled app is gone from the payload",
  );
});

test("nothing ticked writes nothing, and no group survives it", () => {
  const groups = groupNodes([node("app", "prj_api", "view", "manage_env")]);
  assert.deepEqual(buildGrants(selection(), groups, ["view"], false), []);
});

test("editing the permission list applies it to every node they hold", () => {
  const groups = groupNodes([
    node("folder", "fld_prod", "view", "manage_env"),
    node("app", "prj_api", "view", "deploy_apps"),
  ]);
  const out = buildGrants(
    selection({ folderIds: ["fld_prod"], appIds: ["prj_api"] }),
    groups,
    ["view", "view_logs"],
    true,
  );
  assert.equal(
    out.length,
    1,
    "one set, because the admin just said what it is",
  );
  assert.deepEqual(out[0].capabilities, ["view", "view_logs"]);
});
