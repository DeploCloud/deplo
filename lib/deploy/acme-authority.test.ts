import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { acmeAuthority, withAcmeAuthority } from "./acme-authority";
import { hasDnsChallenge, withDnsChallenge } from "./traefik-cluster";

const LE = { directory: null, caPem: null };
const TEST = {
  directory: "https://acme.lab.test:14000/dir",
  caPem: "-----BEGIN CERTIFICATE-----\nlab\n-----END CERTIFICATE-----\n",
};

// What another Deplo's lab left in a proxy on 22 Nov 2026: its resolvers on its test authority.
const LAB = `services:
  traefik:
    image: traefik:v3.7.17
    environment:
      - LEGO_CA_CERTIFICATES=/pebble-ca.pem
      - HTTPREQ_USERNAME=deplo
    extra_hosts:
      - "pebble:10.0.0.53"
      - "git.acme.com:10.0.0.9"
    command:
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
      - --certificatesresolvers.letsencrypt.acme.caserver=https://pebble:14000/dir
      - --certificatesresolvers.letsencrypt.acme.certificatesduration=1
      - --certificatesresolvers.deplo-dns.acme.storage=/acme/acme.json
      - --certificatesresolvers.deplo-dns.acme.caserver=https://pebble:14000/dir
    volumes:
      - /var/lib/deplo-agent/traefik/acme:/acme
      - /root/certlab/pebble.minica.pem:/pebble-ca.pem:ro
`;

const proxy = (yaml: string) => parse(yaml).services.traefik;

test("Let's Encrypt: another authority's server, duration, root and host name all go", () => {
  const next = withAcmeAuthority(LAB, LE);
  assert.ok(next);
  const p = proxy(next);
  assert.deepEqual(p.command, [
    "--certificatesresolvers.letsencrypt.acme.httpchallenge=true",
    "--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json",
    "--certificatesresolvers.deplo-dns.acme.storage=/acme/acme.json",
  ]);
  assert.deepEqual(p.environment, ["HTTPREQ_USERNAME=deplo"]);
  assert.deepEqual(p.volumes, ["/var/lib/deplo-agent/traefik/acme:/acme"]);
  assert.deepEqual(p.extra_hosts, ["git.acme.com:10.0.0.9"]);
  // Settled: the next link changes nothing.
  assert.equal(withAcmeAuthority(next, LE), null);
});

test("the certificate test mode puts every resolver on its authority, under the root Deplo writes", () => {
  const next = withAcmeAuthority(LAB, TEST)!;
  const p = proxy(next);
  for (const r of ["letsencrypt", "deplo-dns"])
    assert.ok(
      p.command.includes(
        `--certificatesresolvers.${r}.acme.caserver=${TEST.directory}`,
      ),
    );
  assert.ok(
    p.command.includes(
      "--certificatesresolvers.letsencrypt.acme.certificatesduration=1",
    ),
  );
  assert.ok(p.environment.includes("LEGO_CA_CERTIFICATES=/deplo-acme-ca.pem"));
  assert.deepEqual(p.configs, [
    { source: "deplo-acme-ca", target: "/deplo-acme-ca.pem" },
  ]);
  assert.equal(parse(next).configs["deplo-acme-ca"].content, TEST.caPem);
  assert.ok(!p.extra_hosts.some((h: string) => h.startsWith("pebble")));
  assert.equal(withAcmeAuthority(next, TEST), null);
  // Out of test mode, what it wrote goes as well.
  const back = withAcmeAuthority(next, LE)!;
  assert.doesNotMatch(back, /caserver|deplo-acme-ca|LEGO_CA_CERTIFICATES/);
});

test("the zone's resolver follows the test authority, and is still Deplo's own", () => {
  const plain = withAcmeAuthority(LAB, LE)!;
  const on = withDnsChallenge(plain, true, TEST);
  assert.ok(
    on.includes(
      `--certificatesresolvers.deplo-dns.acme.caserver=${TEST.directory}`,
    ),
  );
  assert.equal(hasDnsChallenge(on, TEST), true);
  assert.equal(hasDnsChallenge(on, LE), false);
});

test("the test mode is named in the environment, over https only", () => {
  assert.deepEqual(acmeAuthority({}), LE);
  const dir = mkdtempSync(join(tmpdir(), "acme-"));
  writeFileSync(join(dir, "ca.pem"), TEST.caPem);
  assert.deepEqual(
    acmeAuthority({
      DEPLO_TEST_ACME_DIRECTORY: TEST.directory,
      DEPLO_TEST_ACME_CA: join(dir, "ca.pem"),
    }),
    TEST,
  );
  assert.throws(() =>
    acmeAuthority({ DEPLO_TEST_ACME_DIRECTORY: "http://pebble:14000/dir" }),
  );
});
