import { builder } from "../builder";
import type { ResourceLimits } from "@/lib/types";

/**
 * The shared ResourceLimits object/input pair, used by BOTH the App and the
 * Database modules (the two carry the identical flattened resource_* columns).
 * Lives in its own leaf module — not exported from app.ts — because importing a
 * ref ACROSS type modules can double-evaluate the defining module under
 * Turbopack and re-register its types (see the AppRef note in app.ts). This
 * file defines no query/mutation fields, so it needs no schema.ts entry; it is
 * evaluated via its importers.
 */

export const ResourceLimitsRef = builder
  .objectRef<ResourceLimits>("ResourceLimits")
  .implement({
    description:
      "Per-container resource caps applied to a workload (an App's containers " +
      "at deploy time, a Database's container at provision/redeploy time). A " +
      "null field means that dimension is uncapped. Memory is in MiB, disk in " +
      "GiB, CPU in milli-CPUs (1000 = one core).",
    fields: (t) => ({
      memoryMb: t.exposeInt("memoryMb", { nullable: true }),
      memoryReservationMb: t.exposeInt("memoryReservationMb", { nullable: true }),
      swapMb: t.exposeInt("swapMb", { nullable: true }),
      cpuMilli: t.exposeInt("cpuMilli", { nullable: true }),
      cpuShares: t.exposeInt("cpuShares", { nullable: true }),
      cpuset: t.exposeString("cpuset", { nullable: true }),
      pidsLimit: t.exposeInt("pidsLimit", { nullable: true }),
      shmSizeMb: t.exposeInt("shmSizeMb", { nullable: true }),
      storageGb: t.exposeInt("storageGb", { nullable: true }),
      nofile: t.exposeInt("nofile", { nullable: true }),
      nproc: t.exposeInt("nproc", { nullable: true }),
      oomScoreAdj: t.exposeInt("oomScoreAdj", { nullable: true }),
    }),
  });

export const ResourceLimitsInputType = builder.inputType("ResourceLimitsInput", {
  description:
    "Per-container resource caps. Every field is optional and independently " +
    "nullable (null ⇒ that dimension is uncapped); the form sends the full set " +
    "on each save. Memory in MiB, disk in GiB, CPU in milli-CPUs (1000 = one " +
    "core).",
  fields: (t) => ({
    memoryMb: t.int({ required: false }),
    memoryReservationMb: t.int({ required: false }),
    swapMb: t.int({ required: false }),
    cpuMilli: t.int({ required: false }),
    cpuShares: t.int({ required: false }),
    cpuset: t.string({ required: false }),
    pidsLimit: t.int({ required: false }),
    shmSizeMb: t.int({ required: false }),
    storageGb: t.int({ required: false }),
    nofile: t.int({ required: false }),
    nproc: t.int({ required: false }),
    oomScoreAdj: t.int({ required: false }),
  }),
});
