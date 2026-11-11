import "server-only";

import { randomBytes } from "node:crypto";

import { and, eq, isNotNull, ne } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import * as cloudflare from "../../cloudflare/tunnel-api";
import { decryptSecretOrThrow, encryptSecret } from "../../crypto";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  appTunnelDomains,
  appTunnels,
  dnsProviderTunnels,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { ADDRESS_CHANGES_NOTE } from "../../clusters/address-note";
import { appTunnelIngress } from "../../deploy/panel-tunnel-stack";
import { nowIso } from "../../ids";
import { loadAppGraph, loadDomainsForApp } from "../app-graph-load";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import {
  pointAtServerTunnel,
  providerForHostname,
  rememberDomainDns,
} from "../dns-providers/provision";
import {
  loadProviderSecret,
  syncTunnelIngress,
  type ProviderSecret,
} from "../dns-providers/tunnels";
import { appServerAddresses, checkDomainDns } from "../domains/dns-check";
import { certProviderForDnsWithinQuota } from "../domains/letsencrypt-quota";
import { withKeyedLock } from "../keyed-mutex";
import { messageOf } from "../../utils";

const ACTOR = "Deplo";
const RECORD_COMMENT = "Deplo app";

type TunnelRow = typeof appTunnels.$inferSelect;
type Actor = { id: string; name: string };

async function loadAppTunnel(appId: string): Promise<TunnelRow | null> {
  const [row] = await getDb()
    .select()
    .from(appTunnels)
    .where(eq(appTunnels.appId, appId));
  return row ?? null;
}

async function heldDomains(appId: string) {
  return getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      providerId: appTunnelDomains.providerId,
      active: appTunnelDomains.active,
      wasTunnel: appTunnelDomains.wasTunnel,
      error: appTunnelDomains.error,
      recordId: domainDnsRecords.recordId,
      created: domainDnsRecords.created,
      oldTunnel: domainDnsRecords.tunnelId,
    })
    .from(appTunnelDomains)
    .innerJoin(domainsTable, eq(domainsTable.id, appTunnelDomains.domainId))
    .leftJoin(
      domainDnsRecords,
      eq(domainDnsRecords.domainId, appTunnelDomains.domainId),
    )
    .where(eq(appTunnelDomains.appId, appId));
}

/** The run token the App's connector starts with; null while no domain of the App is served by its tunnel. */
export async function loadAppConnectorToken(
  appId: string,
): Promise<string | null> {
  const row = await loadAppTunnel(appId);
  if (!row || (await heldDomains(appId)).length === 0) return null;
  return decryptSecretOrThrow(row.tokenEnc, "the App's tunnel token");
}

/** Whether a domain of the App goes through its own tunnel, which reaches every server it runs on. */
export async function appHasTunnel(appId: string): Promise<boolean> {
  return (
    (await loadAppTunnel(appId)) !== null &&
    (await heldDomains(appId)).length > 0
  );
}

function tunnelName(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `deplo-app-${clean || "app"}-${randomBytes(3).toString("hex")}`;
}

/** The App's tunnel, created on first use in the provider's Cloudflare account. */
export async function ensureAppTunnel(
  app: { id: string; slug: string },
  provider: ProviderSecret,
): Promise<TunnelRow> {
  return withKeyedLock(`app-tunnel:${app.id}`, async () => {
    const held = await loadAppTunnel(app.id);
    if (held) {
      const home = await loadProviderSecret(held.providerId);
      // A CNAME reaches a tunnel only from a zone of the tunnel's own Cloudflare account.
      if (home && home.accountId !== provider.accountId)
        throw new Error(
          "This App's Cloudflare Tunnel is in another Cloudflare account, so this domain cannot use it",
        );
      return held;
    }
    const tunnelId = await cloudflare.createTunnel(
      provider.token,
      provider.accountId,
      tunnelName(app.slug),
    );
    try {
      const token = await cloudflare.tunnelToken(
        provider.token,
        provider.accountId,
        tunnelId,
      );
      const row: TunnelRow = {
        appId: app.id,
        providerId: provider.id,
        tunnelId,
        tokenEnc: encryptSecret(token),
        createdAt: nowIso(),
      };
      await getDb().insert(appTunnels).values(row);
      return row;
    } catch (e) {
      await cloudflare
        .deleteTunnel(provider.token, provider.accountId, tunnelId)
        .catch(() => {});
      throw e;
    }
  });
}

