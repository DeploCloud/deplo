import { test } from "node:test";
import assert from "node:assert/strict";

import { buildComposeStack } from "./render";
import { buildDoc, labelsOf, networksOf, route } from "./stack-test-helpers";

test("a service claiming one of Deplo's own names on the shared network is refused", () => {
  for (const name of ["deplo", "postgres", "traefik"]) {
    assert.throws(
      () =>
        buildComposeStack({
          network: "deplo-team-team_test",
          compose: `services:\n  ${name}:\n    image: alpine\n    networks: [deplo]\nnetworks:\n  deplo: {external: true}`,
          name: "deplo-demo",
          deployKey: "demo",
          appId: "p1",
          domainRoutes: [],
        }),
      /is a name Deplo's own infrastructure answers to/,
      `${name} was allowed`,
    );
  }
});

test("an OLD domain routed at a reserved name is skipped, not fatal", () => {
  const doc = buildDoc(
    `services:
  postgres:
    image: postgres:16
  web:
    image: nginx
`,
    {
      domainRoutes: [
        route("db.1.2.3.4.nip.io", "postgres", 5432),
        route("app.1.2.3.4.nip.io", "web", 80),
      ],
    },
  );
  const pg = labelsOf(doc.services.postgres);
  assert.ok(!pg.some((l) => l.includes("db.1.2.3.4.nip.io")));
  assert.ok(
    !(doc.services.postgres.networks as string[] | undefined)?.includes(
      "deplo",
    ),
    "the reserved service must not be put on the shared network",
  );
  assert.ok(
    labelsOf(doc.services.web).some((l) =>
      l.includes("Host(`app.1.2.3.4.nip.io`)"),
    ),
  );
});

test("a reserved name reached through an implicit `default` is refused", () => {
  assert.throws(
    () =>
      networksOf(`
networks:
  default:
    external: true
    name: deplo-env-environ_victim
services:
  deplo:
    image: alpine
`),
    /answers to/,
  );
});

test("a reserved name is left off the shared network, but not off the stack", () => {
  const doc = networksOf(`
services:
  postgres:
    image: postgres:16
  web:
    image: nginx
`);
  assert.deepEqual(doc.services.postgres.networks, ["default"]);
  assert.deepEqual(doc.services.web.networks, ["default", "deplo"]);
});

test("a hostname claiming a reserved name is caught like the service name", () => {
  const doc = networksOf(`
services:
  store:
    image: postgres:16
    hostname: postgres
  web:
    image: nginx
`);
  assert.deepEqual(doc.services.store.networks, ["default"]);
  assert.deepEqual(doc.services.web.networks, ["default", "deplo"]);
});

test("a `hostname:` filled in from a variable is refused at the render", () => {
  assert.throws(
    () =>
      buildComposeStack({
        network: "deplo-team-team_test",
        compose: "services:\n  web:\n    image: nginx\n    hostname: ${H}\n",
        name: "deplo-demo",
        deployKey: "demo",
        appId: "p1",
        domainRoutes: [],
      }),
    /filled in from a variable/,
  );
});

test("a reserved name never breaks an `internal: true` seal", () => {
  const sealed = `
networks:
  sealed:
    internal: true
services:
  worker:
    image: alpine
    networks: [sealed]
`;
  assert.deepEqual(networksOf(sealed).services.worker.networks, ["sealed"]);
  const withReserved = networksOf(
    `${sealed}  postgres:\n    image: postgres:16\n`,
  );
  assert.deepEqual(withReserved.services.worker.networks, ["sealed"]);
  assert.deepEqual(withReserved.services.postgres.networks, ["default"]);
});

test("a service kept off the network says so, route and all", () => {
  const warnings: string[] = [];
  buildComposeStack({
    network: "deplo-env-environ_mine",
    compose:
      "services:\n  postgres:\n    image: postgres:16\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("db.example.com", "postgres", 5432)],
    onWarn: (m) => warnings.push(m),
  });
  assert.ok(warnings.some((w) => w.includes("will not answer")));
  assert.ok(
    warnings.some((w) => w.includes("kept off this environment's network")),
  );
});

test("a service whose name a neighbour already answers to stays off the network", () => {
  // Measured in production: two stacks in one environment both registered `db` on the
  // shared network, Docker round-robined them, and paperless spent 106 restarts querying
  // wordpress's database.
  const warnings: string[] = [];
  const doc = networksOf(
    "services:\n  webserver:\n    image: p\n  db:\n    image: postgres:16\n  broker:\n    image: redis\n",
    { takenNames: ["db"], onWarn: (m: string) => warnings.push(m) },
  );
  assert.deepEqual(doc.services.db.networks, ["default"]);
  assert.deepEqual(doc.services.webserver.networks, ["default", "deplo"]);
  assert.deepEqual(doc.services.broker.networks, ["default", "deplo"]);
  assert.ok(
    warnings.some((w) => w.includes("already answered by another stack")),
  );
});

test("a preview has no neighbours, so production's names hold nothing back", () => {
  // A preview is sealed in a network of its own (ADR-0028).
  const warnings: string[] = [];
  const doc = networksOf(
    "services:\n  web:\n    image: n\n  db:\n    image: postgres:16\n",
    {
      network: "deplo-preview-shop__pr-42",
      takenNames: ["db"],
      onWarn: (m: string) => warnings.push(m),
    },
  );
  assert.deepEqual(doc.services.db.networks, ["deplo"]);
  assert.deepEqual(doc.services.web.networks, ["deplo"]);
  assert.deepEqual(warnings, []);
});

test("an unclaimed name still joins, so nothing is held back for nothing", () => {
  const doc = networksOf(
    "services:\n  web:\n    image: n\n  cache:\n    image: r\n",
    { takenNames: ["db", "postgres"] },
  );
  assert.deepEqual(doc.services.web.networks, ["deplo"]);
  assert.deepEqual(doc.services.cache.networks, ["deplo"]);
});
