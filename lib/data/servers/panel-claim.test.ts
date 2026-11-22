import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { clusters } from "../../db/schema/control-plane/clusters";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import type {
  ClaimServerRequest,
  ClaimServerResponse,
} from "../../agent/gen/agent";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
} from "../identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { claimServer, leftByAnotherDeplo } from "./panel-claim";

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

beforeEach(async () => {
  await pg.exec(TRUNCATE_INFRA);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec("truncate table clusters cascade;");
  await seedIdentity(db, {
    users: [{ id: "u1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true }],
  });
});

// eu-1 on 22 Nov 2026: the lab's resolver pointed at its test authority, trusted under a root mounted by hand.
const LAB_PROXY = `services:
  traefik:
    image: traefik:v3.7.17
    container_name: deplo-traefik
    environment:
      - LEGO_CA_CERTIFICATES=/pebble-ca.pem
      - LEGO_CA_SYSTEM_CERT_POOL=true
    extra_hosts:
      - "pebble:10.0.0.53"
    command:
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
      - --certificatesresolvers.letsencrypt.acme.caserver=https://pebble:14000/dir
      - --certificatesresolvers.letsencrypt.acme.certificatesduration=1
    volumes:
      - /var/lib/deplo-agent/traefik/acme:/acme
      - /root/certlab/pebble.minica.pem:/pebble-ca.pem:ro
    configs:
      - source: deplo-cluster-relay
        target: /deplo-dynamic/deplo-cluster-relay.yml
configs:
  deplo-cluster-relay:
    content: "http: {routers: {deplo-cluster-relay: {rule: 'Host(\`10.0.0.54\`)'}}}"
`;

function fakeAgent(answers: Partial<ClaimServerResponse>[], yaml = LAB_PROXY) {
  const host = { yaml, claims: [] as ClaimServerRequest[], applied: 0 };
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: ["hostops", "panel.claim"] }),
      claimServer: async (req: ClaimServerRequest) => {
        host.claims.push(req);
        return {
          restarting: false,
          setAside: "",
          setAsideAtMs: 0,
          left: [],
          ...answers.shift(),
        };
      },
      hostInfo: async () => ({ traefikComposeYaml: host.yaml }),
      traefikConfig: async (req: { composeYaml: string }) => {
        host.applied++;
        host.yaml = req.composeYaml;
        return { ok: true, error: "", composeYaml: host.yaml };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  return host;
}

const trail = async () =>
  (await db.select({ m: activities.message }).from(activities)).map((r) => r.m);

test("a server another Deplo ran is told this Deplo's clusters, sets the rest aside, and orders from Let's Encrypt", async () => {
  await seedServerRow(db, { id: "srv_eu1", name: "eu-1" });
  await db.insert(clusters).values({
    id: "clu_eu",
    name: "eu",
    createdAt: "2026-11-22T00:00:00.000Z",
  });
  const left = [
    { kind: "container", name: "deplo-web-deplo-web-1", app: "web" },
    { kind: "volume", name: "deplo-volw_data", app: "volw" },
  ];
  const host = fakeAgent([
    { restarting: true },
    {
      setAside: "/var/lib/deplo-agent/set-aside/x",
      setAsideAtMs: 1795370000000,
      left,
    },
  ]);

  await claimServer("srv_eu1");
  assert.deepEqual(host.claims, [
    { clusterIds: ["clu_eu"], clusterHost: false },
  ]);
  assert.equal(host.applied, 0, "the proxy waits for the agent to come back");
  assert.equal(leftByAnotherDeplo("srv_eu1"), null);

  // Back after its restart: what it set aside is on its page, and the proxy follows this Deplo's authority.
  await claimServer("srv_eu1");
  assert.deepEqual(leftByAnotherDeplo("srv_eu1"), {
    setAsideAt: new Date(1795370000000).toISOString(),
    left,
  });
  assert.equal(host.applied, 1);
  assert.doesNotMatch(
    host.yaml,
    /pebble|certificatesduration|LEGO_CA_CERTIFICATES/,
  );
  assert.match(host.yaml, /LEGO_CA_SYSTEM_CERT_POOL=true/);
  assert.match(host.yaml, /\/var\/lib\/deplo-agent\/traefik\/acme:\/acme/);
  assert.doesNotMatch(
    host.yaml,
    /deplo-cluster-relay/,
    "the other Deplo's relay door stays",
  );

  // Settled: a relink changes nothing.
  await claimServer("srv_eu1");
  assert.equal(host.applied, 1);
  assert.deepEqual(await trail(), [
    "Setting aside what another Deplo left on eu-1",
    "The proxy on eu-1 now gets its certificates from Let's Encrypt",
  ]);
});

test("Deplo's own machine runs the leaders, and an agent without the claim still gets the authority", async () => {
  await seedServerRow(db, { id: "srv_host", name: "main", deploHost: true });
  await db.insert(clusters).values({
    id: "clu_eu",
    name: "eu",
    createdAt: "2026-11-22T00:00:00.000Z",
  });
  const host = fakeAgent([{}]);
  await claimServer("srv_host");
  assert.deepEqual(host.claims, [
    { clusterIds: ["clu_eu"], clusterHost: true },
  ]);

  const old = fakeAgent([]);
  await claimServer("srv_host", false);
  assert.equal(old.claims.length, 0);
  assert.equal(old.applied, 1);
});

test("the note stays a week, and as long as another Deplo's Apps are there", async () => {
  await seedServerRow(db, { id: "srv_eu2", name: "eu-2" });
  const at = Date.parse("2026-11-22T18:00:00.000Z");
  fakeAgent([{ setAside: "/x", setAsideAtMs: at, left: [] }]);
  await claimServer("srv_eu2");
  assert.ok(leftByAnotherDeplo("srv_eu2", at + 6 * 24 * 3600 * 1000));
  assert.equal(leftByAnotherDeplo("srv_eu2", at + 8 * 24 * 3600 * 1000), null);
  fakeAgent([
    {
      setAside: "/x",
      setAsideAtMs: at,
      left: [{ kind: "volume", name: "v", app: "notes" }],
    },
  ]);
  await claimServer("srv_eu2");
  assert.ok(leftByAnotherDeplo("srv_eu2", at + 30 * 24 * 3600 * 1000));
});

test("a proxy already on Let's Encrypt only loses the relay another Deplo left, and says so", async () => {
  await seedServerRow(db, { id: "srv_eu1", name: "eu-1" });
  const relayOnly = LAB_PROXY.replace(
    /.*(pebble|LEGO_CA_CERTIFICATES|caserver|certificatesduration).*\n/g,
    "",
  );
  const host = fakeAgent(
    [{ restarting: true }, { setAside: "/x", setAsideAtMs: Date.now() }],
    relayOnly,
  );
  await claimServer("srv_eu1");
  await claimServer("srv_eu1");
  assert.equal(host.applied, 1);
  assert.doesNotMatch(host.yaml, /deplo-cluster-relay/);
  assert.deepEqual(await trail(), [
    "Setting aside what another Deplo left on eu-1",
    "Took the relay another Deplo left out of the proxy on eu-1",
  ]);
});