/** Tells Cloudflare which hostnames the App's tunnel hands to the member's proxy. */
async function syncAppIngress(
  row: TunnelRow,
  provider: ProviderSecret,
): Promise<void> {
  await cloudflare.setTunnelIngress(
    provider.token,
    provider.accountId,
    row.tunnelId,
    appTunnelIngress((await heldDomains(row.appId)).map((d) => d.name)),
  );
}

/** A domain added to a cluster App already points at its tunnel: hold it there and put it in the ingress. */
export async function registerAppTunnelDomain(
  appId: string,
  domainId: string,
  providerId: string,
): Promise<void> {
  await getDb()
    .insert(appTunnelDomains)
    .values({ domainId, appId, providerId, active: true, createdAt: nowIso() })
    .onConflictDoUpdate({
      target: appTunnelDomains.domainId,
      set: { providerId, active: true, error: null },
    });
  await settleAppTunnel(appId);
}

/** After a domain came, went or was renamed: the ingress follows the domains, and a tunnel nothing uses is deleted. */
export async function settleAppTunnel(appId: string): Promise<void> {
  const row = await loadAppTunnel(appId);
  if (!row) return;
  if ((await heldDomains(appId)).length === 0) {
    await retireAppTunnel(appId);
    return;
  }
  const provider = await loadProviderSecret(row.providerId).catch(() => null);
  if (!provider) return;
  await syncAppIngress(row, provider).catch((e) =>
    console.warn(`[app-tunnel] ${appId}: ${messageOf(e)}`),
  );
}

/** Deletes the App's tunnel in Cloudflare and here, run token included; the connector leaves the stack at its next render. */
export async function retireAppTunnel(appId: string): Promise<string | null> {
  const row = await loadAppTunnel(appId);
  if (!row) return null;
  const provider = await loadProviderSecret(row.providerId).catch(() => null);
  let problem: string | null = null;
  if (provider) {
    try {
      await cloudflare.deleteTunnel(
        provider.token,
        provider.accountId,
        row.tunnelId,
      );
    } catch (e) {
      problem = `Cloudflare still has the tunnel ${row.tunnelId}: ${messageOf(e)}. Delete it there.`;
    }
  } else problem = "Deplo could not open the saved Cloudflare API token";
  await getDb().delete(appTunnels).where(eq(appTunnels.appId, appId));
  await getDb()
    .delete(appTunnelDomains)
    .where(eq(appTunnelDomains.appId, appId));
  return problem;
}

// A hostname another App also answers on (a path of it) cannot move to this App's tunnel alone.
async function sharedHostnames(appId: string): Promise<Set<string>> {
  const mine = await getDb()
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, appId));
  const shared = new Set<string>();
  for (const d of mine) {
    const [other] = await getDb()
      .select({ id: domainsTable.id })
      .from(domainsTable)
      .where(and(eq(domainsTable.name, d.name), ne(domainsTable.appId, appId)))
      .limit(1);
    if (other) shared.add(d.name);
  }
  return shared;
}

// The zone that covers each domain the tunnel does not hold yet: the one its record is in, else one the actor may use.
async function coveredDomains(
  app: { id: string; teamId: string },
  actorId: string,
): Promise<{ id: string; tunnel: boolean; providerId: string }[]> {
  const held = new Set((await heldDomains(app.id)).map((d) => d.id));
  const shared = await sharedHostnames(app.id);
  const managed = new Map(
    (
      await getDb()
        .select({
          id: domainDnsRecords.domainId,
          providerId: domainDnsRecords.providerId,
        })
        .from(domainDnsRecords)
        .innerJoin(domainsTable, eq(domainsTable.id, domainDnsRecords.domainId))
        .where(eq(domainsTable.appId, app.id))
    ).map((r) => [r.id, r.providerId]),
  );
  const all = (await loadDomainsForApp(app.id)).sort(
    (a, b) => Number(b.primary) - Number(a.primary),
  );
  const out: { id: string; tunnel: boolean; providerId: string }[] = [];
  for (const d of all) {
    if (held.has(d.id) || d.source === "auto" || shared.has(d.name)) continue;
    const providerId =
      managed.get(d.id) ??
      (await providerForHostname(d.name, app.teamId, actorId))?.id;
    if (providerId)
      out.push({ id: d.id, tunnel: d.tunnel === true, providerId });
  }
  return out;
}

