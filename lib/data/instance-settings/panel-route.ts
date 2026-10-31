import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import {
  DEFAULT_PANEL_TARGET,
  panelRoute,
  stackCertResolver,
  withPanelRoute,
  type PanelRoute,
} from "../../deploy/traefik-stack";
import { isPanelFallbackHost, panelFallbackHost } from "../../deploy/domains";
import { recordActivity } from "../activity";
import {
  SETTINGS_ID,
  deploHostServer,
  getInstanceSettings,
  instancePublicBaseUrl,
  loadSettings,
  rememberPanelUrl,
  type InstanceSettings,
} from "./settings-store";
import {
  hostOf,
  noRouteReason,
  normalizePanelUrl,
  schemeOf,
} from "./panel-address";
import {
  passkeyLossSuffix,
  passkeysBoundToThisAddress,
} from "./panel-address-impact";
import { forgetRoutedFallback, rememberRoutedFallback } from "./panel-fallback";
import {
  TUNNEL_SERVES_PANEL,
  loadPanelTunnel,
  panelTunnelHostname,
  retirePanelTunnel,
} from "./panel-tunnel-store";
import { withPanelTunnel } from "../../deploy/panel-tunnel-stack";
import { whilePanelAddressesChange } from "../servers/link-addresses";
import { instanceFrozen } from "../deplo-move/freeze";
import { waitForLink } from "../../infra/agent-link/registry";
import { LINK_SETTLE_MS } from "../../infra/agent-link/protocol";
import {
  panelCertificateTrusted,
  probePanel,
  probeUntilAnswers,
  type PanelReachability,
} from "./panel-probe";

export const NO_DEPLO_HOST =
  "The server running Deplo is not added here yet, so Deplo does not manage the panel's own address.";
const ROUTE_REFUSED = "The proxy on this server refused the change";
const TUNNEL_HTTPS =
  "Cloudflare serves the panel's HTTPS through the tunnel, so there is nothing to change here.";

export type PanelHttps = {
  domain: string | null;
  fallbackDomain: string | null;
  enabled: boolean;
  certificateTrusted: boolean | null;
  provider: string | null;
  unavailable: string | null;
};

export async function requireDeploHost() {
  const host = await deploHostServer();
  if (!host) throw new Error(NO_DEPLO_HOST);
  return host;
}

export async function currentPanelRoute(yaml: string): Promise<PanelRoute> {
  return panelRoute(yaml) ?? (await adoptPanelRoute(yaml));
}

async function applyPanelRoute(
  hostId: string,
  currentYaml: string,
  next: PanelRoute,
  refusal: string,
): Promise<void> {
  const { applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  try {
    const res = await applyTraefikConfig(hostId, {
      composeYaml: withPanelRoute(currentYaml, next),
    });
    if (!res.ok) throw new Error(res.error || refusal);
  } catch (e) {
    forgetRoutedFallback();
    throw e;
  }
  rememberRoutedFallback(next.fallbackDomain);
}

export async function setPanelUrl(
  input: string | null,
): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  if (await panelTunnelHostname()) throw new Error(TUNNEL_SERVES_PANEL);

  const url =
    input === null || input.trim() === ""
      ? null
      : await withRoutedScheme(normalizePanelUrl(input));
  const current = await instancePublicBaseUrl();
  // Counted before the write: rpId derives from the address, so afterwards there is no way to say what it invalidated.
  const lostPasskeys =
    url !== null &&
    (hostOf(url) !== hostOf(current) || schemeOf(url) !== schemeOf(current))
      ? await passkeysBoundToThisAddress()
      : 0;
  // The routing moves FIRST and throws if it could not: an address nothing routes to breaks every install command on this page.
  await whilePanelAddressesChange({ url: url ?? undefined }, async () => {
    if (url) await movePanelRoute(url);
    await rememberPanelUrl(url);
  });

  await recordActivity(
    "instance",
    (url
      ? `Set the Deplo panel address to ${url}`
      : "Cleared the Deplo panel address") + passkeyLossSuffix(lostPasskeys),
    user.name,
    null,
    teamId,
  );
  return getInstanceSettings();
}

// The HTTPS switch owns the scheme: a new address never turns it off on the way.
export async function withRoutedScheme(url: string): Promise<string> {
  const host = await deploHostServer();
  if (!host) return url;
  const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
  let yaml: string;
  try {
    yaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
  } catch {
    return url;
  }
  const route = yaml ? panelRoute(yaml) : null;
  if (!route) return url;
  return `${route.https ? "https" : "http"}://${new URL(url).host}`;
}

