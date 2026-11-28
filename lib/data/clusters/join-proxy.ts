import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { clusterDnsZones } from "../../db/schema/control-plane/clusters";
import {
  hasAnswerSupport,
  hasDnsChallenge,
  withAnswerSupport,
  withDnsChallenge,
} from "../../deploy/traefik-cluster";
import {
  CLUSTER_ANSWERS_CAPABILITY,
  DNS_CHALLENGE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import { answeringApps } from "./answers";

/**
 * A joining server's proxy takes what the cluster's proxies carry, in one restart, before it is a member: the first
 * move onto it never meets a proxy that answers 404 (c48: recreated two minutes after the join).
 */
export async function prepareJoiningProxy(
  cluster: { id: string; name: string },
  server: { id: string; name: string },
): Promise<void> {
  const answers =
    (await answeringApps(cluster.id)).size > 0 &&
    (await serverSupports(server.id, CLUSTER_ANSWERS_CAPABILITY));
  const [zone] = await getDb()
    .select({ id: clusterDnsZones.id })
    .from(clusterDnsZones)
    .where(eq(clusterDnsZones.clusterId, cluster.id))
    .limit(1);
  const dns =
    zone !== undefined &&
    (await serverSupports(server.id, DNS_CHALLENGE_CAPABILITY));
  if (!answers && !dns) return;
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  await withTraefikStackLock(server.id, async () => {
    const yaml = (await fetchHostInfo(server.id)).traefikComposeYaml;
    if (!yaml) return;
    let next = yaml;
    if (answers && !hasAnswerSupport(next))
      next = withAnswerSupport(next, true);
    if (dns && !hasDnsChallenge(next)) next = withDnsChallenge(next, true);
    if (next === yaml) return;
    const res = await applyTraefikConfig(server.id, { composeYaml: next });
    if (!res.ok)
      throw new Error(
        `The proxy on ${server.name} refused what cluster ${cluster.name} needs, so it did not join: ${res.error || "it gave no reason"}`,
      );
  });
}
