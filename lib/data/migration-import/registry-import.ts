import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { registries as registriesTable } from "../../db/schema/control-plane/integrations";
import { requireActiveTeamId } from "../../membership";
import { sourceClient, type SourceCredential } from "../../migration/source";
import type { RegistryType } from "../../types/integration";
import { addRegistry, dockerConfigKey } from "../registries";
import type { Report } from "./run-report";

const TYPES = new Set<RegistryType>(["ghcr", "dockerhub", "gitlab", "generic"]);

// Registries are the team's, not an app's: every deploy here pulls with all of them.
export async function importRegistries(
  c: SourceCredential,
  report: Report,
): Promise<void> {
  const list = sourceClient(c).listRegistries;
  if (!list) return;
  const stores = await list().catch(() => null);
  if (!stores?.length) return;
  const here = await getDb()
    .select({
      registryUrl: registriesTable.registryUrl,
      username: registriesTable.username,
    })
    .from(registriesTable)
    .where(eq(registriesTable.teamId, await requireActiveTeamId()));
  const keyOf = (r: { registryUrl: string; username: string }) =>
    `${dockerConfigKey(r.registryUrl)}\n${r.username}`;
  const known = new Set(here.map(keyOf));
  for (const r of stores) {
    const entry = {
      sourceKind: "registry",
      sourceName: r.name,
      targetKind: "registry",
    };
    if (known.has(keyOf(r))) {
      await report.add({
        ...entry,
        outcome: "skipped",
        message: `A registry for ${r.registryUrl} with this username is already here.`,
      });
      continue;
    }
    const failed = async (why: string) =>
      report.add({
        ...entry,
        outcome: "manual",
        blocking: true,
        message: `${r.name} (${r.registryUrl}) did not come across: ${why}. Add it under Registries before deploying an app that pulls a private image from it.`,
      });
    if (!r.password) {
      await failed("this token's owner may not see its password on {panel}");
      continue;
    }
    try {
      await addRegistry({
        name: r.name,
        type: TYPES.has(r.type as RegistryType)
          ? (r.type as RegistryType)
          : "generic",
        registryUrl: r.registryUrl,
        username: r.username,
        password: r.password,
      });
      known.add(keyOf(r));
      await report.add({ ...entry, outcome: "created" });
    } catch (e) {
      await failed(e instanceof Error ? e.message : "refused");
    }
  }
}
