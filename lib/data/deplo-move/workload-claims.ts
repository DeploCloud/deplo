import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deploMoveWorkloads } from "../../db/schema/control-plane/deplo-move";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import * as moveClient from "../../deplo-move/client";
import type {
  MoveWorkloadInfo,
  WorkloadKind,
  WorkloadRef,
} from "../../deplo-move/protocol";

// Where a workload lands here, and the database address it answers at (a database only).
export interface ClaimTarget {
  serverId: string;
  dbHost?: string;
}

interface Holder {
  kind: WorkloadKind;
  id: string;
  name: string;
  host: string | null;
}

const keyOf = (r: WorkloadRef) => `${r.kind}:${r.id}`;

// Two workloads from different old servers can carry the same name; on one server here they would share one thing.
export class MoveClaims {
  private infos = new Map<string, MoveWorkloadInfo | null>();

  constructor(
    private readonly moveId: string,
    private readonly c: moveClient.MoveCredential,
    private readonly signal?: AbortSignal,
  ) {}

  remember(info: MoveWorkloadInfo): void {
    this.infos.set(keyOf(info), info);
  }

  // Refuses when another workload of this move already holds the same database address, volume or folder there.
  async check(
    ref: WorkloadRef,
    info: MoveWorkloadInfo,
    here: ClaimTarget,
  ): Promise<void> {
    const others = (await this.heldOn(here.serverId)).filter(
      (o) => o.kind !== ref.kind || o.id !== ref.id,
    );
    if (others.length === 0) return;
    const taken = async (other: string, what: string) =>
      new Error(
        `${other}, from another server, already uses ${what} on ${await serverName(here.serverId)}.`,
      );
    const sameHost = here.dbHost
      ? others.find((o) => o.kind === "database" && o.host === here.dbHost)
      : undefined;
    if (sameHost)
      throw await taken(sameHost.name, `the database address ${here.dbHost}`);
    // An app's volumes are named after its slug, unique here: only a pinned name or a folder can be shared.
    if (ref.kind !== "app" || (!info.volumes.length && !info.hostPaths.length))
      return;
    for (const o of others) {
      if (o.kind !== "app") continue;
      const theirs = await this.infoOf(o);
      // From the same server there, it shares them over there too.
      if (!theirs || theirs.serverId === info.serverId) continue;
      const volume = info.volumes.find((v) => theirs.volumes.includes(v));
      if (volume) throw await taken(o.name, `the volume ${volume}`);
      const folder = info.hostPaths.find((h) =>
        theirs.hostPaths.some((t) => t.path === h.path),
      );
      if (folder) throw await taken(o.name, `the folder ${folder.path}`);
    }
  }

  // Only one that came across holds a name: a failed one is checked again on retry, so the first to finish keeps it.
  private async heldOn(serverId: string): Promise<Holder[]> {
    const db = getDb();
    const ofThisMove = and(
      eq(deploMoveWorkloads.moveId, this.moveId),
      inArray(deploMoveWorkloads.state, ["copying", "done"]),
    );
    const [dbs, apps] = await Promise.all([
      db
        .select({
          id: databasesTable.id,
          name: databasesTable.name,
          host: databasesTable.host,
        })
        .from(deploMoveWorkloads)
        .innerJoin(
          databasesTable,
          and(
            eq(deploMoveWorkloads.kind, "database"),
            eq(deploMoveWorkloads.workloadId, databasesTable.id),
          ),
        )
        .where(and(ofThisMove, eq(databasesTable.serverId, serverId)))
        .orderBy(asc(deploMoveWorkloads.position)),
      db
        .select({ id: appsTable.id, name: appsTable.name })
        .from(deploMoveWorkloads)
        .innerJoin(
          appsTable,
          and(
            eq(deploMoveWorkloads.kind, "app"),
            eq(deploMoveWorkloads.workloadId, appsTable.id),
          ),
        )
        .where(and(ofThisMove, eq(appsTable.serverId, serverId)))
        .orderBy(asc(deploMoveWorkloads.position)),
    ]);
    return [
      ...dbs.map((d) => ({ kind: "database" as const, ...d })),
      ...apps.map((a) => ({ kind: "app" as const, ...a, host: null })),
    ];
  }

  // Read again from the old Deplo after a restart; one it cannot describe any more is not counted.
  private async infoOf(o: Holder): Promise<MoveWorkloadInfo | null> {
    const key = keyOf(o);
    if (!this.infos.has(key)) {
      const info = await moveClient
        .workload(this.c, { kind: o.kind, id: o.id }, this.signal)
        .catch((e) => {
          this.signal?.throwIfAborted();
          console.warn(
            `[deplo-move] could not read ${o.name} from the old Deplo to compare it: ${e instanceof Error ? e.message : String(e)}`,
          );
          return null;
        });
      this.infos.set(key, info);
    }
    return this.infos.get(key) ?? null;
  }
}

async function serverName(id: string): Promise<string> {
  const [row] = await getDb()
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, id))
    .limit(1);
  return row?.name ?? "this server";
}
