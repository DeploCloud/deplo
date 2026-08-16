import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import {
  acmeEmail,
  panelRoute,
  stackCertResolver,
  withAcmeEmail,
  withPanelRoute,
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

test("the htpasswd hash is escaped for compose interpolation", async () => {
  const users = await htpasswdLine("admin", "correct horse battery staple");
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
  // Byte-for-byte what it was, plus the one flag every write now carries. See
  // "every write heals the entrypoint" below for why it is not taken back out.
  const healed = parse(INSTALLED) as Doc;
  healed.services.traefik.command = [
    ...(healed.services.traefik.command ?? []),
    "--entrypoints.web.http.redirections.entrypoint.priority=1",
  ];
  assert.deepEqual(parse(cleared), healed);
});

test("every write heals the entrypoint, not just the one that publishes the panel", () => {
  // A host installed before the flag existed keeps redirecting every plain-http
  // route it serves - the panel when its HTTPS is off, and EVERY app domain on
  // the `none` certificate provider, which is the default a new domain is born
  // with. Carrying the fix on each ordinary write is what heals an existing
  // fleet without re-installing every host by hand.
  const FLAG = "--entrypoints.web.http.redirections.entrypoint.priority=1";
  assert.ok(!commandOf(INSTALLED).includes(FLAG), "the fixture must predate the flag");

  for (const [what, out] of [
    ["a certificate", withTraefikCertificates(INSTALLED, [CERT])],
    ["the account email", withAcmeEmail(INSTALLED, "new@acme.com")],
    ["the dashboard", withTraefikDashboard(INSTALLED, DASH)],
    ["the panel", withPanelRoute(INSTALLED, PANEL_ROUTE)],
  ] as const) {
    assert.ok(commandOf(out).includes(FLAG), `${what} must heal the entrypoint too`);
    assert.equal(
      commandOf(out).filter((c) => c.includes("redirections.entrypoint.priority")).length,
      1,
      `${what} must not stack the flag`,
    );
  }
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

test("a config directory the operator mounted read-only refuses instead of taking the proxy down", () => {
  // Docker cannot create our file inside a `:ro` mount, and it says so on `up` -
  // after the old container is gone. Refusing here costs a toast; not refusing
  // costs every site on the host until someone SSHes in.
  const readOnly = INSTALLED.replace(
    "      - --providers.docker=true",
    "      - --providers.docker=true\n      - --providers.file.directory=/etc/traefik/dynamic",
  ).replace(
    "      - /var/lib/deplo-agent/traefik/acme:/acme",
    "      - /var/lib/deplo-agent/traefik/acme:/acme\n      - /srv/traefik/dynamic:/etc/traefik/dynamic:ro",
  );
  assert.throws(() => withTraefikCertificates(readOnly, [CERT]), /read-only/i);

  // An ANCESTOR is just as unwritable, and the long mount syntax says the same
  // thing a different way.
  const ancestor = readOnly.replace(
    "      - /srv/traefik/dynamic:/etc/traefik/dynamic:ro",
    "      - type: bind\n        source: /srv/traefik\n        target: /etc/traefik\n        read_only: true",
  );
  assert.throws(() => withTraefikCertificates(ancestor, [CERT]), /read-only/i);

  // And the read-only mounts every proxy has elsewhere are none of its business:
  // INSTALLED already carries `/var/run/docker.sock:…:ro`.
  assert.equal(traefikCertificates(withTraefikCertificates(INSTALLED, [CERT])).length, 1);
});

test("a stack with no certificates of ours reports none", () => {
  assert.deepEqual(traefikCertificates(INSTALLED), []);
  assert.deepEqual(traefikCertificates("not: [a, compose, file"), []);
});

test("the certificate file is mounted 0400 - it holds a private key", () => {
  const doc = parse(withTraefikCertificates(INSTALLED, [CERT]));
  const mount = (doc.services.traefik.configs as Array<{ mode?: number }>)[0];
  // 256 IS 0400. Compose's default for a config is 0444, which every process in
  // that container can read.
  assert.equal(mount.mode, 256);
});

test("a proxy running as its own user keeps compose's default mode", () => {
  // 0400 is owned by root. A Traefik the operator moved onto a `user:` of their
  // own could not read it, and an unreadable certificate file is a proxy quietly
  // serving its self-signed default - worse than a readable one.
  const asUser = INSTALLED.replace(
    "    container_name: deplo-traefik",
    "    container_name: deplo-traefik\n    user: \"1000:1000\"",
  );
  const mount = (parse(withTraefikCertificates(asUser, [CERT])).services.traefik
    .configs as Array<{ mode?: number }>)[0];
  assert.equal(mount.mode, undefined);
});

test("anything the operator added to our certificate file survives an install", () => {
  // deplo-certificates.yml is a Traefik dynamic-config file like any other, and
  // an operator may have put a TLS policy or a middleware in it. Only the
  // certificates in it are ours to rewrite - re-rendering the whole file from the
  // certificate list would delete the rest, silently, on the next install.
  const first = withTraefikCertificates(INSTALLED, [CERT]);
  const doc = parse(first) as Doc & { configs: Record<string, { content: string }> };
  const content = parse(doc.configs["deplo-certificates"].content) as unknown as {
    tls: { certificates: unknown[]; options?: unknown };
    http?: unknown;
  };
  content.tls.options = { default: { minVersion: "VersionTLS12" } };
  content.http = { middlewares: { theirs: { headers: {} } } };
  doc.configs["deplo-certificates"].content = yaml.dump(content);

  const second = withTraefikCertificates(yaml.dump(doc), [CERT, CERT2]);
  const after = parse(
    (parse(second) as Doc & { configs: Record<string, { content: string }> }).configs[
      "deplo-certificates"
    ].content,
  ) as unknown as { tls: { options?: unknown }; http?: unknown };
  assert.ok(after.tls.options, "a hand-added tls.options block must survive");
  assert.ok(after.http, "a hand-added http section must survive");
  assert.deepEqual(traefikCertificates(second), [CERT, CERT2]);
});

test("a certificate file mangled by hand still takes a new certificate", () => {
  // Preserving what the operator wrote is best-effort: a `tls:` holding a string
  // is not a Traefik config, and refusing the install over it would leave the
  // host with a broken file AND no way to fix it from the UI.
  const broken = withTraefikCertificates(INSTALLED, [CERT]).replace(
    /content: \|[\s\S]*$/,
    'content: |\n      tls: "nonsense"\n',
  );
  const out = withTraefikCertificates(broken, [CERT2]);
  assert.deepEqual(traefikCertificates(out), [CERT2]);
});

/* ------------------------------------------------------------------ */
/* The panel's own route                                               */
/* ------------------------------------------------------------------ */

/**
 * What `install.sh` writes on a host installed with a domain, verbatim.
 *
 * Pasted rather than described because the two files are a contract: the
 * installer seeds the route and the panel edits it from then on, so a change to
 * either shape that the other does not follow leaves an operator with a panel
 * whose own settings have gone read-only. If this constant has to be edited to
 * make a test pass, install.sh is what needs the edit.
 */
const INSTALLED_WITH_PANEL = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=deplo
      - --providers.file.directory=/deplo-dynamic
      - --providers.file.watch=true
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.web.http.redirections.entrypoint.priority=1
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
      - /opt/deplo/acme:/acme
    networks:
      - deplo
    configs:
      - source: deplo-panel
        target: /deplo-dynamic/deplo-panel.yml
        mode: 256
configs:
  deplo-panel:
    content: |
      http:
        routers:
          deplo-panel:
            rule: Host(\`deplo.example.com\`)
            entryPoints:
              - websecure
            service: deplo-panel
            priority: 2
            tls:
              certResolver: letsencrypt
        services:
          deplo-panel:
            loadBalancer:
              servers:
                - url: http://deplo:3000
              passHostHeader: true
networks:
  deplo:
    external: true
`;

const PANEL_ROUTE = {
  domain: "deplo.example.com",
  https: true,
  certResolver: "letsencrypt",
  target: "http://deplo:3000",
};

/** The dynamic-config file our router lives in, parsed. */
const panelFileOf = (s: string) =>
  yaml.load(
    (parse(s) as Doc & { configs: Record<string, { content: string }> }).configs["deplo-panel"]
      .content,
  ) as {
    http: {
      routers: Record<string, Record<string, unknown>>;
      services: Record<string, unknown>;
      middlewares?: unknown;
    };
  };

test("the route install.sh seeds is the route the panel reads back", () => {
  assert.deepEqual(panelRoute(INSTALLED_WITH_PANEL), PANEL_ROUTE);
});

test("turning HTTPS off moves the panel to plain http, and back", () => {
  const off = withPanelRoute(INSTALLED_WITH_PANEL, { ...PANEL_ROUTE, https: false, certResolver: null });
  const router = panelFileOf(off).http.routers["deplo-panel"];

  assert.deepEqual(router.entryPoints, ["web"]);
  assert.equal(router.tls, undefined, "a router with no tls key terminates nothing");
  assert.equal(panelRoute(off)?.https, false);

  // And back, without the operator having to re-state where the panel lives.
  const on = withPanelRoute(off, { ...panelRoute(off)!, https: true, certResolver: "letsencrypt" });
  assert.deepEqual(panelRoute(on), PANEL_ROUTE);
});

test("a plain-http panel outranks the entrypoint redirect, which is what makes it reachable", () => {
  // MEASURED on traefik:v3.7, not assumed: an entrypoint redirection answers 301
  // ahead of EVERY router on that entrypoint, including one pinned to MaxInt32.
  // Its own priority is the only lever, so publishing an http route pins it.
  // From a stack that does NOT have the flag - an install that predates it, which
  // is every existing one. Adding it is what makes the toggle work there at all.
  assert.ok(!commandOf(INSTALLED).some((c) => c.includes("redirections.entrypoint.priority")));
  const upgraded = withPanelRoute(INSTALLED, { ...PANEL_ROUTE, https: false, certResolver: null });
  assert.ok(
    commandOf(upgraded).includes("--entrypoints.web.http.redirections.entrypoint.priority=1"),
    "without this the panel answers 301 to an https it has no certificate for",
  );

  const off = withPanelRoute(INSTALLED_WITH_PANEL, { ...PANEL_ROUTE, https: false, certResolver: null });
  assert.ok(commandOf(off).includes("--entrypoints.web.http.redirections.entrypoint.priority=1"));
  assert.equal(
    commandOf(off).filter((c) => c.includes("redirections.entrypoint.priority")).length,
    1,
    "applying twice must not stack the flag",
  );
  // Above the redirect, and far below any real route: an app's Host() router
  // gets its rule length, a PathPrefix router gets a million.
  assert.equal(panelFileOf(off).http.routers["deplo-panel"].priority, 2);
});

test("an entrypoint the operator already ordered themselves is left alone", () => {
  const pinned = INSTALLED_WITH_PANEL.replace(
    "redirections.entrypoint.priority=1",
    "redirections.entrypoint.priority=50",
  );
  const off = withPanelRoute(pinned, { ...PANEL_ROUTE, https: false, certResolver: null });
  const priorities = commandOf(off).filter((c) => c.includes("redirections.entrypoint.priority="));
  assert.deepEqual(priorities, ["--entrypoints.web.http.redirections.entrypoint.priority=50"]);
});

test("a proxy with no redirect at all gets no flag invented for it", () => {
  const noRedirect = INSTALLED_WITH_PANEL.split("\n")
    .filter((l) => !l.includes("redirections"))
    .join("\n");
  const off = withPanelRoute(noRedirect, { ...PANEL_ROUTE, https: false, certResolver: null });
  assert.ok(!commandOf(off).some((c) => c.includes("redirections")));
  assert.equal(panelRoute(off)?.https, false);
});

test("https with no resolver on the host still terminates TLS", () => {
  // A host whose proxy orders from nobody serves the certificate the operator
  // installed. Naming a resolver it does not define would have Traefik answer
  // with its self-signed default instead.
  const out = withPanelRoute(INSTALLED_WITH_PANEL, { ...PANEL_ROUTE, certResolver: null });
  assert.deepEqual(panelFileOf(out).http.routers["deplo-panel"].tls, {});
  assert.equal(panelRoute(out)?.https, true);
});

test("a host that resolves certificates under another name keeps that name", () => {
  // DNS-01 against a provider of the operator's own: pointing the panel at
  // `letsencrypt` would name a resolver this host does not define, and Traefik
  // answers that with its self-signed default.
  const dns = INSTALLED_WITH_PANEL.replace(/certificatesresolvers\.letsencrypt/g, "certificatesresolvers.cloudflare");
  assert.equal(stackCertResolver(dns), "cloudflare");
  const out = withPanelRoute(dns, { ...PANEL_ROUTE, certResolver: stackCertResolver(dns) });
  assert.equal(panelRoute(out)?.certResolver, "cloudflare");
});

test("a proxy that issues nothing at all reports no resolver", () => {
  const none = INSTALLED_WITH_PANEL.split("\n")
    .filter((l) => !l.includes("--certificatesresolvers."))
    .join("\n");
  assert.equal(stackCertResolver(none), null);
  assert.equal(acmeEmail(none), null);
});

test("moving the panel's address rewrites only the rule", () => {
  const moved = withPanelRoute(INSTALLED_WITH_PANEL, { ...PANEL_ROUTE, domain: "New.Example.COM" });
  const route = panelRoute(moved);
  // Lower-cased: a Host() rule is matched case-sensitively by Traefik, and a
  // browser sends the host lower-case whatever the operator typed.
  assert.equal(route?.domain, "new.example.com");
  assert.equal(route?.target, PANEL_ROUTE.target, "where the panel lives is not the operator's to retype");
  assert.equal(route?.certResolver, "letsencrypt");
});

test("the panel's target is read live, never assumed", () => {
  // A panel running on the host rather than in a container (the from-source
  // setup) is reached through the docker gateway. Re-rendering it from a
  // template would send every request into a container that does not exist.
  const onHost = INSTALLED_WITH_PANEL.replace(
    "http://deplo:3000",
    "http://host.docker.internal:3000",
  );
  assert.equal(panelRoute(onHost)?.target, "http://host.docker.internal:3000");
  const out = withPanelRoute(onHost, { ...panelRoute(onHost)!, https: false });
  assert.equal(panelRoute(out)?.target, "http://host.docker.internal:3000");
});

test("a panel published the old way, by labels, is reported as not ours", () => {
  // The pre-existing shape: labels on the panel's own container, in a compose
  // file no agent RPC can write. Claiming it would publish a second router
  // fighting the first; reporting null is what lets the UI say so.
  assert.equal(panelRoute(INSTALLED), null);
  assert.equal(panelRoute("not: [a, compose, file"), null);
});

test("certificates and the panel share one file provider without evicting each other", () => {
  // The bug this locks out: removing the last certificate used to strip the file
  // provider flags, which would unload the panel's own route with them - the
  // operator deletes a certificate and the page they did it from goes dark.
  const withCert = withTraefikCertificates(INSTALLED_WITH_PANEL, [CERT]);
  assert.deepEqual(traefikCertificates(withCert), [CERT]);
  assert.deepEqual(panelRoute(withCert), PANEL_ROUTE);

  const noCert = withTraefikCertificates(withCert, []);
  assert.ok(
    commandOf(noCert).includes("--providers.file.directory=/deplo-dynamic"),
    "the panel's route still needs the file provider",
  );
  assert.deepEqual(panelRoute(noCert), PANEL_ROUTE);
  assert.deepEqual(traefikCertificates(noCert), []);

  // And the other way round: unpublishing the panel keeps the certificates.
  const noPanel = withPanelRoute(withCert, null);
  assert.equal(panelRoute(noPanel), null);
  assert.deepEqual(traefikCertificates(noPanel), [CERT]);
  assert.ok(commandOf(noPanel).includes("--providers.file.directory=/deplo-dynamic"));

  // Only with both gone does the provider we added come back out.
  const bare = withTraefikCertificates(noPanel, []);
  assert.ok(!commandOf(bare).some((c) => c.startsWith("--providers.file.directory=")));
  assert.ok(!commandOf(bare).includes("--providers.file.watch=true"));
});

test("a middleware the operator added to the panel's file survives an edit", () => {
  const handEdited = INSTALLED_WITH_PANEL.replace(
    "        services:",
    "        middlewares:\n          ipallowlist:\n            ipAllowList:\n              sourceRange:\n                - 10.0.0.0/8\n        services:",
  );
  const out = withPanelRoute(handEdited, { ...PANEL_ROUTE, https: false });
  assert.ok(panelFileOf(out).http.middlewares, "a hand-added middleware must survive");
  assert.deepEqual(panelRoute(out)?.domain, PANEL_ROUTE.domain);
});

test("publishing the panel preserves every setting the host already had", () => {
  const before = parse(INSTALLED).services.traefik;
  const out = withPanelRoute(INSTALLED, PANEL_ROUTE);
  const after = parse(out).services.traefik;
  assert.deepEqual(after.volumes, before.volumes, "the acme volume path must survive");
  assert.deepEqual(after.ports, before.ports);
  assert.ok(
    commandOf(out).includes("--certificatesresolvers.letsencrypt.acme.email=ops@acme.com"),
    "the operator's ACME email must survive",
  );
  assert.deepEqual(panelRoute(out), PANEL_ROUTE);
});

test("a panel route needs a domain and somewhere to send it", () => {
  assert.throws(() => withPanelRoute(INSTALLED, { ...PANEL_ROUTE, domain: "  " }), /domain/i);
  assert.throws(() => withPanelRoute(INSTALLED, { ...PANEL_ROUTE, target: "" }), /where/i);
});
