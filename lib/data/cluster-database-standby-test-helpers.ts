import { and, eq } from "drizzle-orm";

import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import type { AgentConnection } from "../infra/agent-client/connection";
import { db, host, leader, leaderHost } from "./cluster-database-test-helpers";

// What the tests of a database's standby copy share, on top of the database lab.

const dec = new TextDecoder();
const enc = new TextEncoder();

export interface Exec {
  on: string;
  container: string;
  command: string;
  /** What that server's stacks had been asked to do when the script ran. */
  after: string[];
}
export const execs: Exec[] = [];
/** What the copy's own check answers on each member. */
export const copyState: Record<string, string> = {};

/** The members answer the engine's scripts; the leader places a copy where `place` says, or refuses. */
export function standbyLab(
  place: (exclude: string[]) => Record<string, unknown>,
) {
  execs.length = 0;
  for (const id of Object.keys(copyState)) delete copyState[id];
  for (const [id, h] of Object.entries(host))
    h.extra = {
      exec: (async (_app, container, command) => {
        execs.push({ on: id, container, command, after: [...h.stack] });
        return {
          stdout: container.endsWith("_standby")
            ? (copyState[id] ?? "following")
            : "",
          stderr: "",
          code: 0,
          rawMode: false,
        };
      }) as AgentConnection["exec"],
    };
  const calls = leaderHost.leader;
  leaderHost.leader = (method, payload) => {
    if (method !== "placement.place") return calls(method, payload);
    const body = JSON.parse(dec.decode(payload)) as { exclude?: string[] };
    return enc.encode(JSON.stringify(place(body.exclude ?? [])));
  };
}

export const onSrv3 = () => standbyLab(() => ({ member: "srv_3" }));

export const row = async () =>
  (
    await db
      .select()
      .from(databasesTable)
      .where(eq(databasesTable.id, "db_main"))
  )[0];

export const copyOn = async () =>
  (
    await db
      .select()
      .from(workloadPlacements)
      .where(
        and(
          eq(workloadPlacements.kind, "standby"),
          eq(workloadPlacements.workloadId, "db_main"),
        ),
      )
  ).map((r) => r.memberServerId);

export const lastRoster = () =>
  leader.rosters.at(-1) as unknown as {
    placement: { id: string; member: string }[];
    standbys?: { id: string; member: string; slug: string; standby: boolean }[];
  };
