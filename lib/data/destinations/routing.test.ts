import { test } from "node:test";
import assert from "node:assert/strict";

import { destinationServerId } from "./credentials";

test("destinationServerId routes a store to its own host and S3 to the workload's", () => {
  assert.equal(
    destinationServerId({ kind: "server", serverId: "srv_store" }, "srv_app"),
    "srv_store",
  );
  assert.equal(
    destinationServerId({ kind: "s3", serverId: null }, "srv_app"),
    "srv_app",
  );
  assert.equal(
    destinationServerId({ kind: "server", serverId: null }, "srv_app"),
    "srv_app",
  );
});
