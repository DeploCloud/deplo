import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

import {
  acmeEmail,
  withAcmeEmail,
  withTraefikDashboard,
  traefikDashboardDomain,
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
