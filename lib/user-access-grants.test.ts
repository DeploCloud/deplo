import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accessSignature,
  emptyTickedNodes,
  groupGrants,
  type TickedNode,
} from "./user-access-grants";

const node = (
  kind: TickedNode["kind"],
  nodeId: string,
  ...capabilities: TickedNode["capabilities"]
): TickedNode => ({ kind, nodeId, capabilities });

test("nodes sharing a capability set travel as one payload", () => {
  const grants = groupGrants([
    node("app", "prj_a", "view", "deploy_apps"),
    node("app", "prj_b", "deploy_apps", "view"),
    node("folder", "fld_1", "view", "deploy_apps"),
  ]);
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].appIds, ["prj_a", "prj_b"]);
  assert.deepEqual(grants[0].folderIds, ["fld_1"]);
  assert.deepEqual(grants[0].projectIds, []);
  // The floor is implied server-side and never stored, so it never rides along.
  assert.deepEqual(grants[0].capabilities, ["deploy_apps"]);
});

test("a different set is a different payload", () => {
  const grants = groupGrants([
    node("app", "prj_a", "deploy_apps"),
    node("project", "prc_1", "deploy_apps", "delete_apps"),
  ]);
  assert.equal(grants.length, 2);
  assert.deepEqual(grants[0].appIds, ["prj_a"]);
  assert.deepEqual(grants[1].projectIds, ["prc_1"]);
});

test("a node granting nothing is never sent", () => {
  const nodes = [node("app", "prj_a", "view"), node("app", "prj_b")];
  assert.deepEqual(groupGrants(nodes), []);
  assert.deepEqual(
    emptyTickedNodes(nodes).map((n) => n.nodeId),
    ["prj_a", "prj_b"],
  );
});

test("the signature ignores order but not content", () => {
  const a = accessSignature({
    roleId: "role_1",
    granular: true,
    nodes: [
      node("app", "prj_a", "deploy_apps", "view_logs"),
      node("app", "prj_b", "deploy_apps"),
    ],
  });
  const reordered = accessSignature({
    roleId: "role_1",
    granular: true,
    nodes: [
      node("app", "prj_b", "deploy_apps"),
      node("app", "prj_a", "view_logs", "view", "deploy_apps"),
    ],
  });
  assert.equal(a, reordered);

  const changed = accessSignature({
    roleId: "role_1",
    granular: true,
    nodes: [node("app", "prj_a", "deploy_apps")],
  });
  assert.notEqual(a, changed);
});

test("ticked nodes stop counting once granular is off", () => {
  const nodes = [node("app", "prj_a", "deploy_apps")];
  assert.equal(
    accessSignature({ roleId: "role_1", granular: false, nodes }),
    accessSignature({ roleId: "role_1", granular: false, nodes: [] }),
  );
  assert.notEqual(
    accessSignature({ roleId: "role_1", granular: true, nodes }),
    accessSignature({ roleId: "role_1", granular: false, nodes }),
  );
});
