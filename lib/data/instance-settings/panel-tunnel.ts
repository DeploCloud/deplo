import "server-only";

import { randomBytes } from "node:crypto";

import { getCurrentUser } from "../../auth/current-user";
import * as cloudflare from "../../cloudflare/tunnel-api";
import { decryptSecretOrThrow, encryptSecret } from "../../crypto";
import {
  panelTunnelIngress,
  withPanelTunnel,
} from "../../deploy/panel-tunnel-stack";
import {
  stackCertResolver,
  withPanelRoute,
  type PanelRoute,
} from "../../deploy/traefik-stack";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { recordActivity } from "../activity";
import { whilePanelAddressesChange } from "../servers/link-addresses";
import { normalizePanelUrl, panelTargets } from "./panel-address";
import {
  passkeyLossSuffix,
  passkeysBoundToThisAddress,
} from "./panel-address-impact";
import {
  forgetRoutedFallback,
  panelFallbackUrl,
  rememberRoutedFallback,
} from "./panel-fallback";
import { probePanel, type PanelReachability } from "./panel-probe";
import {
  NO_DEPLO_HOST,
  currentPanelRoute,
  panelBackupDomain,
  requireDeploHost,
} from "./panel-route";
import {
  loadPanelTunnel,
  retirePanelTunnel,
  savePanelTunnel,
  type StoredPanelTunnel,
} from "./panel-tunnel-store";
import {
  deploHostServer,
  instancePublicBaseUrl,
  loadSettings,
  reachableHostIp,
  rememberPanelUrl,
} from "./settings-store";

// https://deplo.build/docs/operations/cloudflare-tunnel

export type PanelTunnel = {
  enabled: boolean;
  hostname: string | null;
  status: cloudflare.TunnelHealth["status"] | null;
  connections: number;
  /** Why Cloudflare could not say how the tunnel is doing. */
  error: string | null;
  /** Why a tunnel cannot be turned on here. */
  unavailable: string | null;
  /** Where turning the tunnel off moves the panel unless told otherwise. */
  backupUrl: string | null;
  /** Something the change could not finish, which the admin has to know about. */
  warning: string | null;
};

const NO_PROXY =
  "Deplo did not install the proxy on this server, so it cannot run a tunnel here.";
const CONNECT_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const POLL_MS = 2_000;

type Timing = {
  pollMs: number;
  connectMs: number;
  probeMs: number;
  probe: (url: string) => Promise<PanelReachability>;
};
const DEFAULT_TIMING: Timing = {
  pollMs: POLL_MS,
  connectMs: CONNECT_TIMEOUT_MS,
  probeMs: PROBE_TIMEOUT_MS,
  probe: probePanel,
};
const timing: Timing = { ...DEFAULT_TIMING };

export function __setPanelTunnelTimingForTest(next?: Partial<Timing>): void {
  Object.assign(timing, DEFAULT_TIMING, next);
}

export async function getPanelTunnel(): Promise<PanelTunnel> {
  await requireInstanceAdmin();
  return readPanelTunnel();
}

async function readPanelTunnel(
  warning: string | null = null,
): Promise<PanelTunnel> {
  const stored = await loadPanelTunnel();
  const base: PanelTunnel = {
    enabled: !!stored,
    hostname: stored?.hostname ?? null,
    status: null,
    connections: 0,
    error: null,
    unavailable: null,
    backupUrl: await backupAddress(await instancePublicBaseUrl()),
    warning,
  };
  if (!stored) return { ...base, unavailable: await tunnelUnavailable() };
  try {
    const token = decryptSecretOrThrow(
      stored.apiTokenEnc,
      "the Cloudflare API token",
    );
    const health = await cloudflare.tunnelHealth(
      token,
      stored.accountId,
      stored.tunnelId,
    );
    return { ...base, status: health.status, connections: health.connections };
  } catch (e) {
    return { ...base, status: "unknown", error: messageOf(e) };
  }
}

async function tunnelUnavailable(): Promise<string | null> {
  const host = await deploHostServer();
  if (!host) return NO_DEPLO_HOST;
  try {
    const { fetchHostInfo } = await import("../../infra/agent-client/host-ops");
    return (await fetchHostInfo(host.id)).traefikComposeYaml ? null : NO_PROXY;
  } catch (e) {
    return messageOf(e);
  }
}

