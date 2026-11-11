import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";

import { renderServerView } from "@/components/servers/server-test-helpers";
import { ReplicasForm, replicasSaved } from "./replicas-form";

const text = (props: Partial<Parameters<typeof ReplicasForm>[0]> = {}) =>
  renderServerView(
    createElement(ReplicasForm, {
      appId: "prj_1",
      replicas: 1,
      refusal: null,
      agentTooOld: false,
      ...props,
    }),
  ).replace(/<[^>]+>/g, " ");

test("saving a count never says it is running: it applies from the next deploy", () => {
  assert.equal(replicasSaved(3), "3 replicas from the next deploy");
  assert.equal(replicasSaved(1), "1 replica from the next deploy");
});

test("the setting says a deploy briefly uses twice the memory", () => {
  assert.match(
    text(),
    /A deploy briefly uses twice the memory while the new replicas start\./,
  );
});

test("a server agent too old for replicas is named, with what Deplo does about it", () => {
  assert.match(
    text({ agentTooOld: true }),
    /The server agent on this server is too old to run more than one replica of an App\. Deplo updates it on its own\./,
  );
});

test("the refusal reads as the spec writes it", () => {
  assert.match(
    text({
      refusal:
        "An App that keeps data on its own disk runs one copy. Keep the data in a database to run more.",
    }),
    /runs one copy\. Keep the data in a database to run more\./,
  );
});
