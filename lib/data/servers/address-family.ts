import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  isWildcardIp,
  rehostWildcard,
  wildcardEmbeddedIp,
} from "../../deploy/domains";
import { recordActivity } from "../activity";
import { syncProductionUrl } from "../domains/primary-domain";
import { repointRedirects } from "../domains/www-pairing";
import { getServerById, requireAdminServer } from "./roster";
import { serverAddressChoices, serverWildcardIp } from "./addresses";
import type { AddressFamily, Server } from "../../types/server";

export const ADDRESS_FAMILIES: readonly AddressFamily[] = ["ipv4", "ipv6"];

const LABEL: Record<AddressFamily, string> = { ipv4: "IPv4", ipv6: "IPv6" };

// Every generated name an app on this server holds moves with the address, or it would answer from the old one.
export async function rehostServerDomains(
  serverId: string,
  fromIp: string,
  toIp: string,
): Promise<number> {
  const rows = await getDb()
    .select({
      id: domainsTable.id,
      name: domainsTable.name,
      appId: domainsTable.appId,
      teamId: appsTable.teamId,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(eq(appsTable.serverId, serverId), eq(domainsTable.source, "auto")),
    );
  const moved = new Map<string, string>();
  for (const row of rows) {
    if (wildcardEmbeddedIp(row.name) !== fromIp) continue;
    const name = rehostWildcard(row.name, toIp);
    if (name === row.name) continue;
    await getDb()
      .update(domainsTable)
      .set({ name })
      .where(eq(domainsTable.id, row.id));
    await repointRedirects(row.appId, row.name, name, row.teamId);
    moved.set(row.appId, row.teamId);
  }
  for (const appId of moved.keys()) await syncProductionUrl(appId);
  return moved.size;
}

/** Which kind of address this server's generated names carry; null goes back to automatic. */
export async function setServerAddressFamily(
  id: string,
  family: AddressFamily | null,
): Promise<{ server: Server; appsMoved: number }> {
  const { teamId, user, server } = await requireAdminServer(id);
  if (family !== null && !ADDRESS_FAMILIES.includes(family))
    throw new Error(`Unknown address kind "${family}". Pick "ipv4" or "ipv6".`);
  if (family === server.generatedAddressFamily && !server.preferredAddress)
    return { server, appsMoved: 0 };

  const next = {
    ...server,
    generatedAddressFamily: family,
    preferredAddress: null,
  };
  if (family) {
    const choices = await serverAddressChoices(next);
    if (!choices[family])
      throw new Error(
        `${server.name} has no ${LABEL[family]} address Deplo can use, so its generated addresses cannot move there.`,
      );
  }
  const [fromIp, toIp] = await Promise.all([
    serverWildcardIp(server),
    serverWildcardIp(next),
  ]);

  await getDb()
    .update(serversTable)
    .set({ generatedAddressFamily: family, preferredAddress: null })
    .where(eq(serversTable.id, id));
  const appsMoved =
    fromIp && toIp && fromIp !== toIp
      ? await rehostServerDomains(id, fromIp, toIp)
      : 0;

  // The zone's records and glue, and the domain hints, follow the family too.
  await (await import("./address-checks")).followAddresses(id, toIp);
  await recordActivity(
    "server",
    family
      ? `Set ${server.name} to use ${LABEL[family]} only`
      : `Set ${server.name} to use its addresses automatically`,
    user.name,
    null,
    teamId,
  );
  return { server: (await getServerById(id))!, appsMoved };
}

/** The one address this server's generated names carry, or null for automatic; they move with it. */
export async function setServerPreferredAddress(
  id: string,
  address: string | null,
): Promise<{ server: Server; appsMoved: number }> {
  const { teamId, user, server } = await requireAdminServer(id);
  const chosen = address?.trim() || null;
  if (chosen === server.preferredAddress && !server.generatedAddressFamily)
    return { server, appsMoved: 0 };
  if (chosen) {
    if (!isWildcardIp(chosen))
      throw new Error(
        `${chosen} cannot carry a generated address. Pick any IPv4 or a public IPv6.`,
      );
    const { publishedServerAddresses } = await import("./address-checks");
    const all = await publishedServerAddresses(id, Date.now(), {
      includePrivate: true,
    });
    if (!all?.v4.includes(chosen) && !all?.v6.includes(chosen))
      throw new Error(
        `${chosen} does not reach ${server.name}, so its generated addresses cannot move there.`,
      );
  }

  const next = {
    ...server,
    preferredAddress: chosen,
    generatedAddressFamily: null,
  };
  const [fromIp, toIp] = await Promise.all([
    serverWildcardIp(server),
    serverWildcardIp(next),
  ]);
  await getDb()
    .update(serversTable)
    .set({ preferredAddress: chosen, generatedAddressFamily: null })
    .where(eq(serversTable.id, id));
  const appsMoved =
    fromIp && toIp && fromIp !== toIp
      ? await rehostServerDomains(id, fromIp, toIp)
      : 0;

  await (await import("./address-checks")).followAddresses(id, toIp);
  await recordActivity(
    "server",
    chosen
      ? `Set ${server.name} to use ${chosen} for its generated addresses`
      : `Set ${server.name} to use its addresses automatically`,
    user.name,
    null,
    teamId,
  );
  return { server: (await getServerById(id))!, appsMoved };
}