/**
 * Gives a cluster App its own tunnel and holds under it every domain a connected Cloudflare zone covers.
 * DNS does not move yet: that waits for the connector (`activateAppTunnel`). Returns how many it took in.
 */
export async function joinAppTunnel(
  appId: string,
  actor?: Actor,
): Promise<number> {
  const app = await loadAppGraph(appId);
  if (!app?.clusterId) return 0;
  const found = await coveredDomains(app, actor?.id ?? "");
  if (found.length === 0) return 0;
  const secrets = new Map<string, ProviderSecret | null>();
  for (const f of found)
    if (!secrets.has(f.providerId))
      secrets.set(
        f.providerId,
        await loadProviderSecret(f.providerId).catch(() => null),
      );
  const existing = await loadAppTunnel(appId);
  const home = existing
    ? await loadProviderSecret(existing.providerId).catch(() => null)
    : (secrets.get(found[0].providerId) ?? null);
  if (!home) return 0;
  const use = found.filter(
    (f) => secrets.get(f.providerId)?.accountId === home.accountId,
  );
  if (use.length === 0) return 0;
  const row = await ensureAppTunnel({ id: appId, slug: app.slug }, home);
  for (const f of use)
    await getDb()
      .insert(appTunnelDomains)
      .values({
        domainId: f.id,
        appId,
        providerId: f.providerId,
        wasTunnel: f.tunnel,
        active: false,
        createdAt: nowIso(),
      })
      .onConflictDoNothing();
  await syncAppIngress(row, home);
  const left = found.length - use.length;
  if (!existing)
    await recordActivity(
      "app",
      `Gave ${app.name} its own Cloudflare Tunnel. Its domains switch to it once it is running on the cluster${
        left > 0
          ? `; ${left} in another Cloudflare account keep an address that changes`
          : ""
      }`,
      actor?.name ?? ACTOR,
      appId,
      app.teamId,
    );
  return use.length;
}

async function knownServerAddresses(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ ip: serversTable.ip, host: serversTable.host })
    .from(serversTable);
  return new Set(rows.flatMap((r) => [r.ip, r.host]).filter(Boolean));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// DNS moves only once the connector has reached Cloudflare: before that the tunnel answers nobody.
async function connected(
  row: TunnelRow,
  home: ProviderSecret,
  waitMs: number,
): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    const health = await cloudflare
      .tunnelHealth(home.token, home.accountId, row.tunnelId)
      .catch(() => null);
    if (health && health.connections > 0) return true;
    if (Date.now() >= until) return false;
    await sleep(Math.min(2000, waitMs));
  }
}

/**
 * Points each pending domain at the App's tunnel, hostname unchanged, once its connector is connected.
 * `waitMs` is how long to wait for a connector that has just started. Returns how many switched.
 */
