import { test } from "node:test";
import assert from "node:assert/strict";

import { changedServices, composeFailureLine } from "./reroute-services";

const stack = (webLabel: string, extra = "") =>
  `services:\n  web:\n    image: web\n    labels: ["${webLabel}"]\n    depends_on: [db]\n  db:\n    image: postgres\n${extra}`;

test("a domain change brings up only the service whose routes changed", () => {
  assert.deepEqual(changedServices(stack("a"), stack("b")), ["web"]);
  assert.deepEqual(changedServices(stack("a"), stack("a")), []);
  // A new service (the App's tunnel connector) is brought up too.
  assert.deepEqual(
    changedServices(stack("a"), stack("a", "  connector:\n    image: cf\n")),
    ["connector"],
  );
});

test("a change every service may read brings the whole stack up, as before", () => {
  assert.equal(
    changedServices(stack("a"), stack("a") + "networks:\n  x: {}\n"),
    null,
  );
  assert.equal(
    changedServices(stack("a", "  old:\n    image: x\n"), stack("a")),
    null,
  );
  assert.equal(changedServices("not: [yaml", stack("a")), null);
});

test("a failed compose up is one short line naming what failed", () => {
  const fise = [
    " Container deplo-fise-fise-1 Running ",
    " Container deplo-fise-fise-db-1 Starting ",
    " Container deplo-fise-fise-db-1 Error dependency fise-db failed to start",
    "dependency failed to start: container deplo-fise-fise-db-1 is unhealthy",
  ].join("\n");
  assert.equal(
    composeFailureLine(fise),
    "fise-db did not pass its health check",
  );
  assert.equal(
    composeFailureLine(
      "dependency failed to start: container deplo-shop-db-1 is unhealthy",
    ),
    "db did not pass its health check",
  );
  assert.equal(
    composeFailureLine(
      "Error response from daemon: driver failed programming external connectivity: port is already allocated",
    ),
    "driver failed programming external connectivity: port is already allocated",
  );
});
