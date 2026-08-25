import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  notificationAlerts,
  notificationChannels,
  pushSubscriptions,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { DEFAULT_ALERTS } from "../alerts";
import { ALL_ALERTS } from "../types";
import type { NotificationChannelInput } from "../types";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./leaf-test-helpers";

/** The seeder ships one user; TEAM_B needs its own owner for the scoping test. */
const USER_2 = "user_2";
import {
  channelsForAlert,
  deleteNotificationChannel,
  listNotificationChannels,
  parseChannelInput,
  saveNotificationChannel,
  subscribeWebPush,
} from "./notifications";

/**
 * Data-layer tests for notification channels against pglite. A team has N
 * configured destinations and any kind may repeat, so the thing under test is the
 * INSTANCE: its config, its credentials, and its own alert selection.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table notification_alerts, notification_channels, push_subscriptions, users, teams restart identity cascade;`,
  );
  // USER_2 owns TEAM_B, so the cross-team test below is refused by the row's
  // scoping rather than by a missing capability.
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
    ],
  });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/**
 * A channel of `kind`, overridden as the test needs. Bare hostnames never
 * resolve, so the outbound guard passes them through untouched.
 */
function draft(
  over: Partial<NotificationChannelInput> = {},
): NotificationChannelInput {
  return {
    kind: "discord",
    name: "",
    enabled: true,
    url: "https://discord/hook",
    target: "",
    emailFrom: "",
    emailProvider: "resend",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    alerts: ["deployment_failed", "backup_failed"],
    ...over,
  } as NotificationChannelInput;
}

test("a team with nothing configured has no channels", async () => {
  await asUser1(async () => {
    assert.deepEqual(await listNotificationChannels(), []);
  });
});

test("a saved channel round-trips, with its credentials reduced to bits", async () => {
  await asUser1(async () => {
    await saveNotificationChannel(
      null,
      draft({
        kind: "telegram",
        name: "On-call",
        url: "",
        target: "-100123",
        secrets: { secret: "123:ABC" },
      }),
    );
    const [got] = await listNotificationChannels();
    assert.equal(got.kind, "telegram");
    assert.equal(got.name, "On-call");
    assert.equal(got.target, "-100123");
    assert.equal(got.secretSet, true, "a stored credential is one bit");
    assert.deepEqual(got.alerts, ["deployment_failed", "backup_failed"]);
    assert.ok(got.id.startsWith("chan_"));
  });
});

test("the same kind can be added twice, each with its own alerts", async () => {
  await asUser1(async () => {
    await saveNotificationChannel(
      null,
      draft({ name: "Everything", alerts: [...ALL_ALERTS] }),
    );
    await saveNotificationChannel(
      null,
      draft({
        name: "Failures only",
        url: "https://discord/other",
        alerts: ["deployment_failed"],
      }),
    );
    const got = await listNotificationChannels();
    assert.equal(got.length, 2);
    assert.deepEqual(
      got.map((c) => c.kind),
      ["discord", "discord"],
    );
    assert.notEqual(got[0].id, got[1].id);
  });
  // And the dispatcher agrees: only the room that asked for it is dialed. THIS
  // is the regression net for the lookup that used to key on `kind`, which is
  // the same answer for both of them.
  assert.equal((await channelsForAlert(TEAM_A, "deployment_failed")).length, 2);
  assert.equal(
    (await channelsForAlert(TEAM_A, "deployment_succeeded")).length,
    1,
    "only the channel that subscribed to it",
  );
});

test("a channel with NO alert rows lands on the catalog defaults", async () => {
  let id = "";
  await asUser1(async () => {
    id = (await saveNotificationChannel(null, draft())).id;
  });
  // A channel nobody has decided about — which is exactly the state a brand-new
  // one is in, since nothing is seeded on create.
  await db
    .delete(notificationAlerts)
    .where(eq(notificationAlerts.channelId, id));
  await asUser1(async () => {
    const [got] = await listNotificationChannels();
    assert.deepEqual(got.alerts, DEFAULT_ALERTS);
  });
});

