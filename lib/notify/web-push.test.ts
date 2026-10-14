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
import { saveNotificationChannel } from "../data/notifications";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import {
  sweepDomainDns,
  __resetDnsResolve4ForTest,
  __setDnsResolve4ForTest,
} from "../data/domains/dns-check";
import {
  __resetAgentAddressesForTest,
  __setAgentAddressesForTest,
} from "../data/servers/addresses";
import type { NotificationChannelInput } from "../types/notification";
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

test("a DNS alert about an app a scoped member reaches is pushed to them", async (t) => {
  await scopeTo(h, { folders: [FLD_IN] });
  await subscribe(TEAM_A, DEV);
  await as(ADMIN, () =>
    saveNotificationChannel(null, {
      kind: "push",
      name: "",
      enabled: true,
      url: "",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["domain_dns_drift"],
    } as NotificationChannelInput),
  );
  await h.db.insert(domainsTable).values({
    id: "dom_push",
    appId: APP_IN_FLD,
    name: "in.acme.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    createdAt: T0,
  });
  __setAgentAddressesForTest(async () => ["10.0.0.1"]);
  __setDnsResolve4ForTest(async () => ["203.0.113.9"]);
  // The send is detached; with no VAPID keys it fails loudly once it has picked a subscriber.
  const errors = t.mock.method(console, "error", () => {});
  const pushed = () =>
    errors.mock.calls.some((c) =>
      String(c.arguments[1]).includes("not set up"),
    );
  try {
    await sweepDomainDns();
    for (let i = 0; i < 100 && !pushed(); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(pushed(), "the drift alert never reached the member's browser");
  } finally {
    __resetDnsResolve4ForTest();
    __resetAgentAddressesForTest();
  }
});
