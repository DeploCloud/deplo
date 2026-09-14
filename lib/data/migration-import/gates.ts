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
  // Read the panel as this product. Absent means: work out which it is.
  kind?: MigrationPlatform;
}

// assertImportGate - the entry gate for every import write.
export async function assertImportGate(): Promise<{ teamId: string }> {
  await requireTeamWide("import from another platform");
  const { teamId } = await requireCapability("create_projects");
  return { teamId };
}

// assertPanelReadGate - the gate for what touches no team's data: reading the
// panel and taking the wizard's agents back are an admin's, whatever their role
// in the team the page happens to be open in. Landing in a team keeps the gate above.
export async function assertPanelReadGate(): Promise<{ teamId: string }> {
  if (await isInstanceAdmin()) return { teamId: await requireActiveTeamId() };
  return assertImportGate();
}

// listMigrationTargetTeams - the teams a migration may land in: the same bar this
// page is gated on, so switching into one never lands on "outside your access".
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

// credentialFor - the typed address + key as a credential, refusing an address
// Deplo must not dial. The private-address escape hatch asserts instance admin AT
// the decision, never inherits it from a caller.
export async function credentialFor(
  input: ConnectInput,
): Promise<SourceCredential> {
  const baseUrl = normalizeSourceBaseUrl(input.url);
  // The address says whether this is the same-machine / LAN case, so nobody has to
  // declare it: private means instance admin, like a git connection's flag.
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
  // The SSRF gate is above, so the detection's own request is behind it too.
  const kind = input.kind ?? (await detectMigrationSource(baseUrl, apiKey));
  return { kind, baseUrl, apiKey };
}
