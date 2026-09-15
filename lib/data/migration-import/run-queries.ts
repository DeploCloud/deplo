import "server-only";

import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import {
  migrationRunItems as itemsTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import { nowIso } from "../../ids";
import { getCurrentUser } from "../../auth/current-user";
import {
  avatarResolver,
  teamAvatarUrl as deploTeamAvatarUrl,
} from "../../avatar";
import {
  requireActiveTeamId,
  requireInstanceAdmin,
  teamsForUser,
} from "../../membership";
import { isMigrationPlatform } from "../../migration/source";
import type { MigrationPlatform } from "../../migration/source";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { assertImportGate } from "./gates";
import type { ImportItemDTO } from "./run-report";
import { runMembersOf, type MigrationInvite } from "./member-invites";

export interface ImportRunDTO {
  id: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  teamAvatarUrl: string | null;
  platform: MigrationPlatform;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  actorUsername: string | null;
  actorAvatarUrl: string | null;
  actorAvatarColor: string | null;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  phase: string;
  doneSteps: number;
  totalSteps: number;
  stepLabel: string | null;
  stopRequested: boolean;
  heartbeatAt: string | null;
  reportSeenAt: string | null;
  lastPath: string | null;
  sessionId: string | null;
}

export interface MigrationSessionRun extends ImportRunDTO {
  members: MigrationInvite[];
}

export async function resumableMigration(): Promise<ImportRunDTO | null> {
  const teamId = await requireActiveTeamId();
  const user = await getCurrentUser();
  if (!user) return null;
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, teamId),
        isNull(runsTable.reportSeenAt),
        ne(runsTable.status, "queued"),
        or(eq(runsTable.actorUserId, user.id), eq(runsTable.status, "running")),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(1);
  return row ? (await toRunDTOs([row]))[0] : null;
}

export async function resumableMigrationAnywhere(): Promise<ImportRunDTO | null> {
  await requireInstanceAdmin();
  const user = await getCurrentUser();
  if (!user) return null;
  const mine = (await teamsForUser(user.id)).map((t) => t.id);
  if (mine.length === 0) return null;
  const [row] = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        inArray(runsTable.teamId, mine),
        isNull(runsTable.reportSeenAt),
        ne(runsTable.status, "queued"),
        or(eq(runsTable.actorUserId, user.id), eq(runsTable.status, "running")),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(1);
  return row ? (await toRunDTOs([row]))[0] : null;
}

export async function migrationSessionRuns(
  runId: string,
): Promise<MigrationSessionRun[]> {
  await requireInstanceAdmin();
  const user = await getCurrentUser();
  if (!user) return [];
  const mine = (await teamsForUser(user.id)).map((t) => t.id);
  if (mine.length === 0) return [];
  const [seed] = await getDb()
    .select({ sessionId: runsTable.sessionId })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), inArray(runsTable.teamId, mine)))
    .limit(1);
  if (!seed) return [];
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        inArray(runsTable.teamId, mine),
        seed.sessionId
          ? eq(runsTable.sessionId, seed.sessionId)
          : eq(runsTable.id, runId),
      ),
    )
    .orderBy(asc(runsTable.seq));
  const dtos = await toRunDTOs(rows);
  return Promise.all(
    dtos.map(async (r) => ({ ...r, members: await runMembersOf(r.id) })),
  );
}

export async function cancelQueuedRuns(
  sessionId: string,
  why: string,
): Promise<number> {
  const rows = await getDb()
    .update(runsTable)
    .set({
      status: "stopped",
      error: why,
      finishedAt: nowIso(),
      reportSeenAt: nowIso(),
      apiKeyEnc: null,
      phase: "done",
    })
    .where(
      and(eq(runsTable.sessionId, sessionId), eq(runsTable.status, "queued")),
    )
    .returning({ id: runsTable.id });
  if (rows.length > 0) publishMigrationChanged();
  return rows.length;
}

export async function dismissMigrationReport(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  await getDb()
    .update(runsTable)
    .set({ reportSeenAt: nowIso() })
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)));
  publishMigrationChanged();
}

export async function activeMigrationForTeam(
  teamId: string,
): Promise<ImportRunDTO | null> {
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.teamId, teamId), eq(runsTable.status, "running")));
  if (rows.length === 0) return null;
  const [last] = await getDb()
    .select({ path: itemsTable.path })
    .from(itemsTable)
    .where(eq(itemsTable.runId, rows[0].id))
    .orderBy(desc(itemsTable.seq))
    .limit(1);
  const [dto] = await toRunDTOs([rows[0]]);
  return { ...dto, lastPath: last?.path ?? null };
}

