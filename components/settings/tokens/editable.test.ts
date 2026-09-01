import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenEditable } from "./editable";

/**
 * The rule the list icon and the token's own page must agree on. They did not:
 * the list refused an OAuth-minted token the page saved happily.
 */

const MINE = { createdByUserId: "usr_me", homeTeamId: "team_other" };
const THEIRS = { createdByUserId: "usr_them", homeTeamId: "team_here" };
const ctx = { userId: "usr_me", activeTeamId: "team_here", canManage: true };

test("your own token is editable from any team", () => {
  assert.equal(tokenEditable(MINE, ctx), true);
});

test("someone else's is editable from the team it is managed in", () => {
  assert.equal(tokenEditable(THEIRS, ctx), true);
  assert.equal(
    tokenEditable(THEIRS, { ...ctx, activeTeamId: "team_elsewhere" }),
    false,
  );
});

test("without manage_tokens nothing is editable", () => {
  assert.equal(tokenEditable(MINE, { ...ctx, canManage: false }), false);
  assert.equal(tokenEditable(THEIRS, { ...ctx, canManage: false }), false);
});

test("an MCP connection is not a case of its own", () => {
  // It is an `api_tokens` row like any other, and `updateToken` has never
  // refused one: the list used to show a padlock over a page that saved.
  assert.equal(
    tokenEditable({ ...MINE, homeTeamId: "team_here" }, ctx),
    tokenEditable(THEIRS, ctx),
  );
});
