import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { TRAEFIK_IMAGE } from "../../deploy/traefik-stack";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
} from "../identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { bringTraefikToPin } from "./traefik-pin";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

// A server entry lands in the first team's trail.
beforeEach(async () => {
  await pg.exec(TRUNCATE_INFRA);
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [{ id: "u1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true }],
  });
});

const stack = (image: string) => `services:
  traefik:
    image: ${image}
    container_name: deplo-traefik
`;

function fakeHost(yaml: string, answer = { ok: true, error: "" }) {
  const host = { yaml, applied: 0 };
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: ["hostops"] }),
      hostInfo: async () => ({ traefikComposeYaml: host.yaml }),
      traefikConfig: async (req: { composeYaml: string }) => {
        host.applied++;
        if (answer.ok) host.yaml = req.composeYaml;
        return { ...answer, composeYaml: host.yaml };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  return host;
}

const trail = async () =>
  (await db.select({ m: activities.message }).from(activities)).map((r) => r.m);

test("a server on the floating tag is moved to the pin once, and says so", async () => {
  await seedServerRow(db, { id: "srv_float", name: "eu-1" });
  const host = fakeHost(stack("traefik:v3.7"));

  await bringTraefikToPin("srv_float");
  await bringTraefikToPin("srv_float");

  assert.equal(host.applied, 1);
  assert.match(host.yaml, new RegExp(`image: ${TRAEFIK_IMAGE}\\n`));
  assert.deepEqual(await trail(), [
    `Updated Traefik on eu-1 to ${TRAEFIK_IMAGE.split(":")[1]}`,
  ]);
});

test("a hand-picked line or a proxy Deplo did not install is left alone", async () => {
  await seedServerRow(db, { id: "srv_hand" });
  await seedServerRow(db, { id: "srv_foreign" });

  const hand = fakeHost(stack("traefik:v3.6"));
  await bringTraefikToPin("srv_hand");
  const foreign = fakeHost("");
  await bringTraefikToPin("srv_foreign");

  assert.equal(hand.applied + foreign.applied, 0);
  assert.deepEqual(await trail(), []);
});

test("a refused update is recorded once and tried again on the next link", async () => {
  await seedServerRow(db, { id: "srv_refused", name: "eu-2" });
  const host = fakeHost(stack("traefik:v3.7.16"), {
    ok: false,
    error: "port 80 is taken",
  });

  await bringTraefikToPin("srv_refused");
  await bringTraefikToPin("srv_refused");

  assert.equal(host.applied, 2);
  const [entry, ...rest] = await trail();
  assert.match(entry, /^Could not update Traefik on eu-2 .*port 80 is taken/);
  assert.deepEqual(rest, []);
});