test("one save writes one row per catalog key, for that channel only", async () => {
  await asUser1(async () => {
    await saveNotificationChannel(null, draft());
    await saveNotificationChannel(null, draft({ url: "https://discord/two" }));
  });
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.length, ALL_ALERTS.length * 2);
});

test("deleting a channel takes its alert rows with it", async () => {
  let keep = "";
  await asUser1(async () => {
    const a = await saveNotificationChannel(null, draft());
    keep = (await saveNotificationChannel(null, draft({ url: "https://d/2" })))
      .id;
    await deleteNotificationChannel(a.id);
  });
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.length, ALL_ALERTS.length);
  assert.ok(
    rows.every((r) => r.channelId === keep),
    "the FK cascade did it, not application code",
  );
});

test("the kind is frozen once the channel exists", async () => {
  await asUser1(async () => {
    const saved = await saveNotificationChannel(null, draft());
    // An instance that changed kind would carry an alert selection made about
    // something else entirely.
    await saveNotificationChannel(saved.id, draft({ kind: "slack" }));
    const [got] = await listNotificationChannels();
    assert.equal(got.kind, "discord");
  });
});

test("an empty secret keeps the stored ciphertext; a new one replaces it", async () => {
  let id = "";
  await asUser1(async () => {
    id = (
      await saveNotificationChannel(
        null,
        draft({
          kind: "gotify",
          url: "https://gotify",
          secrets: { secret: "tok" },
        }),
      )
    ).id;
  });
  const before = (await db.select().from(notificationChannels))[0]!;

  // Same address, so an edit that only renames the channel keeps the token.
  await asUser1(() =>
    saveNotificationChannel(
      id,
      draft({
        kind: "gotify",
        url: "https://gotify",
        name: "Ops room",
        secrets: {},
      }),
    ),
  );
  const kept = (await db.select().from(notificationChannels))[0]!;
  assert.equal(kept.name, "Ops room");
  assert.equal(kept.secretEnc, before.secretEnc);
  assert.notEqual(kept.secretEnc, "");

  await asUser1(() =>
    saveNotificationChannel(
      id,
      draft({
        kind: "gotify",
        url: "https://gotify",
        secrets: { secret: "other" },
      }),
    ),
  );
  const changed = (await db.select().from(notificationChannels))[0]!;
  assert.notEqual(changed.secretEnc, before.secretEnc);
});

test("a stored token is never forwarded to an address that just changed", async () => {
  let id = "";
  await asUser1(async () => {
    id = (
      await saveNotificationChannel(
        null,
        draft({
          kind: "gotify",
          url: "https://gotify",
          secrets: { secret: "tok" },
        }),
      )
    ).id;
  });
  const before = (await db.select().from(notificationChannels))[0]!;

  // Repointing the channel while leaving the secret blank would have the stored
  // token delivered to whoever owns the new address — in a header, on the first
  // alert. The save is refused instead, and nothing is written.
  await assert.rejects(
    () =>
      asUser1(() =>
        saveNotificationChannel(
          id,
          draft({ kind: "gotify", url: "https://gotify2", secrets: {} }),
        ),
      ),
    /enter this channel's token or password again/,
  );
  const untouched = (await db.select().from(notificationChannels))[0]!;
  assert.equal(untouched.url, "https://gotify");
  assert.equal(untouched.secretEnc, before.secretEnc);

  // Re-typing it is what makes the move legitimate.
  await asUser1(() =>
    saveNotificationChannel(
      id,
      draft({
        kind: "gotify",
        url: "https://gotify2",
        secrets: { secret: "tok2" },
      }),
    ),
  );
  const moved = (await db.select().from(notificationChannels))[0]!;
  assert.equal(moved.url, "https://gotify2");
  assert.notEqual(moved.secretEnc, before.secretEnc);
});

