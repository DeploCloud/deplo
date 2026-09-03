import { test } from "node:test";
import assert from "node:assert/strict";

import { SERVER_USES, serverUse } from "./server-role-badge";

const server = (over: Partial<Parameters<typeof serverUse>[0]> = {}) => ({
  buildOnly: false,
  storageOnly: false,
  importOnly: false,
  ...over,
});

test("a borrowed host is a migration source whatever else its row says", () => {
  assert.equal(
    serverUse(server({ importOnly: true, buildOnly: true })),
    "import",
  );
  assert.equal(
    serverUse(server({ importOnly: true, storageOnly: true })),
    "import",
  );
});

test("each flag names its own use, and no flag is everything", () => {
  assert.equal(serverUse(server({ buildOnly: true })), "build");
  assert.equal(serverUse(server({ storageOnly: true })), "storage");
  assert.equal(serverUse(server()), "everything");
});

test("every use has a chip", () => {
  for (const use of ["everything", "build", "storage", "import"] as const)
    assert.ok(SERVER_USES[use].label && SERVER_USES[use].className);
});
