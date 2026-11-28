import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { LOGO_IMAGE_TYPES } from "../apps/logo-shared";
import { logoVersion, type LogoKind } from "../apps/logo-src";
import { shrinkLogo } from "../apps/logo-shrink";
import { narrowedScope } from "../auth/request-context";
import { getDb } from "../db/client";
import { apps } from "../db/schema/control-plane/apps";
import { databases } from "../db/schema/control-plane/databases";
import { reachesWholeTeam, requireActiveTeamId } from "../membership";
import { appInTeam } from "./app-graph-load";
import { appCapabilities } from "./node-access";

export interface LogoImage {
  bytes: Buffer;
  type: string;
  version: string;
}

const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/;

/** The team that owns the App or database, so the logo loads in a tab open on another team. */
export async function logoTeamId(
  kind: LogoKind,
  id: string,
): Promise<string | null> {
  const table = kind === "app" ? apps : databases;
  const [row] = await getDb()
    .select({ teamId: table.teamId })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return row?.teamId ?? null;
}

// Same answer for "no such logo" and "not yours", as the pages give.
export async function readLogoImage(
  kind: LogoKind,
  id: string,
): Promise<LogoImage | null> {
  const teamId = await requireActiveTeamId();
  let logo: string | null | undefined;
  if (kind === "app") {
    if (!(await appInTeam(id, teamId))) return null;
    if ((await appCapabilities(id)).length === 0) return null;
    [{ logo } = { logo: null }] = await getDb()
      .select({ logo: apps.logo })
      .from(apps)
      .where(and(eq(apps.id, id), eq(apps.teamId, teamId)))
      .limit(1);
  } else {
    if (narrowedScope() || !(await reachesWholeTeam())) return null;
    [{ logo } = { logo: null }] = await getDb()
      .select({ logo: databases.logo })
      .from(databases)
      .where(and(eq(databases.id, id), eq(databases.teamId, teamId)))
      .limit(1);
  }
  return logo ? decodeLogo(logo) : null;
}

export function decodeLogo(logo: string): LogoImage | null {
  const m = DATA_URI.exec(logo);
  if (!m || !(LOGO_IMAGE_TYPES as readonly string[]).includes(m[1]!))
    return null;
  return {
    bytes: Buffer.from(m[2]!, "base64"),
    type: m[1]!,
    version: logoVersion(logo),
  };
}

// Logos stored before they were shrunk on save; a shrunk one is well under this.
const SWEEP_MIN_CHARS = 6_000;

/** Shrinks the logos saved before shrinking existed, one at a time; a logo edited meanwhile is left as it is. */
export async function shrinkStoredLogos(): Promise<number> {
  let shrunk = 0;
  for (const table of [apps, databases]) {
    const rows = await getDb()
      .select({ id: table.id, logo: table.logo })
      .from(table)
      .where(
        and(
          sql`${table.logo} like 'data:%'`,
          sql`length(${table.logo}) > ${SWEEP_MIN_CHARS}`,
        ),
      );
    for (const row of rows) {
      const next = await shrinkLogo(row.logo!);
      if (next === row.logo) continue;
      const done = await getDb()
        .update(table)
        .set({ logo: next })
        .where(and(eq(table.id, row.id), eq(table.logo, row.logo!)))
        .returning({ id: table.id });
      shrunk += done.length;
    }
  }
  return shrunk;
}
