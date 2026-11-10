import { test } from "node:test";
import assert from "node:assert/strict";

import { replicaIndexOf, replicaLabels, replicaTag } from "./replica-names";

test("the index comes from the container name", () => {
  assert.equal(replicaIndexOf("deplo-web-deplo-web-3"), 3);
  assert.equal(replicaIndexOf("deplo-web"), null);
  assert.equal(replicaIndexOf("deplo-web-api"), null);
});

test("copies of a single-image App read web-1, web-2", () => {
  const names = ["deplo-web-deplo-web-2", "deplo-web-deplo-web-1"];
  const labels = replicaLabels(names, "web");
  assert.equal(labels.get(names[0])!.label, "web-2");
  assert.equal(labels.get(names[1])!.label, "web-1");
});

test("a compose service with copies is tagged by its own name", () => {
  const labels = replicaLabels(
    ["deplo-shop-api-1", "deplo-shop-api-2", "deplo-shop-db-1"],
    "shop",
  );
  assert.equal(labels.get("deplo-shop-api-2")!.label, "api-2");
  assert.equal(labels.has("deplo-shop-db-1"), false, "one copy is no replica");
});

test("one container is not a replica group", () => {
  assert.equal(replicaLabels(["deplo-web-deplo-web-1"], "web").size, 0);
  assert.equal(replicaLabels(["deplo-web"], "web").size, 0);
});

test("a known copy is tagged without looking at its siblings", () => {
  assert.equal(replicaTag("deplo-web-deplo-web-2", "web"), "web-2");
  assert.equal(replicaTag("deplo-shop-api-3", "shop"), "api-3");
  assert.equal(replicaTag("deplo-web", "web"), "deplo-web");
});
