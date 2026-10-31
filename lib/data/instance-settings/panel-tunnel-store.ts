import "server-only";

import { eq } from "drizzle-orm";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { decryptSecretOrThrow } from "../../crypto";
import { getDb } from "../../db/client";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { nowIso } from "../../ids";

const SETTINGS_ID = "default";

export const TUNNEL_SERVES_PANEL =
  "The panel is served through a Cloudflare Tunnel. Change or turn it off under Advanced, Panel access.";

export type StoredPanelTunnel = {
  hostname: string;
  accountId: string;
  zoneId: string;
  tunnelId: string;
  dnsRecordId: string | null;
  apiTokenEnc: string;
};

export async function loadPanelTunnel(): Promise<StoredPanelTunnel | null> {
  const [row] = await getDb()
    .select({
      hostname: instanceSettings.panelTunnelHostname,
      accountId: instanceSettings.panelTunnelAccountId,
      zoneId: instanceSettings.panelTunnelZoneId,
      tunnelId: instanceSettings.panelTunnelId,
      dnsRecordId: instanceSettings.panelTunnelDnsRecordId,
      apiTokenEnc: instanceSettings.panelTunnelApiTokenEnc,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  if (
    !row?.hostname ||
    !row.accountId ||
    !row.zoneId ||
    !row.tunnelId ||
    !row.apiTokenEnc
  )
    return null;
  return {
    hostname: row.hostname,
    accountId: row.accountId,
    zoneId: row.zoneId,
    tunnelId: row.tunnelId,
    dnsRecordId: row.dnsRecordId,
    apiTokenEnc: row.apiTokenEnc,
  };
}

export async function panelTunnelHostname(): Promise<string | null> {
  return (await loadPanelTunnel())?.hostname ?? null;
}

export async function savePanelTunnel(
  tunnel: StoredPanelTunnel | null,
): Promise<void> {
  const set = {
    panelTunnelHostname: tunnel?.hostname ?? null,
    panelTunnelAccountId: tunnel?.accountId ?? null,
    panelTunnelZoneId: tunnel?.zoneId ?? null,
    panelTunnelId: tunnel?.tunnelId ?? null,
    panelTunnelDnsRecordId: tunnel?.dnsRecordId ?? null,
    panelTunnelApiTokenEnc: tunnel?.apiTokenEnc ?? null,
    updatedAt: nowIso(),
  };
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ...set })
    .onConflictDoUpdate({ target: instanceSettings.id, set });
}

// What the old tunnel left behind in Cloudflare once the panel no longer needs it; best effort.
export async function retirePanelTunnel(
  old: StoredPanelTunnel,
  now: StoredPanelTunnel | null,
): Promise<string | null> {
  try {
    const token = decryptSecretOrThrow(
      old.apiTokenEnc,
      "the old Cloudflare API token",
    );
    if (old.dnsRecordId && old.dnsRecordId !== now?.dnsRecordId)
      await cloudflare.deleteDnsRecord(token, old.zoneId, old.dnsRecordId);
    if (old.tunnelId !== now?.tunnelId)
      await cloudflare.deleteTunnel(token, old.accountId, old.tunnelId);
    return null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return `Cloudflare still has the old tunnel for ${old.hostname}: ${reason}. Delete it there.`;
  }
}
