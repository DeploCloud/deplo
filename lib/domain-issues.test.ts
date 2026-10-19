import { test } from "node:test";
import assert from "node:assert/strict";
import { domainNeedsAttention, domainRoutingWarning } from "./domain-issues";
import type { DomainStatus } from "./types/domain";

test("overview includes every unsettled DNS state and hides healthy domains", () => {
  const states: DomainStatus[] = [
    "pending",
    "misconfigured",
    "error",
    "cloudflare",
  ];
  for (const status of states)
    assert.equal(domainNeedsAttention({ status }, false, []), true);
  assert.equal(domainNeedsAttention({ status: "valid" }, false, []), false);
});

test("valid DNS still warns when a Compose domain has no usable service", () => {
  for (const service of [undefined, "", "removed", "deplo"]) {
    assert.equal(
      domainNeedsAttention({ status: "valid", service }, true, ["web"]),
      true,
    );
    assert.ok(domainRoutingWarning({ service }, true, ["web"]));
  }
  assert.equal(
    domainNeedsAttention({ status: "valid", service: "web" }, true, ["web"]),
    false,
  );
  assert.equal(domainRoutingWarning({ service: "web" }, true, []), null);
});
