import { test } from "node:test";
import assert from "node:assert/strict";

import { composeClaimedNames, composeClaimsReservedName } from "./networks";

test("composeClaimsReservedName: only when it joins the shared network", () => {
  const onShared = `services:
  postgres:
    image: alpine
    networks: [deplo]
networks:
  deplo: {external: true}`;
  assert.equal(composeClaimsReservedName(onShared), "postgres");

  const ordinary = `services:
  web:
    image: nginx
  postgres:
    image: postgres:16`;
  assert.equal(composeClaimsReservedName(ordinary), null);
});

test("a reserved name is claimed by case and by `hostname:`, not only by the service name", () => {
  const onShared = (svc: string) => `services:
${svc}
networks:
  deplo: {external: true}`;

  assert.equal(
    composeClaimsReservedName(
      onShared("  Postgres:\n    image: alpine\n    networks: [deplo]"),
    ),
    "Postgres",
    "an upper-case service name is the same name",
  );
  assert.equal(
    composeClaimsReservedName(
      onShared(
        "  web:\n    image: alpine\n    hostname: postgres\n    networks: [deplo]",
      ),
    ),
    "postgres",
    "a hostname claims the name too",
  );
  for (const proxy of ["deplo-socket-proxy", "docker-socket-proxy"])
    assert.equal(
      composeClaimsReservedName(
        onShared(`  ${proxy}:\n    image: alpine\n    networks: [deplo]`),
      ),
      proxy,
      proxy,
    );
  assert.equal(
    composeClaimsReservedName("services:\n  Postgres:\n    image: alpine\n"),
    null,
    "not on the shared network",
  );
});

test("composeClaimedNames lists service names AND hostnames, lowercased", () => {
  assert.deepEqual(
    composeClaimedNames(
      "services:\n  Api:\n    image: alpine\n    hostname: DB-Main\n  worker:\n    image: alpine\n",
    ).sort(),
    ["api", "db-main", "worker"],
  );
});
