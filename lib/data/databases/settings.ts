import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability, requireMountHostVolumes } from "../../membership";
import { recordActivity } from "../activity";
import { isValidLogoValue } from "../../apps/logo-shared";
import {
  cleanResourceLimits,
  type ResourceLimitsInput,
} from "../apps/resources";
import { resourceLimitsToRow } from "../app-graph-rows/resource-limits";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import {
  cleanDatabaseName,
  isDuplicateNameError,
  isValidImageRef,
} from "./validate";
import { loadDatabase, requireDatabase } from "./rows";

export async function renameDatabase(id: string, name: string): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const clean = cleanDatabaseName(name);
  const cur = await requireDatabase(id, teamId);
  if (cur.name === clean) return;

  const taken = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(eq(databasesTable.teamId, teamId), eq(databasesTable.name, clean)),
    )
    .limit(1);
  if (taken.length > 0)
    throw new Error(`A database named "${clean}" already exists in this team.`);

  try {
    await getDb()
      .update(databasesTable)
      .set({ name: clean })
      .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)));
  } catch (e) {
    if (isDuplicateNameError(e))
      throw new Error(
        `A database named "${clean}" already exists in this team.`,
      );
    throw e;
  }
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    `Renamed database ${cur.name} to ${clean}`,
    user.name,
    null,
    teamId,
    null,
    id,
  );
}

export async function updateDatabaseLogo(
  id: string,
  logo: string | null,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  const next = logo?.trim() ? logo.trim() : null;
  if (next && !isValidLogoValue(next))
    throw new Error("Unsupported logo image");

  const updated = await getDb()
    .update(databasesTable)
    .set({ logo: next })
    .where(
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
        next === null
          ? sql`${databasesTable.logo} is not null`
          : sql`${databasesTable.logo} is distinct from ${next}`,
      ),
    )
    .returning({ id: databasesTable.id, name: databasesTable.name });
  if (updated.length === 0) {
    const exists = await loadDatabase(id, membership.teamId);
    if (!exists) throw new Error("Not found");
    return;
  }
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    next
      ? `Updated the logo of ${updated[0].name}`
      : `Removed the logo of ${updated[0].name}`,
    user.name,
    null,
    membership.teamId,
    null,
    id,
  );
}

export async function updateDatabaseResources(
  id: string,
  input: ResourceLimitsInput,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  const cleaned = cleanResourceLimits(input);
  if (cleaned.oomScoreAdj != null && cleaned.oomScoreAdj < 0) {
    await requireMountHostVolumes();
  }
  const updated = await getDb()
    .update(databasesTable)
    .set(resourceLimitsToRow(cleaned))
    .where(
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
      ),
    )
    .returning({ id: databasesTable.id, name: databasesTable.name });
  if (updated.length === 0) throw new Error("Not found");
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    `Updated the resource limits of ${updated[0].name}`,
    user.name,
    null,
    membership.teamId,
    null,
    id,
  );
}

export async function setDatabaseRestartLoopGuard(
  id: string,
  enabled: boolean,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  const updated = await getDb()
    .update(databasesTable)
    .set({ restartLoopGuard: enabled })
    .where(
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
      ),
    )
    .returning({ name: databasesTable.name });
  if (updated.length === 0) throw new Error("Not found");
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    `${enabled ? "Turned on" : "Turned off"} restart loop protection for ${updated[0].name}`,
    user.name,
    null,
    membership.teamId,
    null,
    id,
  );
}

export async function updateDatabaseImage(
  id: string,
  input: {
    customImage?: string | null;
    customCommand?: string | null;
    version?: string;
  },
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;

  const patch: Partial<typeof databasesTable.$inferInsert> = {};
  if (input.customImage !== undefined) {
    const img = input.customImage?.trim() || null;
    if (img && !isValidImageRef(img))
      throw new Error(
        "Custom image must be a plain image reference (repo[:tag] or repo@digest) with no spaces or quotes.",
      );
    patch.customImage = img;
  }
  if (input.customCommand !== undefined) {
    const cmd = input.customCommand?.trim() || null;
    if (cmd && /[\r\n\t]/.test(cmd))
      throw new Error("Custom command must be a single line.");
    patch.customCommand = cmd;
  }
  if (input.version !== undefined) {
    const v = input.version.trim();
    if (!v || !/^[A-Za-z0-9._-]+$/.test(v))
      throw new Error("Version must be a valid image tag.");
    patch.version = v;
  }
  if (Object.keys(patch).length === 0) return;

  const updated = await getDb()
    .update(databasesTable)
    .set(patch)
    .where(
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
      ),
    )
    .returning({ id: databasesTable.id, name: databasesTable.name });
  if (updated.length === 0) throw new Error("Not found");
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    `Updated the image settings of ${updated[0].name}`,
    user.name,
    null,
    membership.teamId,
    null,
    id,
  );
}
