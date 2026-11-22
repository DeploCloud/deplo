import { test, after } from "node:test";
import assert from "node:assert/strict";

import {
  __setAuthoritativeAskForTest,
  authoritativeAddresses,
  type DnsAsk,
} from "./authoritative-dns";

// fise on 22 Nov 2026: Cloudflare's own name servers already served the DNS-only CNAME into the cluster's zone,
// while the caching resolver still held the tunnel's proxied addresses.
const CF = ["172.64.33.1", "173.245.58.1"];
const ZONE_NS = ["2a07:7e87:546d:0:be24:11ff:fe40:3a0c"];
const MEMBERS = ["2a07:7e87:546d:0:be24:11ff:fe40:3bec"];
const STALE = ["104.21.22.101"];

const world: DnsAsk = async (servers, name, type) => {
  const cache = servers.length === 0;
  if (cache) {
    if (type === "NS")
      return name === "pixelfederico.com"
        ? ["ada.ns.cloudflare.com"]
        : name === "cluster.pixelfederico.com"
          ? ["ns1.cluster.pixelfederico.com"]
          : [];
    if (name === "ada.ns.cloudflare.com") return type === "A" ? CF : [];
    if (name === "ns1.cluster.pixelfederico.com")
      return type === "AAAA" ? ZONE_NS : [];
    // The cache's stale answer: asking it would read the tunnel.
    if (name === "fise.pixelfederico.com") return type === "A" ? STALE : [];
    return [];
  }
  if (servers.every((s) => CF.includes(s)))
    return name === "fise.pixelfederico.com" && type === "CNAME"
      ? ["fise-pixelfederico-com.cluster.pixelfederico.com"]
      : [];
  if (servers.every((s) => ZONE_NS.includes(s)))
    return name === "fise-pixelfederico-com.cluster.pixelfederico.com" &&
      type === "AAAA"
      ? MEMBERS
      : [];
  return null;
};

after(() => __setAuthoritativeAskForTest(null));

test("a stale caching resolver does not fail the DNS check: the zones' own name servers answer it", async () => {
  __setAuthoritativeAskForTest(world);
  assert.deepEqual(await authoritativeAddresses("fise.pixelfederico.com"), {
    a: [],
    aaaa: MEMBERS,
    via: ["fise-pixelfederico-com.cluster.pixelfederico.com"],
  });
});

test("name servers that cannot be asked give no verdict", async () => {
  __setAuthoritativeAskForTest(async (servers, name, type) =>
    servers.length === 0 ? world(servers, name, type) : null,
  );
  assert.equal(await authoritativeAddresses("fise.pixelfederico.com"), null);
});