export async function headerMigrationForTeam(
  teamId: string,
): Promise<ImportRunDTO | null> {
  const running = await activeMigrationForTeam(teamId);
  if (running) return running;
  const [finished] = await getDb()
    .select()
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "done"),
        isNull(runsTable.reportSeenAt),
      ),
    )
    .orderBy(desc(runsTable.seq))
    .limit(1);
  return finished ? (await toRunDTOs([finished]))[0] : null;
}

export async function listMigrationRuns(): Promise<ImportRunDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.teamId, teamId), ne(runsTable.status, "queued")));
  return toRunDTOs(newestFirst(rows));
}

export async function listAllMigrationRuns(): Promise<ImportRunDTO[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(ne(runsTable.status, "queued"));
  return toRunDTOs(newestFirst(rows));
}

function newestFirst<T extends { startedAt: string; seq: number }>(
  rows: T[],
): T[] {
  return rows.sort((a, b) =>
    a.startedAt === b.startedAt
      ? b.seq - a.seq
      : a.startedAt < b.startedAt
        ? 1
        : -1,
  );
}

export async function getMigrationRun(
  id: string,
): Promise<(ImportRunDTO & { items: ImportItemDTO[] }) | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(runsTable)
    .where(and(eq(runsTable.id, id), eq(runsTable.teamId, teamId)));
  if (rows.length === 0) return null;
  const items = await getDb()
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.runId, id));
  const [dto] = await toRunDTOs([rows[0]]);
  return {
    ...dto,
    items: items
      .sort((a, b) => a.seq - b.seq)
      .map((i) => ({
        path: i.path,
        sourceKind: i.sourceKind,
        sourceName: i.sourceName,
        sourceId: i.sourceId,
        outcome: i.outcome,
        targetKind: i.targetKind,
        targetId: i.targetId,
        message: i.message,
        at: i.at,
      })),
  };
}

interface ActorFace {
  username: string | null;
  avatarUrl: string | null;
  avatarColor: string | null;
}

async function actorFaces(
  rows: (typeof runsTable.$inferSelect)[],
): Promise<Map<string, ActorFace>> {
  const ids = [
    ...new Set(
      rows.map((r) => r.actorUserId).filter((v): v is string => Boolean(v)),
    ),
  ];
  if (ids.length === 0) return new Map();
  const people = await getDb()
    .select({
      id: usersTable.id,
      username: usersTable.username,
      avatarColor: usersTable.avatarColor,
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  const url = await avatarResolver();
  return new Map(
    people.map((p) => [
      p.id,
      {
        username: p.username,
        avatarColor: p.avatarColor,
        avatarUrl: url(p),
      },
    ]),
  );
}

async function toRunDTOs(
  rows: (typeof runsTable.$inferSelect)[],
): Promise<ImportRunDTO[]> {
  const [faces, homes] = await Promise.all([actorFaces(rows), teamsOf(rows)]);
  return rows.map((r) =>
    toRunDTO(
      r,
      (r.actorUserId && faces.get(r.actorUserId)) || null,
      homes.get(r.teamId) ?? null,
    ),
  );
}

async function teamsOf(
  rows: { teamId: string }[],
): Promise<Map<string, { name: string; slug: string; image: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.teamId))];
  if (ids.length === 0) return new Map();
  const found = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      image: teamsTable.image,
    })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return new Map(found.map((t) => [t.id, t]));
}

function toRunDTO(
  r: typeof runsTable.$inferSelect,
  face: ActorFace | null,
  home: { name: string; slug: string; image: string | null } | null,
): ImportRunDTO {
  return {
    id: r.id,
    teamId: r.teamId,
    teamName: home?.name ?? "",
    teamSlug: home?.slug ?? "",
    teamAvatarUrl: deploTeamAvatarUrl(home?.image),
    platform: isMigrationPlatform(r.platform) ? r.platform : "dokploy",
    sourceUrl: r.sourceUrl,
    orgName: r.orgName,
    actor: r.actor,
    actorUsername: face?.username ?? null,
    actorAvatarUrl: face?.avatarUrl ?? null,
    actorAvatarColor: face?.avatarColor ?? null,
    status: r.status,
    created: r.created,
    skipped: r.skipped,
    failed: r.failed,
    manual: r.manual,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    phase: r.phase,
    doneSteps: r.doneSteps,
    totalSteps: r.totalSteps,
    stepLabel: r.stepLabel,
    stopRequested: r.stopRequested,
    reportSeenAt: r.reportSeenAt,
    heartbeatAt: r.heartbeatAt,
    lastPath: null,
    sessionId: r.sessionId,
  };
}
