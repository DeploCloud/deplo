import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { RestartWhenUnresponsiveForm } from "./restart-when-unresponsive-form";

const row = (
  over: {
    ownCheck?: boolean;
    paused?: boolean;
    needsNewerAgent?: boolean;
  } = {},
) =>
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

test("the switch reads Restart when it stops answering, and says when Deplo has given up", () => {
  assert.match(row(), /Restart when it stops answering/);
  assert.match(
    row({ paused: true }),
    /Not answering · restarts paused\. It resumes after your next deploy, a manual restart, or 30 quiet minutes\./,
  );
});

test("a server agent too old for it is said, never a switch that looks like it works", () => {
  const old = row({ needsNewerAgent: true });
  assert.match(
    old,
    /Automatic restart needs a newer server agent\. Deplo updates it on its own\./,
  );
  assert.doesNotMatch(old, /3 failed checks/);
});
