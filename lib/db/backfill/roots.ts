import type { DeploData } from "../../types";
import { servers, teams, users } from "../schema/control-plane";
import type { BackfillTx } from "./types";

/**
 * FK-root prerequisites (relational-store PLAN §2 "FK ordering for
 * creation/backfill (roots first): users, teams, …").
 *
 * Every relational table outside the identity aggregate carries a NOT-NULL
 * `team_id` FK (and `api_tokens` a `user_id` FK) to `teams`/`users`. But those
 * root tables are only the AUTHORITATIVE responsibility of cut-set (b)
 * (identity), which is ordered AFTER the leaf cut-set (a). So a cut-set that runs
 * before (b) — the leaf cut-set, run first to prove the engine — must still see
 * its FK roots present, or its NOT-NULL FK inserts fail.
 *
 * Resolution: a cut-set seeds the root rows it references, idempotently. The keys
 * (`id`/`email`/`slug`/…) are stable, so `ON CONFLICT DO NOTHING` makes this safe
 * to overlap with cut-set (b)'s later authoritative copy — whichever runs first
 * inserts; the other no-ops. Each cut-set's marker still guards its own copy, so
 * the seed never runs twice for the same cut-set. The values come straight from
 * the JSONB document (the single source of truth at switch time); they are NOT
 * re-normalized here — cut-set (b) owns identity normalization.
 */

/** Idempotently insert the teams + users a non-identity cut-set's FKs reference. */
export async function seedIdentityRoots(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  if (data.teams.length > 0) {
    await tx
      .insert(teams)
      .values(
        data.teams.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          plan: t.plan,
          createdAt: t.createdAt,
        })),
      )
      .onConflictDoNothing();
  }
  if (data.users.length > 0) {
    await tx
      .insert(users)
      .values(
        data.users.map((u) => ({
          id: u.id,
          email: u.email,
          username: u.username,
          name: u.name,
          passwordHash: u.passwordHash,
          role: u.role,
          isInstanceAdmin: Boolean(u.isInstanceAdmin),
          suspended: Boolean(u.suspended),
          canExposePorts: Boolean(u.canExposePorts),
          canMountHostVolumes: Boolean(u.canMountHostVolumes),
          avatarColor: u.avatarColor,
          createdAt: u.createdAt,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Idempotently seed the `servers` rows a cut-set's RESTRICT FKs reference
 * (`projects.server_id` for cut-set (c); `databases.server_id` for cut-set (d)).
 *
 * `servers` is owned by NO cut-set yet (it is instance-wide infra, still
 * JSONB-authoritative through the `server-row.ts` bridge), but both cut-sets'
 * RESTRICT FKs need the rows present, so each seeds them from the JSONB at switch
 * time. `ON CONFLICT DO NOTHING` makes the two cut-sets' seeds (and the live
 * bridge's mirror-writes) compose without clobbering — whichever runs first
 * inserts, the rest no-op. Values come straight from the JSONB (the agent /
 * bootstrap nested objects flattened to columns), NOT re-normalized.
 */
export async function seedServers(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  if (data.servers.length === 0) return;
  await tx
    .insert(servers)
    .values(
      data.servers.map((s) => ({
        id: s.id,
        name: s.name,
        host: s.host,
        type: s.type,
        status: s.status,
        ip: s.ip,
        dockerVersion: s.dockerVersion,
        traefikEnabled: s.traefikEnabled,
        cpuCores: s.cpuCores,
        memoryMb: s.memoryMb,
        diskGb: s.diskGb,
        cpuUsage: s.cpuUsage,
        memoryUsage: s.memoryUsage,
        diskUsage: s.diskUsage,
        agentPort: s.agent?.port ?? null,
        agentCertFingerprint: s.agent?.certFingerprint ?? null,
        agentCertPem: s.agent?.certPem ?? null,
        agentVersion: s.agent?.version ?? null,
        bootstrapTokenHash: s.bootstrap?.tokenHash ?? null,
        bootstrapExpiresAt: s.bootstrap?.expiresAt ?? null,
        bootstrapUsedAt: s.bootstrap?.usedAt ?? null,
        lastSeenAt: s.lastSeenAt ?? null,
        createdAt: s.createdAt,
      })),
    )
    .onConflictDoNothing();
}
