import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { RestartWhenUnresponsiveForm } from "./restart-when-unresponsive-form";

const row = (over: { ownCheck?: boolean; paused?: boolean } = {}) =>
  renderServerView(
    createElement(RestartWhenUnresponsiveForm, {
      appId: "prj_1",
      enabled: true,
      paused: false,
      needsNewerAgent: false,
      ...over,
    }),
  ).replace(/<[^>]+>/g, " ");

test("with no health check of its own, any answer on / counts", () => {
  assert.match(
    row(),
    /Restarts the app after 3 failed checks in a row\. With no health check of its own, any answer on \/ counts\./,
  );
});

test("an app's own health check decides instead, and the default is not promised", () => {
  const own = row({ ownCheck: true });
  assert.match(
    own,
    /Restarts the app when it keeps failing its own health check\./,
  );
  assert.doesNotMatch(own, /any answer/);
});
