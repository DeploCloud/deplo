import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fakeCloudflare } from "./cloudflare-test-helpers";
import {
  createTunnel,
  deleteTunnel,
  findZone,
  pointAtTunnel,
  tunnelHealth,
} from "./tunnel-api";

let restore = () => {};
afterEach(() => restore());

const setup = (seed?: Parameters<typeof fakeCloudflare>[0]) => {
  const fake = fakeCloudflare(seed);
  restore = fake.restore;
  return fake.cf;
};

test("the zone is the longest suffix of the hostname the token can see", async () => {
  const cf = setup({
    zones: [
      { id: "z-apex", name: "example.com", accountId: "a1" },
      { id: "z-sub", name: "eu.example.com", accountId: "a2" },
    ],
  });
  assert.deepEqual(await findZone("t", "deplo.eu.example.com"), {
    id: "z-sub",
    name: "eu.example.com",
    accountId: "a2",
  });
  assert.deepEqual(
    cf.calls,
    ["GET /zones?name=deplo.eu.example.com", "GET /zones?name=eu.example.com"],
    "it stops at the first match and never asks for a bare TLD",
  );
  assert.equal((await findZone("t", "deplo.example.com")).id, "z-apex");
});

test("a hostname outside every zone says what to do", async () => {
  setup({ zones: [] });
  await assert.rejects(
    () => findZone("t", "deplo.example.org"),
    /not in a domain this Cloudflare token can reach/,
  );
});

test("a refused token names the permissions it needs", async () => {
  const cf = setup();
  cf.failNext = {
    match: /cfd_tunnel/,
    status: 403,
    message: "Authentication error",
  };
  await assert.rejects(
    () => createTunnel("t", "acct1", "deplo"),
    /refused the API token: Authentication error\. It needs Cloudflare Tunnel and DNS edit access/,
  );
});

test("a name with no records gets a proxied CNAME to the tunnel", async () => {
  const cf = setup();
  const pointed = await pointAtTunnel(
    "t",
    "zone1",
    "deplo.example.com",
    "tun-9",
    () => false,
  );
  assert.equal(pointed.created, true);
  const rec = cf.records.get(pointed.id)!;
  assert.equal(rec.type, "CNAME");
  assert.equal(rec.content, "tun-9.cfargotunnel.com");
  assert.equal(
    rec.proxied,
    true,
    "an unproxied tunnel record resolves nowhere",
  );
});

test("a record already on the tunnel is kept, and the panel's own A record is replaced", async () => {
  const cf = setup();
  cf.records.set("r1", {
    id: "r1",
    zoneId: "zone1",
    type: "CNAME",
    name: "deplo.example.com",
    content: "tun-9.cfargotunnel.com",
  });
  assert.deepEqual(
    await pointAtTunnel(
      "t",
      "zone1",
      "deplo.example.com",
      "tun-9",
      () => false,
    ),
    { id: "r1", replaced: [], created: false },
  );

  cf.records.clear();
  cf.records.set("a1", {
    id: "a1",
    zoneId: "zone1",
    type: "A",
    name: "deplo.example.com",
    content: "203.0.113.10",
    proxied: false,
  });
  const pointed = await pointAtTunnel(
    "t",
    "zone1",
    "deplo.example.com",
    "tun-9",
    (r) => r.content === "203.0.113.10",
  );
  assert.equal(cf.records.has("a1"), false);
  assert.equal(pointed.replaced[0].content, "203.0.113.10");
  assert.equal(cf.records.get(pointed.id)?.type, "CNAME");
});

test("somebody else's record on that name is refused, and left where it was", async () => {
  const cf = setup();
  cf.records.set("www", {
    id: "www",
    zoneId: "zone1",
    type: "A",
    name: "www.example.com",
    content: "198.51.100.7",
  });
  await assert.rejects(
    () => pointAtTunnel("t", "zone1", "www.example.com", "tun-9", () => false),
    /already has a A record in Cloudflare \(198\.51\.100\.7\)/,
  );
  assert.deepEqual([...cf.records.keys()], ["www"]);
});

test("a record that cannot be created puts back what it replaced", async () => {
  const cf = setup();
  cf.records.set("a1", {
    id: "a1",
    zoneId: "zone1",
    type: "A",
    name: "deplo.example.com",
    content: "203.0.113.10",
  });
  cf.failNext = {
    match: /^POST \/zones\/zone1\/dns_records$/,
    status: 400,
    message: "nope",
  };
  await assert.rejects(() =>
    pointAtTunnel("t", "zone1", "deplo.example.com", "tun-9", () => true),
  );
  const left = [...cf.records.values()];
  assert.equal(left.length, 1);
  assert.equal(left[0].content, "203.0.113.10");
});

test("deleting a tunnel Cloudflare no longer has is not an error", async () => {
  const cf = setup();
  await deleteTunnel("t", "acct1", "gone");
  assert.deepEqual(cf.calls, [
    "DELETE /accounts/acct1/cfd_tunnel/gone/connections",
    "DELETE /accounts/acct1/cfd_tunnel/gone",
  ]);
});

test("health reads the status and counts the connections", async () => {
  setup();
  const id = await createTunnel("t", "acct1", "deplo");
  assert.deepEqual(await tunnelHealth("t", "acct1", id), {
    status: "healthy",
    connections: 1,
  });
});
