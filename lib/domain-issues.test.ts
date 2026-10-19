import { test } from "node:test";
import assert from "node:assert/strict";
import { domainRoutingWarning } from "./domain-issues";

test("valid DNS still warns when a Compose domain has no usable service", () => {
  for (const service of [undefined, "", "removed", "deplo"]) {
    assert.ok(domainRoutingWarning({ service }, true, ["web"]));
  }
  assert.equal(domainRoutingWarning({ service: "web" }, true, ["web"]), null);
  assert.equal(domainRoutingWarning({ service: "web" }, true, []), null);
  assert.equal(domainRoutingWarning({}, false, []), null);
});
