import { test } from "node:test";
import assert from "node:assert/strict";

import {
  crossNetworkMessage,
  crossNetworkRefs,
  usesAsHost,
  type ForeignName,
} from "./cross-network";

const FOREIGN: ForeignName[] = [
  {
    name: "gamewatcher-db",
    network: "deplo-env-a",
    where: "GW / Production",
    why: "elsewhere",
  },
  {
    name: "garage",
    network: "deplo-env-b",
    where: "S3 / Production",
    why: "elsewhere",
  },
];

test("a connection string naming a foreign service is reported", () => {
  const refs = crossNetworkRefs(
    {
      DATABASE_URL: "postgres://postgres:pw@gamewatcher-db:5432/gamewatcher",
    },
    FOREIGN,
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "gamewatcher-db");
  assert.match(crossNetworkMessage(refs[0]), /GW \/ Production/);
});

test("a bare hostname is reported when the KEY says host", () => {
  const refs = crossNetworkRefs({ DB_HOST: "gamewatcher-db" }, FOREIGN);
  assert.equal(refs.length, 1);
});

// The measured false positive: `garage` is an S3 REGION here, not a host, and a
// warning on it would train people to ignore the warnings.
test("a bare value under a non-host key is NOT reported", () => {
  assert.deepEqual(crossNetworkRefs({ S3_REGION: "garage" }, FOREIGN), []);
});

test("a name that merely appears inside a URL path is not a host", () => {
  assert.equal(
    usesAsHost("API_URL", "https://example.com/garage/list", "garage"),
    false,
  );
  assert.equal(usesAsHost("API_URL", "http://garage:3900", "garage"), true);
  assert.equal(usesAsHost("REDIS", "garage:6379", "garage"), true);
});

test("a similar-but-different name is not a match", () => {
  assert.equal(
    usesAsHost("DB_HOST", "gamewatcher-db-2", "gamewatcher-db"),
    false,
  );
  assert.equal(usesAsHost("URL", "http://my-garage:80", "garage"), false);
});

test("one line per neighbour, not per variable that names it", () => {
  const refs = crossNetworkRefs(
    {
      DB_HOST: "gamewatcher-db",
      DATABASE_URL: "postgres://u@gamewatcher-db:5432/x",
    },
    FOREIGN,
  );
  assert.equal(refs.length, 1);
});

// A Docker network is local to its host, so two apps that share an Environment but
// sit on different servers do NOT reach each other. The docs said they did, and the
// detector used to skip other hosts as "not news" - between them, the commonest
// cross-host mistake was made silently.
test("a neighbour in the same environment on another server is reported", () => {
  const refs = crossNetworkRefs({ DB_HOST: "orders-db" }, [
    {
      name: "orders-db",
      network: "deplo-env-a",
      where: "Shop / Production",
      why: "other-host",
    },
  ]);
  assert.equal(refs.length, 1);
  const msg = crossNetworkMessage(refs[0]);
  assert.match(msg, /ANOTHER SERVER/);
  assert.match(msg, /same server|publish a port/);
  assert.doesNotMatch(
    msg,
    /Move this app into the same environment/,
    "moving it does not help - they are already in the same one",
  );
});
