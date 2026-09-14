import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coolifyDestination,
  coolifyIsPanelHost,
  coolifyMember,
  coolifySchedule,
  coolifyServer,
} from "./instance";

test("the panel's own host is keyed as the panel's own host", () => {
  assert.equal(
    coolifyIsPanelHost({ uuid: "u", ip: "host.docker.internal" }),
    true,
  );
  assert.equal(coolifyIsPanelHost({ uuid: "u", id: 0, ip: "10.0.0.1" }), true);
  assert.equal(
    coolifyServer({ uuid: "u", id: 0, name: "localhost" }).serverId,
    "",
  );
  const remote = coolifyServer({
    uuid: "srv-9",
    id: 3,
    name: "eu-1",
    ip: "1.2.3.4",
  });
  assert.deepEqual(
    [remote.serverId, remote.name, remote.ipAddress],
    ["srv-9", "eu-1", "1.2.3.4"],
  );
});

test("a member arrives without a role, because Coolify hides it", () => {
  const m = coolifyMember({ id: 7, name: "Ada", email: "ada@acme.com" });
  assert.equal(m.role, null);
  assert.equal(m.email, "ada@acme.com");
});

test("a schedule's word becomes a cron expression", () => {
  assert.equal(
    coolifySchedule({ uuid: "t1", name: "prune", frequency: "daily" })
      .cronExpression,
    "0 0 * * *",
  );
  assert.equal(
    coolifySchedule({ uuid: "t2", name: "x", frequency: "*/5 * * * *" })
      .cronExpression,
    "*/5 * * * *",
  );
});

test("a backup destination needs its credentials to be worth importing", () => {
  assert.equal(
    coolifyDestination({
      uuid: "s3-1",
      endpoint: "https://s3.acme.com",
      bucket: "b",
    }),
    null,
  );
  assert.deepEqual(
    coolifyDestination({
      uuid: "s3-2",
      name: "backups",
      endpoint: "https://s3.acme.com",
      bucket: "b",
      key: "AK",
      secret: "SK",
    }),
    {
      name: "backups",
      endpoint: "https://s3.acme.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    },
  );
});

test("a member's role comes off the membership row Coolify sends with them", () => {
  assert.equal(
    coolifyMember({ id: 3, email: "a@acme.test", pivot: { role: "admin" } })
      .role,
    "admin",
  );
  // Nothing there is still nothing invented.
  assert.equal(coolifyMember({ id: 4, email: "b@acme.test" }).role, null);
});