async function readPanelHttps(): Promise<PanelHttps> {
  const none = {
    domain: null,
    fallbackDomain: null,
    enabled: false,
    provider: null,
    certificateTrusted: null,
  };
  const host = await deploHostServer();
  if (!host)
    return {
      ...none,
      unavailable: NO_DEPLO_HOST,
    };
  try {
    const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
    const info = await fetchHostInfo(host.id);
    if (!info.traefikComposeYaml)
      return {
        ...none,
        unavailable:
          "Deplo did not install the proxy on this server, so it does not manage how the panel is served.",
      };
    const route = panelRoute(info.traefikComposeYaml);
    if (!route) {
      const url = await instancePublicBaseUrl();
      const reason = noRouteReason(url);
      if (reason !== null) return { ...none, unavailable: reason };
      return {
        ...none,
        domain: new URL(url).hostname,
        enabled: url.startsWith("https://"),
        certificateTrusted: await panelCertificateTrusted(url),
        unavailable: null,
      };
    }
    rememberRoutedFallback(route.fallbackDomain);
    const tunneled = (await panelTunnelHostname()) !== null;
    return {
      domain: route.domain,
      fallbackDomain: route.fallbackDomain,
      enabled: route.https,
      provider: route.https ? route.certResolver : null,
      certificateTrusted: route.https
        ? await panelCertificateTrusted(await instancePublicBaseUrl())
        : null,
      unavailable: tunneled ? TUNNEL_HTTPS : null,
    };
  } catch (e) {
    return { ...none, unavailable: e instanceof Error ? e.message : String(e) };
  }
}

export async function getPanelHttps(): Promise<PanelHttps> {
  await requireInstanceAdmin();
  return readPanelHttps();
}

export async function setPanelHttps(enabled: boolean): Promise<PanelHttps> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const host = await requireDeploHost();
  if (await panelTunnelHostname()) throw new Error(TUNNEL_HTTPS);

  const lostPasskeys = enabled ? 0 : await passkeysBoundToThisAddress();

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  const moved = await withTraefikStackLock(host.id, async () => {
    const info = await fetchHostInfo(host.id);
    const current = await currentPanelRoute(info.traefikComposeYaml);
    if (current.https === enabled) return null;

    const next: PanelRoute = {
      ...current,
      fallbackDomain: await panelBackupDomain(current),
      https: enabled,
      certResolver: enabled ? stackCertResolver(info.traefikComposeYaml) : null,
    };
    const url = `${enabled ? "https" : "http"}://${next.domain}`;
    await whilePanelAddressesChange({ url }, async () => {
      await applyPanelRoute(
        host.id,
        info.traefikComposeYaml,
        next,
        ROUTE_REFUSED,
      );
      await rememberPanelUrl(url);
    });
    return next;
  });

  if (moved) {
    await recordActivity(
      "instance",
      (enabled
        ? `Moved the panel to https://${moved.domain}`
        : `Moved the panel to http://${moved.domain}`) +
        passkeyLossSuffix(lostPasskeys),
      user.name,
      null,
      teamId,
    );
  }
  return readPanelHttps();
}

export async function panelBackupDomain(
  current: PanelRoute,
): Promise<string | null> {
  if ((await loadSettings()).panelFallbackDisabled) return null;
  return current.fallbackDomain ?? panelFallbackHost();
}

export async function setPanelFallback(
  enabled: boolean,
): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const host = await requireDeploHost();

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  await whilePanelAddressesChange({ fallbackOff: !enabled }, async () => {
    await withTraefikStackLock(host.id, async () => {
      const info = await fetchHostInfo(host.id);
      const current = await currentPanelRoute(info.traefikComposeYaml);
      if (!enabled && isPanelFallbackHost(current.domain))
        throw new Error(
          `${current.domain} is the panel's own address right now. Give the panel a domain first.`,
        );
      const next: PanelRoute = {
        ...current,
        fallbackDomain: enabled ? panelFallbackHost() : null,
      };
      if (next.fallbackDomain === current.fallbackDomain) return;
      await applyPanelRoute(
        host.id,
        info.traefikComposeYaml,
        next,
        ROUTE_REFUSED,
      );
    });

    const now = nowIso();
    await getDb()
      .insert(instanceSettings)
      .values({
        id: SETTINGS_ID,
        panelFallbackDisabled: !enabled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: instanceSettings.id,
        set: { panelFallbackDisabled: !enabled, updatedAt: now },
      });
  });

  await recordActivity(
    "instance",
    enabled
      ? `Turned the panel's backup address back on (${panelFallbackHost()})`
      : "Turned the panel's backup address off",
    user.name,
    null,
    teamId,
  );
  return getInstanceSettings();
}

async function adoptPanelRoute(currentYaml: string): Promise<PanelRoute> {
  const url = await instancePublicBaseUrl();
  const reason = noRouteReason(url);
  if (reason) throw new Error(reason);

  const reached = await probePanel(DEFAULT_PANEL_TARGET);
  if (!reached.ok)
    throw new Error(
      "This panel is published by its own container, from before Deplo could manage it, and Deplo cannot tell where it listens. Re-run the installer to hand it over.",
    );

  return {
    domain: new URL(url).hostname,
    fallbackDomain: panelFallbackHost(),
    https: url.startsWith("https://"),
    certResolver: url.startsWith("https://")
      ? stackCertResolver(currentYaml)
      : null,
    target: DEFAULT_PANEL_TARGET,
  };
}