/** Serves the panel at `https://<hostname>` through a Cloudflare Tunnel Deplo creates, or moves the one it has. */
export async function setPanelTunnel(input: {
  hostname: string;
  apiToken?: string | null;
}): Promise<PanelTunnel> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const hostname = new URL(normalizePanelUrl(input.hostname)).hostname;
  const url = `https://${hostname}`;
  const stored = await loadPanelTunnel();
  const token =
    input.apiToken?.trim() ||
    (stored
      ? decryptSecretOrThrow(
          stored.apiTokenEnc,
          "the saved Cloudflare API token",
        )
      : "");
  if (!token) throw new Error("Paste a Cloudflare API token");
  const host = await requireDeploHost();

  const zone = await cloudflare.findZone(token, hostname);
  const reuse = stored && stored.accountId === zone.accountId ? stored : null;
  const previousUrl = await instancePublicBaseUrl();
  const lostPasskeys =
    new URL(previousUrl).host !== hostname ||
    !previousUrl.startsWith("https://")
      ? await passkeysBoundToThisAddress()
      : 0;
  const ownAddresses = await panelTargets(reachableHostIp(host));

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  // Undone inside the lock, so no other change to the proxy lands between a step and its undo.
  const saved = await withTraefikStackLock(host.id, async () => {
    const undo: (() => Promise<unknown>)[] = [];
    try {
      const yaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
      if (!yaml) throw new Error(NO_PROXY);
      const current = await currentPanelRoute(yaml);

      const tunnelId =
        reuse?.tunnelId ??
        (await cloudflare.createTunnel(
          token,
          zone.accountId,
          tunnelName(hostname),
        ));
      if (!reuse)
        undo.push(() =>
          cloudflare.deleteTunnel(token, zone.accountId, tunnelId),
        );
      else if (reuse.hostname !== hostname)
        undo.push(() =>
          cloudflare.setTunnelIngress(
            token,
            zone.accountId,
            tunnelId,
            panelTunnelIngress(reuse.hostname, current.target),
          ),
        );
      await cloudflare.setTunnelIngress(
        token,
        zone.accountId,
        tunnelId,
        panelTunnelIngress(hostname, current.target),
      );

      const record = await cloudflare.pointAtTunnel(
        token,
        zone.id,
        hostname,
        tunnelId,
        (r) =>
          (r.type === "A" && ownAddresses.v4.includes(r.content)) ||
          (r.type === "AAAA" && ownAddresses.v6.includes(r.content)) ||
          (r.type === "CNAME" &&
            !!stored &&
            r.content.toLowerCase() ===
              `${stored.tunnelId}${cloudflare.TUNNEL_TARGET_SUFFIX}`),
      );
      if (record.created)
        undo.push(async () => {
          await cloudflare.deleteDnsRecord(token, zone.id, record.id);
          await cloudflare.restoreDnsRecords(token, zone.id, record.replaced);
        });

      const connector = await cloudflare.tunnelToken(
        token,
        zone.accountId,
        tunnelId,
      );
      // Cloudflare serves the certificate: a resolver here would only fail its challenge, for ever.
      const next: PanelRoute = {
        ...current,
        domain: hostname,
        fallbackDomain: await panelBackupDomain(current),
        https: true,
        certResolver: null,
      };
      const tunnel: StoredPanelTunnel = {
        hostname,
        accountId: zone.accountId,
        zoneId: zone.id,
        tunnelId,
        dnsRecordId: record.id,
        apiTokenEnc: encryptSecret(token),
      };

      await whilePanelAddressesChange({ url }, async () => {
        await applyStack(
          host.id,
          withPanelTunnel(withPanelRoute(yaml, next), connector),
        );
        rememberRoutedFallback(next.fallbackDomain);
        undo.push(async () => {
          await applyStack(host.id, yaml);
          rememberRoutedFallback(current.fallbackDomain);
        });
        await waitUntilConnected(token, zone.accountId, tunnelId);
        const reached = await probeThroughTunnel(url);
        if (!reached.ok)
          throw new Error(
            `${reached.error}. The panel is still on ${previousUrl}.`,
          );
        await savePanelTunnel(tunnel);
        undo.push(() => savePanelTunnel(stored));
        await rememberPanelUrl(url);
      });
      return tunnel;
    } catch (e) {
      for (const step of undo.reverse()) await step().catch(() => {});
      throw e;
    }
  });

  const warning = stored ? await retirePanelTunnel(stored, saved) : null;
  await recordActivity(
    "instance",
    (stored
      ? `Moved the panel's Cloudflare Tunnel to ${url}`
      : `Served the panel through a Cloudflare Tunnel at ${url}`) +
      passkeyLossSuffix(lostPasskeys) +
      (warning ? ` (${warning})` : ""),
    user.name,
    null,
    teamId,
  );
  return readPanelTunnel(warning);
}