export async function activateAppTunnel(
  appId: string,
  waitMs = 0,
): Promise<number> {
  return withKeyedLock(`app-tunnel-switch:${appId}`, async () => {
    if (await instanceFrozen()) return 0;
    const row = await loadAppTunnel(appId);
    if (!row) return 0;
    const pending = (await heldDomains(appId)).filter((d) => !d.active);
    if (pending.length === 0) return 0;
    const app = await loadAppGraph(appId);
    const home = await loadProviderSecret(row.providerId).catch(() => null);
    if (!app || !home || !(await connected(row, home, waitMs))) return 0;

    const addresses = await knownServerAddresses();
    const serverTunnels = new Set(
      (
        await getDb()
          .select({ id: dnsProviderTunnels.tunnelId })
          .from(dnsProviderTunnels)
      ).map((t) => `${t.id}${cloudflare.TUNNEL_TARGET_SUFFIX}`),
    );
    const switched: string[] = [];
    const kept: string[] = [];
    const resync = new Set<string>();
    for (const d of pending) {
      try {
        const provider = await loadProviderSecret(d.providerId);
        if (!provider)
          throw new Error("its Cloudflare connection is gone from Deplo");
        const pointed = await cloudflare.pointAtTunnel(
          provider.token,
          provider.zoneId,
          d.name,
          row.tunnelId,
          // Deplo's own record, or one that points at a server or a tunnel of this Deplo.
          (r) =>
            r.id === d.recordId ||
            addresses.has(r.content) ||
            serverTunnels.has(r.content.toLowerCase()),
          RECORD_COMMENT,
        );
        const created = pointed.created || d.created === true;
        await getDb()
          .insert(domainDnsRecords)
          .values({
            domainId: d.id,
            providerId: provider.id,
            zoneId: provider.zoneId,
            recordId: pointed.id,
            tunnelId: null,
            created,
            createdAt: nowIso(),
          })
          .onConflictDoUpdate({
            target: domainDnsRecords.domainId,
            set: {
              providerId: provider.id,
              zoneId: provider.zoneId,
              recordId: pointed.id,
              tunnelId: null,
              created,
            },
          });
        // Cloudflare owns HTTPS for a tunnel-served name, as for any tunnel domain.
        await getDb()
          .update(domainsTable)
          .set({
            tunnel: true,
            proxied: true,
            ssl: true,
            certProvider: "cloudflare",
            entrypoint: null,
          })
          .where(eq(domainsTable.id, d.id));
        await getDb()
          .update(appTunnelDomains)
          .set({ active: true, error: null })
          .where(eq(appTunnelDomains.domainId, d.id));
        if (d.oldTunnel) resync.add(d.oldTunnel);
        switched.push(d.name);
      } catch (e) {
        const error = messageOf(e);
        await getDb()
          .update(appTunnelDomains)
          .set({ error })
          .where(eq(appTunnelDomains.domainId, d.id));
        // Tried again on every sweep; said once.
        if (error !== d.error) kept.push(`${d.name} (${error})`);
      }
    }
    for (const id of resync) await resyncServerTunnel(id);
    if (switched.length > 0)
      await recordActivity(
        "domain",
        `Switched ${switched.join(", ")} to ${app.name}'s Cloudflare Tunnel: the address stays the same wherever it runs`,
        ACTOR,
        appId,
        app.teamId,
      );
    if (kept.length > 0)
      await recordActivity(
        "domain",
        `Could not switch these to ${app.name}'s Cloudflare Tunnel, so they stop answering when it fails over: ${kept.join("; ")}`,
        ACTOR,
        appId,
        app.teamId,
      );
    return switched.length;
  });
}

async function resyncServerTunnel(tunnelRowId: string): Promise<void> {
  const [t] = await getDb()
    .select({
      id: dnsProviderTunnels.id,
      tunnelId: dnsProviderTunnels.tunnelId,
      providerId: dnsProviderTunnels.providerId,
    })
    .from(dnsProviderTunnels)
    .where(eq(dnsProviderTunnels.id, tunnelRowId));
  const provider = t
    ? await loadProviderSecret(t.providerId).catch(() => null)
    : null;
  if (t && provider) await syncTunnelIngress(provider, t).catch(() => {});
}

/**
 * The sweep: a cluster App whose domains came to be covered (its server joined, a zone was connected later)
 * gets its tunnel, the connector goes into a running stack, and DNS switches once it is connected.
 */
export async function reconcileAppTunnels(): Promise<void> {
  if (await instanceFrozen()) return;
  const onCluster = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(isNotNull(appsTable.clusterId));
  for (const a of onCluster)
    await joinAppTunnel(a.id).catch((e) =>
      console.warn(`[app-tunnel] ${a.id}: ${messageOf(e)}`),
    );
  const pending = await getDb()
    .selectDistinct({ appId: appTunnelDomains.appId })
    .from(appTunnelDomains)
    .where(eq(appTunnelDomains.active, false));
  for (const { appId } of pending)
    await connectAppTunnel(appId).catch((e) =>
      console.warn(`[app-tunnel] ${appId}: ${messageOf(e)}`),
    );
}

// The connector goes into the running stack, and DNS switches once it is connected.
async function connectAppTunnel(appId: string): Promise<void> {
  const { rerouteApp } = await import("../../deploy/build/reroute");
  await rerouteApp(appId);
  if ((await activateAppTunnel(appId)) > 0) await rerouteApp(appId);
}

