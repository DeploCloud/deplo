import { test } from "node:test";
import assert from "node:assert/strict";

import { MOVE_ENVIRONMENT_NOTE, environmentReachNote } from "./relay-notice";

test("on a cluster the Environment tooltip never ties a name to one server", () => {
  assert.equal(
    environmentReachNote(true),
    "Apps reach this database by name only from the same environment, on any server of the cluster.",
  );
  assert.match(environmentReachNote(false), /and the same server/);
  assert.doesNotMatch(environmentReachNote(true), /same server/);
});

test("the card's tooltip holds for a server and for a cluster", () => {
  assert.match(MOVE_ENVIRONMENT_NOTE, /on the same server or cluster$/);
});
