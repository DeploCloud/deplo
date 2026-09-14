import "server-only";

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
import { panelFallbackHost } from "../../deploy/domains";
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
import {
  panelCertificateTrusted,
  probePanel,
  probeUntilAnswers,
  type PanelReachability,
} from "./panel-probe";

const NO_DEPLO_HOST =
  "The server running Deplo is not added here yet, so Deplo does not manage the panel's own address.";
const ROUTE_REFUSED = "The proxy on this server refused the change";

// Whether the panel is served over https, as the host's proxy is actually configured.
export type PanelHttps = {
  // The host the panel's route answers on. Null when there is no route of ours.
  domain: string | null;
  // The generated host it also answers on, or null when it is already the one above.
  fallbackDomain: string | null;
  enabled: boolean;
  // Whether a browser accepts the certificate that address serves. False on the
  // generated host, which no public CA issues for. Null when it could not be read.
  certificateTrusted: boolean | null;
  // The resolver its certificate is ordered from, named as this host names it.
  // Null when https is off, or when the host orders from nobody.
  provider: string | null;
  // Why this is not Deplo's to change, verbatim for the operator. Null when it is.
  unavailable: string | null;
};

async function requireDeploHost() {
  const host = await deploHostServer();
  if (!host) throw new Error(NO_DEPLO_HOST);
  return host;
}

async function currentPanelRoute(yaml: string): Promise<PanelRoute> {
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
  const res = await applyTraefikConfig(hostId, {
    composeYaml: withPanelRoute(currentYaml, next),
  });
  if (!res.ok) throw new Error(res.error || refusal);
}

// Store the address this instance answers on, or clear it (`null`) to fall back to
// `DEPLO_PUBLIC_URL`, and move the panel's own route onto it.
export async function setPanelUrl(
  input: string | null,
): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const url =
    input === null || input.trim() === "" ? null : normalizePanelUrl(input);
  // Read BEFORE the write: `rpId` is derived from the address, so once it has moved
  // there is no way to say how many credentials it just invalidated.
  const current = await instancePublicBaseUrl();
  const lostPasskeys =
    url !== null &&
    (hostOf(url) !== hostOf(current) || schemeOf(url) !== schemeOf(current))
      ? await passkeysBoundToThisAddress()
      : 0;
  // The routing moves FIRST, and this throws if it could not: storing an address
  // nothing routes to would break every install command copied from this page.
  if (url) await movePanelRoute(url);
  await rememberPanelUrl(url);

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

// Read the panel's route off the host that serves it.
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
    return {
      domain: route.domain,
      fallbackDomain: route.fallbackDomain,
      enabled: route.https,
      provider: route.https ? route.certResolver : null,
      certificateTrusted: route.https
        ? await panelCertificateTrusted(await instancePublicBaseUrl())
        : null,
      unavailable: null,
    };
  } catch (e) {
    // An unreachable host is an answer about that host, not a failure of the
    // page - same rule the certificate accounts follow.
    return { ...none, unavailable: e instanceof Error ? e.message : String(e) };
  }
}

export async function getPanelHttps(): Promise<PanelHttps> {
  await requireInstanceAdmin();
  return readPanelHttps();
}

// Serve the panel over https, or over plain http. Skipping this would leave a panel
// that loads and can never be logged into - the failure this setting exists to end.
export async function setPanelHttps(enabled: boolean): Promise<PanelHttps> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const host = await requireDeploHost();

  // Same reason as in setPanelUrl: after the scheme moves, the credentials it
  // invalidated cannot be counted any more. Turning https OFF kills every
  // passkey outright - WebAuthn has no relying party on plain http.
  const lostPasskeys = enabled ? 0 : await passkeysBoundToThisAddress();

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  // Held across the read and the write: this rewrites the host's WHOLE stack
  // file, and so does installing a certificate on it. See withTraefikStackLock.
  const moved = await withTraefikStackLock(host.id, async () => {
    const info = await fetchHostInfo(host.id);
    const current = await currentPanelRoute(info.traefikComposeYaml);
    if (current.https === enabled) return null;

    const next: PanelRoute = {
      ...current,
      fallbackDomain: await panelBackupDomain(current),
      https: enabled,
      // Read off the host rather than assumed, and null is fine: a proxy that
      // orders from nobody still terminates TLS with a certificate the operator
      // installed. Naming a resolver it does not define is what would break it.
      certResolver: enabled ? stackCertResolver(info.traefikComposeYaml) : null,
    };
    await applyPanelRoute(
      host.id,
      info.traefikComposeYaml,
      next,
      ROUTE_REFUSED,
    );
    return next;
  });

  if (moved) {
    await rememberPanelUrl(`${enabled ? "https" : "http"}://${moved.domain}`);
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

// The backup host a route should carry. Seeded here and not only by the installer:
// a panel that WAS the generated host loses it the moment a domain is set.
async function panelBackupDomain(current: PanelRoute): Promise<string | null> {
  if ((await loadSettings()).panelFallbackDisabled) return null;
  return current.fallbackDomain ?? panelFallbackHost();
}

// Turn the generated backup address on or off. Off is the advanced opt-out.
// https://deplo.build/docs/operations/panel-address-and-certificates
export async function setPanelFallback(
  enabled: boolean,
): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const host = await requireDeploHost();

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  // Held across the read and the write, same as setPanelHttps: this rewrites the
  // host's whole stack file.
  await withTraefikStackLock(host.id, async () => {
    const info = await fetchHostInfo(host.id);
    const current = await currentPanelRoute(info.traefikComposeYaml);
    // Turning it off while it IS the address would take the last route away.
    if (!enabled && current.domain === panelFallbackHost())
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

// Build a panel route for a Deplo that does not have one yet: one installed before
// the route was Deplo's to write publishes itself with Traefik LABELS on its own
// container, in a compose file no agent RPC can touch.
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
    // What it is being served as RIGHT NOW, so the caller's own
    // `current.https === enabled` check still means what it says.
    https: url.startsWith("https://"),
    certResolver: url.startsWith("https://")
      ? stackCertResolver(currentYaml)
      : null,
    target: DEFAULT_PANEL_TARGET,
  };
}

// Move the panel's route onto a new address, and put it back if the new one does
// not answer: the new address proves itself from the outside before the old one goes.
async function movePanelRoute(url: string): Promise<void> {
  const host = await deploHostServer();
  if (!host) return;

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  const parsed = new URL(url);
  const domain = parsed.hostname;
  // The scheme in the address is not decoration: typing an http:// address is
  // the same request as turning HTTPS off, and leaving the route on :443 would
  // store an address the panel does not answer on.
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

// Point the route at `to`, and put it back on `from` if the new address does not answer.
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