async function movePanelRoute(url: string): Promise<void> {
  const host = await deploHostServer();
  if (!host) return;

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  const parsed = new URL(url);
  const domain = parsed.hostname;
  const https = parsed.protocol === "https:";

  await withTraefikStackLock(host.id, async () => {
    let currentYaml: string;
    try {
      currentYaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
    } catch {
      return;
    }
    const current = currentYaml ? panelRoute(currentYaml) : null;
    if (!current || (current.domain === domain && current.https === https))
      return;

    await moveWithRollback({
      from: current,
      to: {
        ...current,
        domain,
        fallbackDomain: await panelBackupDomain(current),
        https,
        certResolver: https ? stackCertResolver(currentYaml) : null,
      },
      apply: async (route) => {
        await applyPanelRoute(
          host.id,
          currentYaml,
          route,
          "The proxy on this server refused the new panel address",
        );
      },
      probe: () => probeUntilAnswers(url),
    });
  });
}

/**
 * The move `deplo recover panel-address` left (scripts/recover.ts), made at start over the link
 * the Deplo host's agent opens over loopback, which a broken public address never touches.
 * Returns the panel's new address, or null when nothing was asked.
 */
export async function applyRecoveredPanelAddress(): Promise<string | null> {
  const [asked] = await getDb()
    .select({
      domain: instanceSettings.panelMoveDomain,
      https: instanceSettings.panelMoveHttps,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  if (!asked?.domain || (await instanceFrozen())) return null;
  const domain = asked.domain;
  const host = await requireDeploHost();
  // A tunnel serves one name: a recovery onto any other turns it off.
  const tunnel = await loadPanelTunnel();
  const keepsTunnel = tunnel?.hostname === domain;
  // Right after a restart, the host's agent is still on its way back.
  await waitForLink(host.id, LINK_SETTLE_MS);

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  const url = await withTraefikStackLock(host.id, async () => {
    const yaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
    const current = yaml ? panelRoute(yaml) : null;
    // Asked of a panel Deplo does not route: nothing will ever make this move.
    if (!current) return null;
    const https = keepsTunnel || (asked.https ?? current.https);
    const next: PanelRoute = {
      ...current,
      domain,
      https,
      certResolver:
        https && !keepsTunnel
          ? (current.certResolver ?? stackCertResolver(yaml))
          : null,
    };
    const url = `${https ? "https" : "http"}://${domain}`;
    await whilePanelAddressesChange({ url }, async () => {
      await applyPanelRoute(
        host.id,
        tunnel && !keepsTunnel ? withPanelTunnel(yaml, null) : yaml,
        next,
        "The proxy on this server refused the new panel address",
      );
      await rememberPanelUrl(url);
    });
    return url;
  });
  const dropsTunnel = !!url && !!tunnel && !keepsTunnel;

  const now = nowIso();
  const set = {
    panelMoveDomain: null,
    panelMoveHttps: null,
    updatedAt: now,
    ...(url && isPanelFallbackHost(domain)
      ? { panelFallbackDisabled: false }
      : {}),
    ...(dropsTunnel
      ? {
          panelTunnelHostname: null,
          panelTunnelAccountId: null,
          panelTunnelZoneId: null,
          panelTunnelId: null,
          panelTunnelDnsRecordId: null,
          panelTunnelApiTokenEnc: null,
        }
      : {}),
  };
  await getDb()
    .update(instanceSettings)
    .set(set)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  if (!url) {
    console.error(
      `[deplo] deplo recover asked to move the panel to ${domain}, but ${host.name} does not publish it through a route Deplo manages.`,
    );
    return null;
  }
  const left =
    dropsTunnel && tunnel ? await retirePanelTunnel(tunnel, null) : null;
  await recordActivity(
    "instance",
    `Moved the panel to ${url}, as deplo recover asked` +
      (dropsTunnel ? ", and turned off its Cloudflare Tunnel" : "") +
      (left ? ` (${left})` : ""),
    "Deplo",
  );
  return url;
}

export async function moveWithRollback(opts: {
  from: PanelRoute;
  to: PanelRoute;
  apply: (route: PanelRoute) => Promise<void>;
  probe: () => Promise<PanelReachability>;
}): Promise<void> {
  await opts.apply(opts.to);
  const reached = await opts.probe();
  if (reached.ok) return;
  await opts.apply(opts.from);
  throw new Error(
    `${reached.error}. The panel is still on ${opts.from.domain}.`,
  );
}
