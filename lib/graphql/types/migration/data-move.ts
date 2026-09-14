import { builder } from "../../builder";
import { ConnectInputRef } from "./inputs";
import {
  moveMigrationServiceData,
  type DataMoveResult,
} from "@/lib/data/migration-data/move";
import {
  planMigrationDataMove,
  type DataMoveService,
  type DataMoveVolume,
} from "@/lib/data/migration-data/plan";
import { type RecopySource } from "@/lib/data/migration-data/recopy";

export const DataMoveVolumeRef = builder
  .objectRef<DataMoveVolume>("MigrationDataVolume")
  .implement({
    description:
      "One source volume and the Deplo volume it would be copied into, paired by the path they are mounted at.",
    fields: (t) => ({
      sourceVolume: t.exposeString("sourceVolume"),
      targetVolume: t.exposeString("targetVolume"),
      mountPath: t.exposeString("mountPath"),
      note: t.exposeString("note", {
        nullable: true,
        description:
          "Set when the pairing rests on something weaker than an equal path - a database whose data directory moved between engine versions, for instance.",
      }),
    }),
  });

export const RecopySourceRef = builder
  .objectRef<RecopySource>("MigrationRecopySource")
  .implement({
    description:
      "The panel service a blocked app or database was imported from. Its key is NOT here: a run wipes the token the moment it ends, so copying the data again asks for it once more.",
    fields: (t) => ({
      runId: t.exposeString("runId"),
      sourceUrl: t.exposeString("sourceUrl"),
      platform: t.exposeString("platform"),
      sourceKind: t.exposeString("sourceKind"),
      sourceId: t.exposeString("sourceId"),
      sourceName: t.exposeString("sourceName"),
    }),
  });

export const DataMoveServiceRef = builder
  .objectRef<DataMoveService>("MigrationDataService")
  .implement({
    description:
      "An already-imported service whose data can still be moved over from the panel.",
    fields: (t) => ({
      path: t.exposeString("path"),
      sourceKind: t.exposeString("sourceKind"),
      sourceId: t.exposeString("sourceId"),
      sourceName: t.exposeString("sourceName"),
      sourceServerId: t.exposeString("sourceServerId"),
      targetKind: t.exposeString("targetKind"),
      targetId: t.exposeString("targetId"),
      targetName: t.exposeString("targetName"),
      targetServerId: t.exposeString("targetServerId"),
      running: t.exposeBoolean("running", {
        description:
          "Still up over there. Moving the data stops it, which is the point of a cutover.",
      }),
      sourceReachable: t.exposeBoolean("sourceReachable", {
        description:
          "Whether the machine holding this data ANSWERS Deplo right now - a live Hello, not the stored status, which goes green on the agent's outbound call-home and says nothing about the direction a copy needs. False means the copy cannot start at all, and the caller must not begin it: one unreachable machine is one refusal, not one failure per service.",
      }),
      volumes: t.field({
        type: [DataMoveVolumeRef],
        resolve: (s) => s.volumes,
      }),
      notes: t.exposeStringList("notes"),
    }),
  });

export const DataMoveResultRef = builder
  .objectRef<DataMoveResult>("MigrationDataMoveResult")
  .implement({
    fields: (t) => ({
      moved: t.exposeInt("moved"),
      failed: t.exposeInt("failed"),
      notes: t.exposeStringList("notes"),
      sourceGone: t.exposeBoolean("sourceGone", {
        description:
          "The source machine stopped answering part way through - a connection that died, not a volume that could not be read. The caller MUST stop: every service still to come is on the same machine, each one gets stopped on the other platform before its copy is attempted, and carrying on turns one broken host into a whole organisation with no data and its services down on both sides.",
      }),
    }),
  });

builder.mutationFields((t) => ({
  planMigrationDataMove: t.field({
    type: [DataMoveServiceRef],
    authScopes: { capability: "create_projects" },
    description:
      "The services THIS RUN imported whose DATA can still be moved, with each volume paired to the Deplo one that would receive it (paired by container path, the only identity the two platforms share). Reads both sides and writes nothing. Scoped to the run because the copy WIPES its target before writing: what a service became is a fact the run recorded, never a name that happens to match.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
    },
    resolve: (_r, { input, runId }) =>
      planMigrationDataMove({
        url: input.url,
        apiKey: input.apiKey,
        kind: input.kind ?? undefined,
        runId,
      }),
  }),
  moveMigrationServiceData: t.field({
    type: DataMoveResultRef,
    authScopes: { capability: "create_projects" },
    description:
      "Cut ONE service's data over: STOP it on the panel (and leave it stopped - a volume read while its container writes cannot be trusted), then copy every paired volume into the app or database imported from it. A database is started again afterwards and checked, so the report says the engine reads the copied data rather than only that bytes moved. Additionally gated on `restore_backups` on the target, which is what overwriting a resource's data already requires. NEITHER side is taken from the caller: the volumes are derived from the service and the app, and the host the data is read from is derived from that machine's address - naming either would be an instruction to copy any volume on any host over any other one.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
      sourceKind: t.arg.string({ required: true }),
      sourceId: t.arg.string({ required: true }),
    },
    resolve: (_r, { input, runId, sourceKind, sourceId }) =>
      moveMigrationServiceData({
        url: input.url,
        apiKey: input.apiKey,
        kind: input.kind ?? undefined,
        runId,
        sourceKind,
        sourceId,
      }),
  }),
}));
