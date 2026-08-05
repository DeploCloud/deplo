import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import {
  acmeEmail,
  withAcmeEmail,
  withTraefikDashboard,
  traefikDashboardDomain,
  traefikCertificates,
  withTraefikCertificates,
  TRAEFIK_CONTAINER,
} from "./traefik-stack";
import { htpasswdLine } from "../crypto";

/**
 * These lock the two properties that make rewriting a live host's reverse-proxy
 * config survivable:
 *
 *   1. NOTHING the host already had is dropped. The file was written by
 *      install-agent.sh with values only that host knows — the ACME email from
 *      install time, the absolute acme volume path, any flag added since. A
 *      renderer that re-created the file from a template would take all of it
 *      away, and the operator would learn about it when certs stopped renewing.
 *   2. The basicauth hash survives docker-compose's `$` interpolation. An
 *      unescaped `$apr1$…` in a compose value is eaten by compose, which locks
 *      the operator out of the dashboard they just secured.
 */

/** What install-agent.sh actually writes, acme path expanded as the shell leaves it. */
const INSTALLED = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=deplo
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
      - --certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /var/lib/deplo-agent/traefik/acme:/acme
    networks:
      - deplo
networks:
  deplo:
    external: true
`;

const DASH = {
  domain: "traefik.example.com",
  htpasswdUsers: "admin:$apr1$abcdefgh$0123456789abcdefghijk.",
};

type Doc = {
  services: Record<string, { command?: string[]; labels?: string[]; [k: string]: unknown }>;
  [k: string]: unknown;
};
const parse = (s: string) => yaml.load(s) as Doc;
const labelsOf = (s: string) => parse(s).services.traefik.labels ?? [];
const commandOf = (s: string) => parse(s).services.traefik.command ?? [];

test("enabling the dashboard preserves every setting the host already had", () => {
  const out = withTraefikDashboard(INSTALLED, DASH);
  const before = parse(INSTALLED).services.traefik;
  const after = parse(out).services.traefik;

  // The install-time values that exist ONLY on that host.
  assert.ok(
    commandOf(out).includes("--certificatesresolvers.letsencrypt.acme.email=ops@acme.com"),
    "the operator's ACME email must survive",
  );
  assert.deepEqual(after.volumes, before.volumes, "the acme volume path must survive");
  assert.deepEqual(after.ports, before.ports);
  assert.deepEqual(after.networks, before.networks);
  assert.equal(after.image, "traefik:v3.7");
  assert.equal(after.container_name, TRAEFIK_CONTAINER);
  assert.equal(after.restart, "unless-stopped");
  assert.deepEqual(parse(out).networks, parse(INSTALLED).networks);

  // Every original flag is still there, and the static dashboard flag is added
  // (it CANNOT come from a label, which is the whole reason this rewrite exists).
  for (const flag of before.command ?? []) {
    assert.ok(commandOf(out).includes(flag), `flag dropped: ${flag}`);
  }
  assert.ok(commandOf(out).includes("--api.dashboard=true"));
});

test("the dashboard route is published with mandatory basic auth", () => {
  const labels = labelsOf(withTraefikDashboard(INSTALLED, DASH));

  assert.ok(labels.includes("traefik.enable=true"));
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-traefik-dashboard.rule=Host(`traefik.example.com`)",
    ),
  );
  assert.ok(
    labels.includes("traefik.http.routers.deplo-traefik-dashboard.service=api@internal"),
    "the route must point at Traefik's own api@internal handler",
  );
  assert.ok(
    labels.includes("traefik.http.routers.deplo-traefik-dashboard.entrypoints=websecure"),
  );
  // The auth middleware is not optional and must be ON the router: a dashboard
  // published without it exposes every route, service and cert on the host.
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-traefik-dashboard.middlewares=deplo-traefik-dashboard-auth",
    ),
  );
  const auth = labels.find((l) => l.includes(".basicauth.users="));
  assert.ok(auth, "a basicauth middleware must be defined");
});

test("the htpasswd hash is escaped for compose interpolation", () => {
  const users = htpasswdLine("admin", "correct horse battery staple");
  const out = withTraefikDashboard(INSTALLED, { domain: "t.example.com", htpasswdUsers: users });
  const auth = labelsOf(out).find((l) => l.includes(".basicauth.users="))!;

  // compose reads a single `$` as interpolation and would eat the hash, locking
  // the operator out of the page they just secured.
  assert.ok(!/[^$]\$[^$]/.test(auth), `unescaped $ in ${auth}`);
  assert.equal(
    auth.split(".basicauth.users=")[1],
    users.replace(/\$/g, "$$$$"),
    "every $ must be doubled, and nothing else changed",
  );
});

test("the router uses the resolver this stack actually defines, not a guess", () => {
  // A host on DNS-01 against a different provider names its resolver differently;
  // pointing at one that does not exist yields Traefik's self-signed cert.
  const custom = INSTALLED.replace(/letsencrypt/g, "cloudflare");
  const labels = labelsOf(withTraefikDashboard(custom, DASH));
  assert.ok(
    labels.includes("traefik.http.routers.deplo-traefik-dashboard.tls.certresolver=cloudflare"),
  );
});

test("enabling twice is idempotent — no duplicate flags or labels", () => {
  const once = withTraefikDashboard(INSTALLED, DASH);
  const twice = withTraefikDashboard(once, DASH);
  assert.equal(twice, once);

  const flags = commandOf(twice).filter((c) => c === "--api.dashboard=true");
  assert.equal(flags.length, 1);
});

test("changing the domain replaces the route rather than adding a second one", () => {
  const first = withTraefikDashboard(INSTALLED, DASH);
  const second = withTraefikDashboard(first, { ...DASH, domain: "proxy.example.com" });

  const rules = labelsOf(second).filter((l) => l.includes(".rule=Host("));
  assert.equal(rules.length, 1, "two rules would leave the old hostname live");
  assert.ok(rules[0].includes("proxy.example.com"));
});

test("disabling removes the dashboard and restores the original stack", () => {
  const on = withTraefikDashboard(INSTALLED, DASH);
  const off = withTraefikDashboard(on, null);

  assert.ok(!commandOf(off).includes("--api.dashboard=true"));
  assert.deepEqual(labelsOf(off), [], "no dashboard labels may linger");
  // Round-trips back to the installed configuration (modulo YAML formatting).
  assert.deepEqual(parse(off), parse(withTraefikDashboard(INSTALLED, null)));
});

test("disabling keeps labels the operator added themselves", () => {
  const custom = INSTALLED.replace(
    "    networks:\n      - deplo",
    "    labels:\n      - com.example.owner=platform-team\n      - traefik.http.routers.mine.rule=Host(`mine.example.com`)\n    networks:\n      - deplo",
  );
  const off = withTraefikDashboard(withTraefikDashboard(custom, DASH), null);
  const labels = labelsOf(off);

  assert.ok(labels.includes("com.example.owner=platform-team"));
  assert.ok(labels.includes("traefik.http.routers.mine.rule=Host(`mine.example.com`)"));
  // Their route still needs traefik.enable, so it must NOT be swept up with ours.
  assert.ok(labels.includes("traefik.enable=true"));
  assert.ok(!labels.some((l) => l.includes("deplo-traefik-dashboard")));
});

/**
 * A host whose proxy the operator maintains by hand: comments explaining the
 * flags, and a dashboard flag of their own on a loopback port. Both are things
 * only that host has, and both have to survive Deplo editing the file.
 */
const HAND_MAINTAINED = `# Traefik - edge router for every site on this host.
#
# Keep the static config in \`command:\` flags: a config file would win over them.
services:
  traefik:
    image: traefik:v3.6
    container_name: deplo-traefik
    command:
      # Let's Encrypt via HTTP-01 on the web (:80) entrypoint. The resolver name
      # MUST stay \`letsencrypt\`: every deployed app's labels reference it.
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      # Our own dashboard, bound to loopback only.
      - --api.dashboard=true
      - --api.insecure=true
    ports:
      - "80:80"
      - "127.0.0.1:8080:8080"
