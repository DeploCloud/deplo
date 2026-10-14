import { test } from "node:test";
import assert from "node:assert/strict";

import { pushSubscriptions } from "../db/schema/control-plane/notifications";
import { TEAM_A, TEAM_B } from "../data/identity-test-helpers";
import {
  ADMIN,
  APP_IN_FLD,
  APP_OUT_FLD,
  DEV,
  FLD_IN,
  T0,
  as,
  scopeTo,
  setupRoleScope,
} from "../data/role-scope/role-scope-test-helpers";
import { removeMember } from "../data/members/removal";
import { removeUserFromTeam } from "../data/user-access";
import { savePushSubscription, sendWebPushTo } from "./web-push";

const h = setupRoleScope();

const subscribe = (teamId: string, userId: string) =>
  savePushSubscription(teamId, userId, {
    endpoint: `https://push.acme.test/${teamId}/${userId}`,
    p256dh: "k",
    auth: "a",
  });

const endpoints = async () =>
  (await h.db.select().from(pushSubscriptions)).map((s) => s.endpoint).sort();

// No VAPID keys on purpose: "not set up" means at least one subscriber was picked.
const alert = (appId?: string) =>
  sendWebPushTo(TEAM_A, null, {
    key: "deployment_failed",
    title: "t",
    body: "b",
    url: null,
    ts: T0,
    appId,
  });

for (const [how, remove] of [
  ["removeMember", () => as(ADMIN, () => removeMember(DEV))],
  [
    "removeUserFromTeam",
    () => as(ADMIN, () => removeUserFromTeam({ userId: DEV, teamId: TEAM_A })),
  ],
] as const)
  test(`${how} takes the member's push alerts for that team with it`, async () => {
    await subscribe(TEAM_A, DEV);
    await subscribe(TEAM_B, DEV);
    await subscribe(TEAM_A, ADMIN);
    await remove();
    assert.deepEqual(await endpoints(), [
      `https://push.acme.test/${TEAM_A}/${ADMIN}`,
      `https://push.acme.test/${TEAM_B}/${DEV}`,
    ]);
  });

test("a team alert skips a subscriber who is no longer a member", async () => {
  await subscribe(TEAM_A, DEV);
  await h.pg.exec(`delete from memberships where user_id = '${DEV}';`);
  await assert.doesNotReject(alert());
});

test("a member whose role covers part of the team gets push only for apps they reach", async () => {
  await scopeTo(h, { folders: [FLD_IN] });
  await subscribe(TEAM_A, DEV);
  await assert.doesNotReject(alert(APP_OUT_FLD));
  await assert.doesNotReject(alert());
  await assert.rejects(alert(APP_IN_FLD), /not set up/);
});

test("a whole-team member still gets every team alert", async () => {
  await subscribe(TEAM_A, DEV);
  await assert.rejects(alert(), /not set up/);
});
