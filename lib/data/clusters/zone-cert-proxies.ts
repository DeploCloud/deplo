import "server-only";

import {
  dnsChallengePresent,
  hasDnsChallenge,
  withDnsChallenge,
} from "../../deploy/traefik-cluster";
import type { ZoneCertMember } from "../../deploy/zone-certs";
import {
  DNS_CERTIFICATES_CAPABILITY,
  DNS_CHALLENGE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import { connectAgent } from "../../infra/agent-client/connect";
import { serverSupports } from "../../infra/agent-client/preflight";
import { messageOf } from "../../utils";
import { instanceFrozen } from "../deplo-move/freeze";

// Each member's proxy and the resolver that checks certificates over DNS (ADR-0049 phase 3):
// https://deplo.build/docs/operations/clusters/dns-zone

const g = globalThis as unknown as {
  [k: symbol]: Map<string, unknown> | undefined;
};
const PROXIES = Symbol.for("deplo.cluster.dns-challenge.proxies");
const proxies = () =>
  (g[PROXIES] ??= new Map()) as Map<string, { on: boolean; at: number }>;
// A proxy is read again after this long, in case it was put back by hand.
const PROXY_KNOWN_FOR_MS = 60 * 60_000;

/** Test seam: forget what the members' proxies were seen to have. */
export function __forgetZoneCertProxies(): void {
  proxies().clear();
}

/** Puts the resolver that checks over DNS in a server's proxy, or takes it out; answers whether the proxy changed. */
export async function syncDnsChallengeProxy(
  serverId: string,
  on: boolean,
  opts: { inZonePass?: boolean } = {},
): Promise<boolean> {
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  return withTraefikStackLock(serverId, async () => {
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    if (!yaml || (on ? hasDnsChallenge(yaml) : !dnsChallengePresent(yaml))) {
      proxies().set(serverId, { on: Boolean(yaml) && on, at: Date.now() });
      return false;
    }
    const res = await applyTraefikConfig(
      serverId,
      { composeYaml: withDnsChallenge(yaml, on) },
      opts,
    );
    if (!res.ok)
      throw new Error(
        res.error || "The proxy on this server refused the change",
      );
    proxies().set(serverId, { on, at: Date.now() });
    return true;
  });
}

/** Whether a server's proxy has that resolver, read again after an hour; one that cannot be read keeps its last answer. */
async function dnsChallengeOn(serverId: string): Promise<boolean> {
  const seen = proxies().get(serverId);
  if (seen && Date.now() - seen.at < PROXY_KNOWN_FOR_MS) return seen.on;
  const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
  try {
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    const on = Boolean(yaml) && hasDnsChallenge(yaml);
    proxies().set(serverId, { on, at: Date.now() });
    return on;
  } catch {
    return seen?.on ?? false;
  }
}

/**
 * Every member's proxy gets the resolver while its cluster has a zone and its agent can set checks: one server at a
 * time, as each change restarts its proxy. A member whose agent cannot gets nothing and holds its cluster on HTTP-01.
 */
export async function zoneCertMembers(
  members: {
    serverId: string;
    fingerprint: string | null;
    joinedAt: string;
    emptying: boolean;
  }[],
  reachable: (serverId: string) => boolean,
): Promise<ZoneCertMember[]> {
  const out: ZoneCertMember[] = [];
  for (const m of members) {
    if (!m.fingerprint) continue;
    const caps = reachable(m.serverId)
      ? await capabilitiesOf(m.serverId)
      : null;
    const up = caps !== null;
    let capable = false;
    if (caps?.includes(DNS_CHALLENGE_CAPABILITY)) {
      capable = await dnsChallengeOn(m.serverId);
      if (!capable && !(await instanceFrozen()))
        capable = await syncDnsChallengeProxy(m.serverId, true, {
          inZonePass: true,
        })
          .then(() => dnsChallengeOn(m.serverId))
          .catch((e) => {
            console.warn(
              `[zone-certs] ${m.serverId}: ${messageOf(e).replace(/\s+/g, " ").slice(0, 300)}`,
            );
            return false;
          });
    } else if (!up) capable = proxies().get(m.serverId)?.on ?? true;
    const shares = caps?.includes(DNS_CERTIFICATES_CAPABILITY) ?? false;
    out.push({
      ...m,
      fingerprint: m.fingerprint,
      capable,
      reachable: up,
      shares,
    });
  }
  return out;
}

/** What a server's agent says it can do, or null when it does not answer. */
async function capabilitiesOf(serverId: string): Promise<string[] | null> {
  try {
    const conn = await connectAgent(serverId);
    try {
      return (await conn.hello()).capabilities ?? [];
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

/** A server leaving its cluster's zone loses the resolver; it throws when its proxy could not be changed. */
export async function dropDnsChallengeProxy(serverId: string): Promise<void> {
  if (await serverSupports(serverId, DNS_CHALLENGE_CAPABILITY))
    await syncDnsChallengeProxy(serverId, false);
}
