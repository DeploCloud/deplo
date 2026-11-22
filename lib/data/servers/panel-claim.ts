import "server-only";

import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { getDb } from "../../db/client";
import { acmeAuthority, withAcmeAuthority } from "../../deploy/acme-authority";
import { connectAgent } from "../../infra/agent-client/connect";
import { PANEL_CLAIM_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import {
  applyTraefikConfig,
  fetchHostInfo,
  withTraefikStackLock,
} from "../../infra/agent-client/host-ops";
import { onAgentLink } from "../../infra/agent-link/registry";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { runsClusterBinary } from "../clusters/binary-rollout";
import { syncClusterNetworkSoon } from "../clusters/network";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "./roster";

// A server belongs to this Deplo only: on every link it hears which clusters and which certificate authority are
// this Deplo's, and sets aside what another Deplo left. https://deplo.build/docs/operations/servers/add-a-server

/** What another Deplo left on a server, as its agent said on its last link. */
export interface LeftByAnotherDeplo {
  setAsideAt: string;
  left: { kind: string; name: string; app: string }[];
}

interface Claims {
  off: (() => void) | null;
  running: Map<string, Promise<void>>;
  last: Map<string, LeftByAnotherDeplo>;
  /** Agents restarting to set something aside: their peers hear the new network key once they are back. */
  restarting: Set<string>;
}

const KEY = Symbol.for("deplo.panel-claim");
const g = globalThis as unknown as { [KEY]?: Claims };
const claims: Claims = (g[KEY] ??= {
  off: null,
  running: new Map(),
  last: new Map(),
  restarting: new Set(),
});

/** Claims each server when it links. Start it before the door opens. */
export function startPanelClaims(): void {
  if (claims.off) return;
  claims.off = onAgentLink((e) => {
    if (e.type !== "up") return;
    const claim = e.hello.capabilities.includes(PANEL_CLAIM_CAPABILITY);
    void claimServer(e.serverId, claim);
  });
}

const SHOWN_FOR_MS = 7 * 24 * 3600 * 1000;

/** Said for a week after it is set aside, and for as long as another Deplo's Apps remain. */
export function leftByAnotherDeplo(
  serverId: string,
  now = Date.now(),
): LeftByAnotherDeplo | null {
  const last = claims.last.get(serverId);
  if (!last) return null;
  const recent = now - Date.parse(last.setAsideAt) < SHOWN_FOR_MS;
  return last.left.length > 0 || recent ? last : null;
}

export function claimServer(serverId: string, claim = true): Promise<void> {
  const running = claims.running.get(serverId);
  if (running) return running;
  const run = reconcile(serverId, claim)
    .catch((e) =>
      console.error(`[deplo] claiming ${serverId} failed: ${messageOf(e)}`),
    )
    .finally(() => claims.running.delete(serverId));
  claims.running.set(serverId, run);
  return run;
}

async function reconcile(serverId: string, claim: boolean): Promise<void> {
  if (await instanceFrozen()) return;
  const server = await getServerById(serverId);
  if (!server || server.importOnly) return;
  if (claim) {
    const clusterIds = (
      await getDb().select({ id: clustersTable.id }).from(clustersTable)
    ).map((c) => c.id);
    // ponytail: read once per link; a leader moved here in that instant is installed again by its rollout.
    const clusterHost = await runsClusterBinary(serverId);
    const conn = await connectAgent(serverId);
    let r;
    try {
      r = await conn.claimServer({ clusterIds, clusterHost });
    } finally {
      conn.close();
    }
    if (r.restarting) {
      claims.restarting.add(serverId);
      await recordActivity(
        "server",
        `Setting aside what another Deplo left on ${server.name}`,
        "Deplo",
      );
      return;
    }
    if (r.setAside)
      claims.last.set(serverId, {
        setAsideAt: new Date(r.setAsideAtMs).toISOString(),
        left: r.left.map((l) => ({ kind: l.kind, name: l.name, app: l.app })),
      });
    else claims.last.delete(serverId);
    if (claims.restarting.delete(serverId))
      for (const id of clusterIds) syncClusterNetworkSoon(id);
  }
  await pointProxyAtAuthority(serverId, server.name);
}

/** The proxy orders from this Deplo's authority, whatever its file said before. */
async function pointProxyAtAuthority(
  serverId: string,
  name: string,
): Promise<void> {
  const authority = acmeAuthority();
  const res = await withTraefikStackLock(serverId, async () => {
    // Empty: Deplo did not install this server's Traefik, so it is not Deplo's to change.
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    const next = yaml ? withAcmeAuthority(yaml, authority) : null;
    return next ? applyTraefikConfig(serverId, { composeYaml: next }) : null;
  });
  if (!res) return;
  const who = authority.directory ?? "Let's Encrypt";
  await recordActivity(
    "server",
    res.ok
      ? `The proxy on ${name} now gets its certificates from ${who}`
      : `Could not point the proxy on ${name} at ${who}: ${res.error || "it did not restart"}. Deplo retries when the server reconnects.`,
    "Deplo",
  );
}