/** A server joined a cluster: the Apps that came with it get their tunnel now, with the zones of whoever joined it. */
export async function joinAppTunnels(
  appIds: string[],
  actor: Actor,
): Promise<void> {
  if (await instanceFrozen()) return;
  for (const id of appIds)
    try {
      if ((await joinAppTunnel(id, actor)) > 0) await connectAppTunnel(id);
    } catch (e) {
      console.warn(`[app-tunnel] ${id}: ${messageOf(e)}`);
    }
}

/** The App left its cluster: each switched domain goes back to the server it runs on now, and the tunnel is deleted. */
export async function leaveAppTunnel(
  appId: string,
  actor?: Actor,
): Promise<void> {
  const row = await loadAppTunnel(appId);
  if (!row) return;
  const app = await loadAppGraph(appId);
  if (!app) return;
  const back: string[] = [];
  const stuck: string[] = [];
  for (const d of await heldDomains(appId)) {
    try {
      if (d.active) {
        await switchBack(d, app);
        back.push(d.name);
      }
      await getDb()
        .delete(appTunnelDomains)
        .where(eq(appTunnelDomains.domainId, d.id));
    } catch (e) {
      stuck.push(`${d.name} (${messageOf(e)})`);
    }
  }
  // A domain that could not go back keeps the tunnel, and with it the connector in the stack.
  await settleAppTunnel(appId);
  if (back.length > 0)
    await recordActivity(
      "domain",
      `Pointed ${back.join(", ")} back at ${app.name}'s server`,
      actor?.name ?? ACTOR,
      appId,
      app.teamId,
    );
  if (stuck.length > 0)
    await recordActivity(
      "domain",
      `Could not point these back at ${app.name}'s server, so they still use its Cloudflare Tunnel: ${stuck.join("; ")}`,
      ACTOR,
      appId,
      app.teamId,
    );
}

async function switchBack(
  d: Awaited<ReturnType<typeof heldDomains>>[number],
  app: { id: string; teamId: string; serverId: string },
): Promise<void> {
  const provider = await loadProviderSecret(d.providerId);
  if (!provider)
    throw new Error("its Cloudflare connection is gone from Deplo");
  if (d.recordId)
    await cloudflare.deleteDnsRecord(
      provider.token,
      provider.zoneId,
      d.recordId,
    );
  await getDb()
    .delete(domainDnsRecords)
    .where(eq(domainDnsRecords.domainId, d.id));
  if (d.wasTunnel) {
    await rememberDomainDns(
      d.id,
      await pointAtServerTunnel(provider, app.serverId, d.name),
    );
    return;
  }
  const targets = await appServerAddresses(app.id);
  const pointed = await cloudflare.pointAtAddress(
    provider.token,
    provider.zoneId,
    d.name,
    { v4: targets.v4[0] ?? null, v6: targets.v6[0] ?? null },
    RECORD_COMMENT,
  );
  if (pointed)
    await rememberDomainDns(d.id, {
      providerId: provider.id,
      zoneId: provider.zoneId,
      recordId: pointed.id,
      tunnelRowId: null,
      created: pointed.created,
    });
  const status = await checkDomainDns(d.name, targets);
  // ponytail: the certificate choice from before the join is not kept; it goes back to the default for its DNS.
  await getDb()
    .update(domainsTable)
    .set({
      tunnel: null,
      proxied: null,
      status,
      certProvider: await certProviderForDnsWithinQuota(
        app.teamId,
        status,
        "letsencrypt",
      ),
      entrypoint: null,
    })
    .where(eq(domainsTable.id, d.id));
}

/**
 * What an App with no domain on Cloudflare is told before it is placed on a cluster and on its page after:
 * null once its tunnel holds a domain, or a connected zone covers one (the sweep takes it in).
 */
export async function clusterAddressNote(app: {
  id: string;
  teamId: string;
}): Promise<string | null> {
  if ((await heldDomains(app.id)).length > 0) return null;
  const viewer = await getCurrentUser();
  const covered = await coveredDomains(app, viewer?.id ?? "");
  return covered.length > 0 ? null : ADDRESS_CHANGES_NOTE;
}