/** Turns the tunnel off: the panel moves to `input`, or to its backup address, and Cloudflare forgets the tunnel. */
export async function disablePanelTunnel(
  input?: string | null,
): Promise<PanelTunnel> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const stored = await loadPanelTunnel();
  if (!stored)
    throw new Error("The panel is not served through a Cloudflare Tunnel");
  const host = await requireDeploHost();
  const previousUrl = await instancePublicBaseUrl();
  const target = input?.trim()
    ? normalizePanelUrl(input)
    : await backupAddress(previousUrl);
  if (!target)
    throw new Error("Give the panel another address to move to first");
  const parsed = new URL(target);
  if (parsed.hostname === stored.hostname)
    throw new Error(
      `${stored.hostname} only reaches the panel through the tunnel. Pick another address.`,
    );
  const lostPasskeys = await passkeysBoundToThisAddress();

  const { fetchHostInfo, withTraefikStackLock } =
    await import("../../infra/agent-client/host-ops");
  await withTraefikStackLock(host.id, async () => {
    const yaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
    if (!yaml) throw new Error(NO_PROXY);
    const current = await currentPanelRoute(yaml);
    const https = parsed.protocol === "https:";
    const next: PanelRoute = {
      ...current,
      domain: parsed.hostname,
      fallbackDomain: await panelBackupDomain(current),
      https,
      certResolver: https ? stackCertResolver(yaml) : null,
    };
    await whilePanelAddressesChange({ url: target }, async () => {
      await applyStack(
        host.id,
        withPanelTunnel(withPanelRoute(yaml, next), null),
      );
      rememberRoutedFallback(next.fallbackDomain);
      const reached = await probeUntilAnswers(target);
      if (!reached.ok) {
        await applyStack(host.id, yaml).catch(() => {});
        rememberRoutedFallback(current.fallbackDomain);
        throw new Error(
          `${reached.error}. The panel is still on ${previousUrl}.`,
        );
      }
      await savePanelTunnel(null);
      await rememberPanelUrl(target);
    });
  });

  const warning = await retirePanelTunnel(stored, null);
  await recordActivity(
    "instance",
    `Turned off the panel's Cloudflare Tunnel and moved the panel to ${target}` +
      passkeyLossSuffix(lostPasskeys) +
      (warning ? ` (${warning})` : ""),
    user.name,
    null,
    teamId,
  );
  return readPanelTunnel(warning);
}

async function applyStack(hostId: string, composeYaml: string): Promise<void> {
  const { applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  try {
    const res = await applyTraefikConfig(hostId, { composeYaml });
    if (!res.ok)
      throw new Error(
        res.error || "The proxy on this server refused the change",
      );
  } catch (e) {
    forgetRoutedFallback();
    throw e;
  }
}

async function waitUntilConnected(
  token: string,
  accountId: string,
  tunnelId: string,
): Promise<void> {
  const deadline = Date.now() + timing.connectMs;
  for (;;) {
    const health = await cloudflare.tunnelHealth(token, accountId, tunnelId);
    if (health.connections > 0 || health.status === "healthy") return;
    if (Date.now() >= deadline)
      throw new Error(
        "The tunnel did not connect to Cloudflare within a minute. Check that this server can reach the internet",
      );
    await sleep(timing.pollMs);
  }
}

// A record made a moment ago may not resolve here yet; Cloudflare has already said the tunnel is up.
async function probeThroughTunnel(url: string): Promise<PanelReachability> {
  const deadline = Date.now() + timing.probeMs;
  for (;;) {
    const reached = await timing.probe(url);
    if (reached.ok) return reached;
    const unresolved =
      reached.code === "ENOTFOUND" || reached.code === "EAI_AGAIN";
    if (Date.now() >= deadline)
      return unresolved ? { ...reached, ok: true, error: null } : reached;
    await sleep(timing.pollMs);
  }
}

async function probeUntilAnswers(url: string): Promise<PanelReachability> {
  let last = await timing.probe(url);
  for (let attempt = 0; attempt < 2 && !last.ok; attempt++) {
    await sleep(timing.pollMs);
    last = await timing.probe(url);
  }
  return last;
}

async function backupAddress(panelUrl: string): Promise<string | null> {
  if ((await loadSettings()).panelFallbackDisabled) return null;
  return panelFallbackUrl(panelUrl);
}

function tunnelName(hostname: string): string {
  return `deplo-${hostname}-${randomBytes(3).toString("hex")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
