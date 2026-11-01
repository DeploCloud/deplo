import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { assertUser } from "../../auth/current-user";
import { requirePersonalSession } from "../../auth/request-context";
import * as cloudflare from "../../cloudflare/tunnel-api";
import { encryptSecret } from "../../crypto";
import { getDb } from "../../db/client";
import {
  dnsProviders,
  dnsProviderTeams,
} from "../../db/schema/control-plane/dns-providers";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { newId, nowIso } from "../../ids";
import { teamsWhereUserHolds } from "../../membership";
import { recordActivity } from "../activity";
import { retireProviderTunnels } from "./tunnels";

export type DnsProviderKind = "cloudflare";
export const DNS_PROVIDERS: readonly DnsProviderKind[] = ["cloudflare"];

export interface DnsProviderTeam {
  id: string;
  name: string;
  slug: string;
}

export interface DnsProviderView {
  id: string;
  provider: DnsProviderKind;
  zoneName: string;
  shared: boolean;
  teams: DnsProviderTeam[];
  createdAt: string;
}

export interface DnsProviderCheck {
  zoneName: string;
  tunnels: boolean;
}

/** The teams this person may point a provider at: where they can manage domains. */
export async function dnsProviderTeamChoices(): Promise<DnsProviderTeam[]> {
  const user = await assertUser();
  const ids = [...(await teamsWhereUserHolds(user.id, "manage_domains"))];
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
    })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMyDnsProviders(): Promise<DnsProviderView[]> {
  const user = await assertUser();
  const rows = await getDb()
    .select({
      id: dnsProviders.id,
      provider: dnsProviders.provider,
      zoneName: dnsProviders.zoneName,
      shared: dnsProviders.shared,
      createdAt: dnsProviders.createdAt,
    })
    .from(dnsProviders)
    .where(eq(dnsProviders.userId, user.id));
  if (rows.length === 0) return [];
  const links = await getDb()
    .select({
      providerId: dnsProviderTeams.providerId,
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
    })
    .from(dnsProviderTeams)
    .innerJoin(teamsTable, eq(teamsTable.id, dnsProviderTeams.teamId))
    .where(
      inArray(
        dnsProviderTeams.providerId,
        rows.map((r) => r.id),
      ),
    );
  return rows
    .map((r) => ({
      ...r,
      provider: r.provider as DnsProviderKind,
      teams: links
        .filter((l) => l.providerId === r.id)
        .map(({ id, name, slug }) => ({ id, name, slug }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.zoneName.localeCompare(b.zoneName));
}

// A DNS provider holds a person's own Cloudflare key: only they, signed in, connect or change one.
async function assertSignedIn(): Promise<
  Awaited<ReturnType<typeof assertUser>>
> {
  requirePersonalSession("DNS providers");
  return assertUser();
}

export function cleanZoneName(raw: string): string {
  const zone = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(zone))
    throw new Error("Enter a domain, like example.com");
  return zone;
}

async function resolveZone(
  provider: DnsProviderKind,
  rawZone: string,
  apiToken: string,
): Promise<cloudflare.CloudflareZone & { tunnels: boolean }> {
  if (provider !== "cloudflare") throw new Error("Unknown DNS provider");
  const token = apiToken.trim();
  if (!token) throw new Error("Paste a Cloudflare API token");
  const name = cleanZoneName(rawZone);
  const zone = await cloudflare.findZone(token, name);
  if (zone.name !== name)
    throw new Error(
      `${name} is part of ${zone.name} in Cloudflare. Connect ${zone.name} instead.`,
    );
  await cloudflare.assertDnsAccess(token, zone.id);
  const tunnels = await cloudflare.canManageTunnels(token, zone.accountId);
  return { ...zone, tunnels };
}

/** Checks the token reaches the domain in Cloudflare, without saving anything. */
export async function checkDnsProvider(input: {
  provider: DnsProviderKind;
  zone: string;
  apiToken: string;
}): Promise<DnsProviderCheck> {
  await assertSignedIn();
  const zone = await resolveZone(input.provider, input.zone, input.apiToken);
  return { zoneName: zone.name, tunnels: zone.tunnels };
}

async function assertTeamsAllowed(
  userId: string,
  teamIds: string[],
): Promise<string[]> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) throw new Error("Pick at least one team");
  const allowed = await teamsWhereUserHolds(userId, "manage_domains");
  if (unique.some((id) => !allowed.has(id)))
    throw new Error("You can only pick teams where you manage domains");
  return unique;
}

export async function saveDnsProvider(input: {
  provider: DnsProviderKind;
  zone: string;
  apiToken: string;
  teamIds: string[];
  shared: boolean;
}): Promise<DnsProviderView> {
  const user = await assertSignedIn();
  const teamIds = await assertTeamsAllowed(user.id, input.teamIds);
  const zone = await resolveZone(input.provider, input.zone, input.apiToken);

  const [existing] = await getDb()
    .select({ id: dnsProviders.id })
    .from(dnsProviders)
    .where(
      and(
        eq(dnsProviders.userId, user.id),
        eq(dnsProviders.zoneName, zone.name),
      ),
    );
  const id = existing?.id ?? newId("dnsp");
  const now = nowIso();
  await getDb().transaction(async (tx) => {
    if (existing)
      await tx
        .update(dnsProviders)
        .set({
          zoneId: zone.id,
          accountId: zone.accountId,
          apiTokenEnc: encryptSecret(input.apiToken.trim()),
          shared: input.shared,
          updatedAt: now,
        })
        .where(eq(dnsProviders.id, id));
    else
      await tx.insert(dnsProviders).values({
        id,
        userId: user.id,
        provider: input.provider,
        zoneName: zone.name,
        zoneId: zone.id,
        accountId: zone.accountId,
        apiTokenEnc: encryptSecret(input.apiToken.trim()),
        shared: input.shared,
        createdAt: now,
        updatedAt: now,
      });
    await tx
      .delete(dnsProviderTeams)
      .where(eq(dnsProviderTeams.providerId, id));
    await tx
      .insert(dnsProviderTeams)
      .values(teamIds.map((teamId) => ({ providerId: id, teamId })));
  });

  for (const teamId of teamIds)
    await recordActivity(
      "integration",
      `Connected ${zone.name} from Cloudflare for automatic DNS` +
        (input.shared ? ", for everyone in this team" : ""),
      user.name,
      null,
      teamId,
    );
  return (await listMyDnsProviders()).find((p) => p.id === id)!;
}

export async function updateDnsProvider(input: {
  id: string;
  teamIds: string[];
  shared: boolean;
}): Promise<DnsProviderView> {
  const user = await assertSignedIn();
  const before = (await listMyDnsProviders()).find((p) => p.id === input.id);
  if (!before) throw new Error("DNS provider not found");
  // A team you no longer manage domains in may stay on the list, but never be added.
  const kept = before.teams.map((t) => t.id);
  const added = input.teamIds.filter((id) => !kept.includes(id));
  if (added.length > 0) await assertTeamsAllowed(user.id, added);
  const teamIds = [...new Set(input.teamIds)];
  if (teamIds.length === 0) throw new Error("Pick at least one team");

  await getDb().transaction(async (tx) => {
    await tx
      .update(dnsProviders)
      .set({ shared: input.shared, updatedAt: nowIso() })
      .where(
        and(eq(dnsProviders.id, input.id), eq(dnsProviders.userId, user.id)),
      );
    await tx
      .delete(dnsProviderTeams)
      .where(eq(dnsProviderTeams.providerId, input.id));
    await tx
      .insert(dnsProviderTeams)
      .values(teamIds.map((teamId) => ({ providerId: input.id, teamId })));
  });

  const touched = new Set([...kept, ...teamIds]);
  for (const teamId of touched) {
    const now = teamIds.includes(teamId);
    const was = kept.includes(teamId);
    const message = !now
      ? `Stopped automatic DNS for ${before.zoneName} in this team`
      : !was
        ? `Turned on automatic DNS for ${before.zoneName} in this team`
        : before.shared !== input.shared
          ? input.shared
            ? `Let everyone in this team use automatic DNS for ${before.zoneName}`
            : `Made automatic DNS for ${before.zoneName} private to the person who connected it`
          : null;
    if (message)
      await recordActivity("integration", message, user.name, null, teamId);
  }
  return (await listMyDnsProviders()).find((p) => p.id === input.id)!;
}

/** Disconnects the provider; its tunnels go with it, so domains served through them stop. */
export async function removeDnsProvider(id: string): Promise<string | null> {
  const user = await assertSignedIn();
  const before = (await listMyDnsProviders()).find((p) => p.id === id);
  if (!before) throw new Error("DNS provider not found");
  const warning = await retireProviderTunnels(id);
  await getDb()
    .delete(dnsProviders)
    .where(and(eq(dnsProviders.id, id), eq(dnsProviders.userId, user.id)));
  for (const t of before.teams)
    await recordActivity(
      "integration",
      `Disconnected ${before.zoneName} from automatic DNS` +
        (warning ? ` (${warning})` : ""),
      user.name,
      null,
      t.id,
    );
  return warning;
}