`;

const commentsIn = (s: string) => (s.match(/^\s*#/gm) ?? []).length;

test("editing the stack keeps the comments the operator wrote in it", () => {
  // A load/dump through plain objects keeps every setting and erases every line
  // explaining it. On a hand-maintained proxy those lines are the documentation
  // of the box, and there is one backup on the host, not a history.
  const before = commentsIn(HAND_MAINTAINED);
  assert.equal(before, 6);

  assert.equal(commentsIn(withTraefikDashboard(HAND_MAINTAINED, DASH)), before);
  assert.equal(commentsIn(withTraefikCertificates(HAND_MAINTAINED, [CERT])), before);
  // Including the paragraph written above the flag being CHANGED: an entry keeps
  // its node (and its comment) when only its value moves.
  const remailed = withAcmeEmail(HAND_MAINTAINED, "certs@acme.com");
  assert.equal(commentsIn(remailed), before);
  assert.ok(remailed.includes("MUST stay `letsencrypt`"));
  assert.equal(acmeEmail(remailed), "certs@acme.com");
});

test("turning the panel off leaves a dashboard flag that was never ours", () => {
  // Nothing of ours was ever published here, so there is nothing to unpublish:
  // the file must come back untouched, byte for byte.
  assert.equal(withTraefikDashboard(HAND_MAINTAINED, null), HAND_MAINTAINED);

  // And after a full publish/unpublish cycle, THEIR flag is still there — it is
  // the loopback dashboard they were using before Deplo existed.
  const cycled = withTraefikDashboard(withTraefikDashboard(HAND_MAINTAINED, DASH), null);
  assert.ok(commandOf(cycled).includes("--api.dashboard=true"));
  assert.ok(commandOf(cycled).includes("--api.insecure=true"));
  assert.deepEqual(labelsOf(cycled), [], "nothing of ours may linger either");

  // On a host where WE added the flag, we still take it back out (INSTALLED has
  // none of its own) — that is the case the marker label tells apart.
  const installedCycle = withTraefikDashboard(withTraefikDashboard(INSTALLED, DASH), null);
  assert.ok(!commandOf(installedCycle).includes("--api.dashboard=true"));
});

test("a domain or credentials cannot be omitted", () => {
  assert.throws(
    () => withTraefikDashboard(INSTALLED, { domain: "  ", htpasswdUsers: "a:b" }),
    /domain is required/i,
  );
  assert.throws(
    () => withTraefikDashboard(INSTALLED, { domain: "t.example.com", htpasswdUsers: "" }),
    /credentials are required/i,
  );
});

test("refuses a file that is not a Traefik stack, rather than writing one", () => {
  assert.throws(() => withTraefikDashboard("", DASH), /not a compose file/i);
  assert.throws(() => withTraefikDashboard("services:\n  web:\n    image: nginx\n", DASH), /no Traefik service/i);
  assert.throws(() => withTraefikDashboard("{{ not yaml", DASH), /Could not read/i);
});

test("traefikDashboardDomain reports what the host is actually publishing", () => {
  assert.equal(traefikDashboardDomain(INSTALLED), null);
  assert.equal(traefikDashboardDomain(withTraefikDashboard(INSTALLED, DASH)), "traefik.example.com");
  // The static flag is what makes the dashboard exist; a leftover label without
  // it is not a live dashboard and must not be reported as one.
  const labelsOnly = INSTALLED.replace(
    "    networks:\n      - deplo",
    "    labels:\n      - traefik.http.routers.deplo-traefik-dashboard.rule=Host(`stale.example.com`)\n    networks:\n      - deplo",
  );
  assert.equal(traefikDashboardDomain(labelsOnly), null);
  assert.equal(traefikDashboardDomain("nonsense: ["), null);
});

/* ------------------------------------------------------------------ */
/* The Let's Encrypt account email                                     */
/* ------------------------------------------------------------------ */

test("acmeEmail reads the address off the host's own resolver", () => {
  assert.equal(acmeEmail(INSTALLED), "ops@acme.com");
  // A resolver with no email flag is a resolver with no address, which is a
  // different answer from "there is no resolver here" (null) below.
  const noEmail = INSTALLED.replace(
    "      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com\n",
    "",
  );
  assert.equal(acmeEmail(noEmail), "");
  // A host behind someone else's TLS termination issues no certificates at all.
  const noAcme = INSTALLED.split("\n")
    .filter((l) => !l.includes("--certificatesresolvers."))
    .join("\n");
  assert.equal(acmeEmail(noAcme), null);
  assert.equal(acmeEmail("not a compose file"), null);
});

test("changing the email moves ONE flag and leaves the rest of the host alone", () => {
  const out = withAcmeEmail(INSTALLED, "  Certs@Example.com ".trim());
  const before = parse(INSTALLED).services.traefik;
  const after = parse(out).services.traefik;

  assert.equal(acmeEmail(out), "Certs@Example.com");
  assert.equal(
    commandOf(out).filter((c) => c.includes(".acme.email=")).length,
    1,
    "two email flags would leave Traefik reading whichever it saw last",
  );
  // Everything only that host knows survives: the storage path, the challenge,
  // the ports, the acme volume.
  assert.ok(commandOf(out).includes("--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json"));
  assert.ok(commandOf(out).includes("--certificatesresolvers.letsencrypt.acme.httpchallenge=true"));
  assert.deepEqual(after.volumes, before.volumes);
  assert.deepEqual(after.ports, before.ports);
  assert.equal(after.image, before.image);
});

test("the resolver's real name is used, not the installer's default", () => {
  const dnsResolver = INSTALLED.replace(/certificatesresolvers\.letsencrypt\./g, "certificatesresolvers.cloudflare.");
  const out = withAcmeEmail(dnsResolver, "certs@example.com");
  assert.ok(
    commandOf(out).includes("--certificatesresolvers.cloudflare.acme.email=certs@example.com"),
    "a flag on a resolver this host does not define would silently do nothing",
  );
  assert.equal(commandOf(out).filter((c) => c.includes(".acme.email=")).length, 1);
});

test("a proxy that issues no certificates refuses the setting instead of pretending", () => {
  const noAcme = INSTALLED.split("\n")
    .filter((l) => !l.includes("--certificatesresolvers."))
    .join("\n");
  assert.throws(() => withAcmeEmail(noAcme, "certs@example.com"), /no Let's Encrypt resolver/i);
  assert.throws(() => withAcmeEmail(INSTALLED, "   "), /Enter the email/i);
});

/* ------------------------------------------------------------------ */
/* Custom certificates                                                 */
/* ------------------------------------------------------------------ */

/**
 * The certificate half locks three things:
 *   1. a round trip: what goes in comes back out of the host's own file, which
 *      is where the list in the UI is read from (nothing is stored control-plane
 *      side, so a lossy write would lose the certificate itself);
 *   2. removal puts the file back exactly as it was, flags included, so
 *      installing and removing one is not a slow way to accumulate config;
 *   3. an operator's own file provider is used, never duplicated. Traefik
 *      refuses a second file provider, and a stack that will not start is a host
 *      with no routing at all.
 */
const CERT = { certPem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n", keyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n" };
const CERT2 = { certPem: "-----BEGIN CERTIFICATE-----\nCCC\n-----END CERTIFICATE-----\n", keyPem: "-----BEGIN PRIVATE KEY-----\nDDD\n-----END PRIVATE KEY-----\n" };

test("an installed certificate survives the round trip through the stack file", () => {
  const out = withTraefikCertificates(INSTALLED, [CERT, CERT2]);
  assert.deepEqual(traefikCertificates(out), [CERT, CERT2]);

  // The file provider is what makes Traefik read it at all, and the file has to
  // land in the directory that provider watches.
  assert.ok(commandOf(out).includes("--providers.file.directory=/deplo-dynamic"));
  assert.ok(commandOf(out).includes("--providers.file.watch=true"));
  const doc = parse(out) as Doc & { configs?: Record<string, { content?: string }> };
  const mount = (doc.services.traefik.configs as Array<{ source: string; target: string }>)[0];
  assert.equal(mount.source, "deplo-certificates");
  assert.equal(mount.target, "/deplo-dynamic/deplo-certificates.yml");
  assert.ok(doc.configs?.["deplo-certificates"]?.content?.includes("BEGIN CERTIFICATE"));

  // Everything the host already had is still there, same rule as the dashboard.
  assert.ok(commandOf(out).includes("--certificatesresolvers.letsencrypt.acme.email=ops@acme.com"));
  assert.deepEqual(parse(out).services.traefik.volumes, parse(INSTALLED).services.traefik.volumes);
});

test("installing the same certificate twice replaces it rather than stacking", () => {
  const once = withTraefikCertificates(INSTALLED, [CERT]);
  const twice = withTraefikCertificates(once, [CERT]);
  assert.deepEqual(traefikCertificates(twice), [CERT]);
  assert.equal(commandOf(twice).filter((c) => c.startsWith("--providers.file.")).length, 2);
});

test("removing the last certificate leaves the file as it was found", () => {
  const withCert = withTraefikCertificates(INSTALLED, [CERT]);
  const cleared = withTraefikCertificates(withCert, []);
  assert.deepEqual(traefikCertificates(cleared), []);
  assert.deepEqual(parse(cleared), parse(INSTALLED));
});

test("an operator's own file provider is reused, never a second one declared", () => {
  const custom = INSTALLED.replace(
    "      - --providers.docker=true",
    "      - --providers.docker=true\n      - --providers.file.directory=/etc/traefik/dynamic",
  );
  const out = withTraefikCertificates(custom, [CERT]);
  assert.equal(commandOf(out).filter((c) => c.startsWith("--providers.file.directory=")).length, 1);
  const mount = (parse(out).services.traefik.configs as Array<{ target: string }>)[0];
  assert.equal(mount.target, "/etc/traefik/dynamic/deplo-certificates.yml");

  // Their flag is theirs: removing our certificate must not unload their config.
  const cleared = withTraefikCertificates(out, []);
  assert.ok(commandOf(cleared).includes("--providers.file.directory=/etc/traefik/dynamic"));
  assert.equal(traefikCertificates(cleared).length, 0);
});

test("a proxy pinned to a single config file refuses instead of replacing it", () => {
  const pinned = INSTALLED.replace(
    "      - --providers.docker=true",
    "      - --providers.docker=true\n      - --providers.file.filename=/etc/traefik/dynamic.yml",
  );
  assert.throws(() => withTraefikCertificates(pinned, [CERT]), /single Traefik configuration file/i);
});

test("a stack with no certificates of ours reports none", () => {
  assert.deepEqual(traefikCertificates(INSTALLED), []);
  assert.deepEqual(traefikCertificates("not: [a, compose, file"), []);
});