test("the DTO carries no credential in any shape", async () => {
  await asUser1(async () => {
    await saveNotificationChannel(
      null,
      draft({
        kind: "pushover",
        url: "",
        secrets: { secret: "po-token", secret2: "po-user" },
      }),
    );
    const json = JSON.stringify(await listNotificationChannels());
    assert.equal(json.includes("po-token"), false);
    assert.equal(json.includes("po-user"), false);
    assert.equal(/Enc"|"secret"|"secret2"|password/.test(json), false);
  });
});

test("a URL aimed inside the network is refused before it is stored", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () =>
        // The self-hosted case the owner explicitly chose to keep refused.
        saveNotificationChannel(
          null,
          draft({ kind: "gotify", url: "https://127.0.0.1:8080" }),
        ),
      /private or internal/,
    );
  });
  assert.equal((await db.select().from(notificationChannels)).length, 0);
});

test("another team's channel is out of reach, and its row survives", async () => {
  let id = "";
  await asUser1(async () => {
    id = (await saveNotificationChannel(null, draft())).id;
  });
  // USER_2 owns TEAM_B and holds every capability THERE, so the refusal has to
  // come from the row being scoped to another team, not from a missing grant.
  await runWithIdentity({ userId: USER_2, teamId: TEAM_B }, async () => {
    await assert.rejects(() => deleteNotificationChannel(id), /not found/i);
    assert.deepEqual(await listNotificationChannels(), []);
  });
  assert.equal((await db.select().from(notificationChannels)).length, 1);
});

test("parseChannelInput survives junk, and refuses an unknown kind", () => {
  const parsed = parseChannelInput({
    kind: "ntfy",
    alerts: 7,
    smtpPort: "nope",
  });
  assert.deepEqual(parsed.alerts, [], "unknown or absent keys drop out");
  assert.equal(parsed.url, "https://ntfy.sh", "ntfy's one meaningful default");
  assert.equal(parsed.smtpPort, 587);
  assert.equal(parsed.enabled, false);
  // A save is for ONE channel, so coercing an unknown kind would create a
  // channel nobody asked for.
  assert.throws(
    () => parseChannelInput({ kind: "myspace" }),
    /Unknown channel/,
  );
});

test("channelsForAlert resolves without any request identity", async () => {
  await asUser1(() =>
    saveNotificationChannel(null, draft({ alerts: ["deployment_failed"] })),
  );
  // Deliberately OUTSIDE runWithIdentity: this is the dispatcher's read, and a
  // scheduler tick has no active team.
  const kinds = (await channelsForAlert(TEAM_A, "deployment_failed")).map(
    (c) => c.kind,
  );
  assert.deepEqual(kinds, ["discord"]);
});

test("a channel that is switched off is never dialed", async () => {
  await asUser1(() => saveNotificationChannel(null, draft({ enabled: false })));
  assert.deepEqual(await channelsForAlert(TEAM_A, "deployment_failed"), []);
});

test("a channel that is on but unconfigured is not dialed either", async () => {
  await asUser1(() => saveNotificationChannel(null, draft({ url: "" })));
  assert.deepEqual(await channelsForAlert(TEAM_A, "deployment_failed"), []);
});

test("a push endpoint takes the same outbound guard as a webhook", async () => {
  // The endpoint is a URL the SUBSCRIBER supplies and the fan-out dials, so a
  // member with nothing but `view` must not be able to aim it inside.
  await assert.rejects(
    () =>
      asUser1(() =>
        subscribeWebPush({
          endpoint: "https://169.254.169.254/latest/meta-data",
          p256dh: "key",
          auth: "auth",
        }),
      ),
    /private or internal address/,
  );
  assert.equal((await db.select().from(pushSubscriptions)).length, 0);

  // A real push service is unaffected.
  await asUser1(() =>
    subscribeWebPush({
      endpoint: "https://fcm.googleapis.example/send/abc",
      p256dh: "key",
      auth: "auth",
    }),
  );
  assert.equal((await db.select().from(pushSubscriptions)).length, 1);
});

test("a team cannot grow an unbounded fan-out", async () => {
  await asUser1(async () => {
    for (let i = 0; i < 25; i++)
      await saveNotificationChannel(
        null,
        draft({ kind: "discord", url: `https://discord/hook${i}` }),
      );
    await assert.rejects(
      () => saveNotificationChannel(null, draft({ kind: "discord" })),
      /Remove one to add another/,
    );
  });
  assert.equal((await db.select().from(notificationChannels)).length, 25);
});
