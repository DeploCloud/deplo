import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { domainTlsConfig, wildcardEmbeddedIp } from "../../deploy/domains";
import type { CertProvider, DomainEntrypoint } from "../../types/domain";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { requireAppCapability } from "../node-access";
import { getCurrentUser } from "../../auth/current-user";
import { answerAppsRefusal } from "../clusters/answers";
import { clusterMemberServerIds } from "../clusters/roster";
import { getServerById } from "../servers/roster";

// "Answer on every server" (ADR-0048): https://deplo.build/docs/operations/clusters/addresses

export type AnswerSwitchFacts = {
  name: string;
  inCluster: boolean;
  tunnel: boolean;
  https: boolean;
  pathPrefix: string;
  /** Another domain row serves a path of this hostname. */
  sharedByPath: boolean;
};

/** Why this domain cannot answer on every server, in the person's words, or null. */
export function answerSwitchRefusal(f: AnswerSwitchFacts): string | null {
  if (!f.inCluster)
    return "Only an App on a cluster can answer on every server. Move the App to a cluster first.";
  if (wildcardEmbeddedIp(f.name) !== null)
    return `${f.name} is a generated address of one server, so it follows the App by being renamed instead.`;
  if (f.tunnel)
    return `${f.name} is served by the App's Cloudflare tunnel, which already follows the App.`;
  if (!f.https)
    return `${f.name} is served over plain HTTP. Turn on HTTPS first: over plain HTTP the App would lose every visitor's address.`;
  if (f.pathPrefix || f.sharedByPath)
    return `${f.name} is shared by path with another route, and answering on every server sends a whole hostname to one server.`;
  return null;
}

/** A proxy edited by hand to offer HTTP/3 on its secure entrypoint: browsers would try UDP that nothing carries. */
export function proxyOffersHttp3(composeYaml: string): boolean {
  return /--entrypoints\.websecure\.http3/i.test(composeYaml);
}

async function facts(id: string) {
  const [d] = await getDb()
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, id))
    .limit(1);
  if (!d) throw new Error("Not found");
  const shared = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.name, d.name),
        ne(domainsTable.id, d.id),
        sql`coalesce(${domainsTable.pathPrefix}, '') <> ''`,
      ),
    )
    .limit(1);
  return { d, sharedByPath: shared.length > 0 };
}

/**
 * Turns "Answer on every server" on or off for one domain. Refused, with the reason, for a domain it cannot work for;
 * on, it reroutes the App and hands every server of the cluster its table.
 */
export async function setDomainAnswersEverywhere(
  id: string,
  on: boolean,
): Promise<string> {
  if (await instanceFrozen())
    throw new Error(
      "Deplo is moving to another machine; try again once it is done.",
    );
  const { d, sharedByPath } = await facts(id);
  const { membership } = await requireAppCapability(d.appId, "manage_domains");
  const app = await loadAppGraph(d.appId);
  if (!app || app.teamId !== membership.teamId) throw new Error("Not found");
  if ((d.answersEverywhere === true) === on) return d.appId;
  if (on) {
    const tls = domainTlsConfig({
      name: d.name,
      tunnel: d.tunnel === true,
      certProvider: (d.certProvider ?? undefined) as CertProvider | undefined,
      entrypoint: (d.entrypoint ?? undefined) as DomainEntrypoint | undefined,
    });
    const why = answerSwitchRefusal({
      name: d.name,
      inCluster: app.clusterId != null,
      tunnel: d.tunnel === true,
      https: tls.tls,
      pathPrefix: d.pathPrefix ?? "",
      sharedByPath,
    });
    if (why) throw new Error(why);
    const full = await answerAppsRefusal(app.clusterId!, d.appId);
    if (full) throw new Error(full);
    const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
    for (const serverId of await clusterMemberServerIds(app.clusterId!)) {
      const yaml = await fetchHostInfo(serverId)
        .then((h) => h.traefikComposeYaml ?? "")
        .catch(() => "");
      if (proxyOffersHttp3(yaml))
        throw new Error(
          `The proxy on ${(await getServerById(serverId))?.name ?? "a server of the cluster"} offers HTTP/3, which these domains cannot carry. Turn HTTP/3 off there first.`,
        );
    }
  }
  await getDb()
    .update(domainsTable)
    .set({ answersEverywhere: on })
    .where(eq(domainsTable.id, id));
  const user = await getCurrentUser();
  await recordActivity(
    "domain",
    on
      ? `${d.name} now answers on every server of the App's cluster`
      : `${d.name} answers only on the server that runs the App again`,
    user?.name ?? "Deplo",
    d.appId,
    membership.teamId,
  );
  return d.appId;
}

/** Adding a path to a hostname that answers on every server would split it, which passthrough cannot. */
export async function assertNoAnsweredPath(
  name: string,
  pathPrefix: string,
  exceptId?: string,
): Promise<void> {
  if (!pathPrefix) return;
  const rows = await getDb()
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(
      and(
        eq(domainsTable.name, name),
        eq(domainsTable.answersEverywhere, true),
      ),
    );
  if (rows.some((r) => r.id !== exceptId))
    throw new Error(
      `${name} answers on every server, so a path of it cannot go to another route. Turn that off first.`,
    );
}
