import { test } from "node:test";
import assert from "node:assert/strict";

import { hasDnsChallenge, withDnsChallenge } from "./traefik-cluster";
import { INSTALLED_WITH_PANEL, parse } from "./traefik-stack-test-helpers";

// ADR-0049 phase 3: the resolver whose certificate checks go over DNS through the server's own agent.

const proxyOf = (s: string) =>
  parse(s).services.traefik as {
    command: string[];
    environment?: string[] | Record<string, string | null>;
    volumes?: string[];
  };

test("the resolver copies the proxy's account, asks its agent on its own loopback, and holds no provider token", () => {
  const on = withDnsChallenge(INSTALLED_WITH_PANEL, true);
  assert.equal(hasDnsChallenge(on), true);
  const p = proxyOf(on);
  const dns = p.command.filter((c) =>
    c.startsWith("--certificatesresolvers.deplo-dns."),
  );
  assert.deepEqual(dns, [
    "--certificatesresolvers.deplo-dns.acme.email=ops@acme.com",
    "--certificatesresolvers.deplo-dns.acme.storage=/acme/acme.json",
    "--certificatesresolvers.deplo-dns.acme.dnschallenge.provider=httpreq",
    "--certificatesresolvers.deplo-dns.acme.dnschallenge.propagation.disablechecks=true",
  ]);
  // The proxy's own resolver comes first: the agent reads the store's owner from it.
  assert.ok(
    p.command.findIndex((c) => c.includes("letsencrypt.acme.storage")) <
      p.command.findIndex((c) => c.includes("deplo-dns.acme.storage")),
  );
  assert.deepEqual(p.environment, [
    "HTTPREQ_ENDPOINT=http://127.0.0.1:8444",
    "HTTPREQ_USERNAME=deplo",
    "HTTPREQ_PASSWORD_FILE=/deplo-dns-challenge.secret",
    "LEGO_DISABLE_CNAME_SUPPORT=true",
    "LEGO_CA_SYSTEM_CERT_POOL=true",
  ]);
  assert.ok(
    p.volumes?.includes(
      "./dns-challenge.secret:/deplo-dns-challenge.secret:ro",
    ),
  );
  assert.ok(!/token|api_key|apikey/i.test(on));
  // Twice changes nothing; off gives back the stack as it was.
  assert.equal(withDnsChallenge(on, true), on);
  const off = withDnsChallenge(on, false);
  assert.equal(hasDnsChallenge(off), false);
  assert.deepEqual(parse(off), parse(INSTALLED_WITH_PANEL));
});

test("an environment written as keys keeps its form and the keys around it", () => {
  const keyed = INSTALLED_WITH_PANEL.replace(
    "    restart: unless-stopped\n",
    "    restart: unless-stopped\n    environment:\n      TZ: Europe/Rome\n      PASSED_THROUGH:\n",
  );
  const p = proxyOf(withDnsChallenge(keyed, true));
  assert.deepEqual(p.environment, {
    TZ: "Europe/Rome",
    PASSED_THROUGH: null,
    HTTPREQ_ENDPOINT: "http://127.0.0.1:8444",
    HTTPREQ_USERNAME: "deplo",
    HTTPREQ_PASSWORD_FILE: "/deplo-dns-challenge.secret",
    LEGO_DISABLE_CNAME_SUPPORT: "true",
    LEGO_CA_SYSTEM_CERT_POOL: "true",
  });
  assert.equal(hasDnsChallenge(withDnsChallenge(keyed, true)), true);
  assert.deepEqual(
    parse(withDnsChallenge(withDnsChallenge(keyed, true), false)),
    parse(keyed),
  );
});

// eu-1..3 (22 Nov 2026) came from the lab with their resolver pointed at its test authority: the zone's resolver
// never copies one, and a proxy that has the old shape is written again.
test("the zone's resolver orders from Let's Encrypt whatever authority the proxy's own resolver uses", () => {
  const lab = INSTALLED_WITH_PANEL.replace(
    "      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json\n",
    "      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json\n" +
      "      - --certificatesresolvers.letsencrypt.acme.caserver=https://pebble:14000/dir\n" +
      "      - --certificatesresolvers.letsencrypt.acme.certificatesduration=1\n",
  );
  assert.notEqual(lab, INSTALLED_WITH_PANEL);
  const on = withDnsChallenge(lab, true);
  const dns = proxyOf(on).command.filter((c) =>
    c.startsWith("--certificatesresolvers.deplo-dns."),
  );
  assert.ok(
    !dns.some((c) => /caserver|certificatesduration/.test(c)),
    dns.join("\n"),
  );
  assert.ok(
    proxyOf(on).command.includes(
      "--certificatesresolvers.letsencrypt.acme.caserver=https://pebble:14000/dir",
    ),
  );
  assert.equal(hasDnsChallenge(on), true);
  const old = on
    .replace(
      "      - --certificatesresolvers.deplo-dns.acme.storage=/acme/acme.json\n",
      "      - --certificatesresolvers.deplo-dns.acme.storage=/acme/acme.json\n" +
        "      - --certificatesresolvers.deplo-dns.acme.caserver=https://pebble:14000/dir\n",
    )
    .replace("      - LEGO_CA_SYSTEM_CERT_POOL=true\n", "");
  assert.notEqual(old, on);
  assert.equal(hasDnsChallenge(old), false);
  assert.deepEqual(parse(withDnsChallenge(old, true)), parse(on));
});
