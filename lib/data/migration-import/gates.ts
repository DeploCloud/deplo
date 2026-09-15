import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import {
  holdsTeamWideCapability,
  isInstanceAdmin,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
  teamsForUser,
} from "../../membership";
import { assertSafeOutboundUrl } from "../../outbound-url";
import { normalizeSourceBaseUrl } from "../../migration/transport";
import { detectMigrationSource } from "../../migration/detect";
import type {
  MigrationPlatform,
  SourceCredential,
} from "../../migration/source";

export interface ConnectInput {
  url: string;
  apiKey: string;
  kind?: MigrationPlatform;
}

export async function assertImportGate(): Promise<{ teamId: string }> {
  await requireTeamWide("import from another platform");
  const { teamId } = await requireCapability("create_projects");
  return { teamId };
}

export async function assertPanelReadGate(): Promise<{ teamId: string }> {
  if (await isInstanceAdmin()) return { teamId: await requireActiveTeamId() };
  return assertImportGate();
}

export async function listMigrationTargetTeams(): Promise<
  { id: string; name: string; avatarUrl: string | null }[]
> {
  const user = await getCurrentUser();
  if (!user) return [];
  const teams = await teamsForUser(user.id);
  const allowed = await Promise.all(
    teams.map((t) => holdsTeamWideCapability(t.id, "create_projects")),
  );
  return teams
    .filter((_, i) => allowed[i])
    .map((t) => ({ id: t.id, name: t.name, avatarUrl: t.avatarUrl }));
}

export async function credentialFor(
  input: ConnectInput,
): Promise<SourceCredential> {
  const baseUrl = normalizeSourceBaseUrl(input.url);
  try {
    await assertSafeOutboundUrl(baseUrl, "The panel address", {
      allowHttp: true,
    });
  } catch {
    await requireInstanceAdmin().catch(() => {
      throw new Error(
        "Only an instance admin can point Deplo at a private address",
      );
    });
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Paste the panel's API key");
  const kind = input.kind ?? (await detectMigrationSource(baseUrl, apiKey));
  return { kind, baseUrl, apiKey };
}
