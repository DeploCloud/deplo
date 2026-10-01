import { builder } from "../../builder";
import { RecopySourceRef } from "./data-move";
import { ImportRunRef } from "./run-types";
import { recopySourceFor } from "@/lib/data/migration-data/recopy";
import { exportTeamForMigration } from "@/lib/data/migration-export/export";
import {
  getMigrationRun,
  listMigrationRuns,
  migrationSessionRuns,
} from "@/lib/data/migration-import/run-queries";

builder.queryFields((t) => ({
  dataRecopySource: t.field({
    type: RecopySourceRef,
    nullable: true,
    authScopes: { capability: "restore_backups" },
    description:
      "Where a workload whose data did not come across was imported from, so the copy can be run again from its own page. Null when nothing here came from a migration.",
    args: {
      kind: t.arg.string({ required: true }),
      id: t.arg.string({ required: true }),
    },
    resolve: (_r, { kind, id }) =>
      recopySourceFor(kind === "database" ? "database" : "app", id),
  }),
  migrationRuns: t.field({
    type: [ImportRunRef],
    authScopes: { capability: "create_projects" },
    description:
      "This team's import history, newest first. Without the per-run report - read one run for that.",
    resolve: () => listMigrationRuns(),
  }),
  migrationRun: t.field({
    type: ImportRunRef,
    nullable: true,
    authScopes: { capability: "create_projects" },
    description: "One import with its full report.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getMigrationRun(id),
  }),
  migrationSession: t.field({
    type: [ImportRunRef],
    authScopes: { instanceAdmin: true },
    description:
      "Every team of ONE walk of the wizard, oldest first, with the people each run brought over. A panel with three teams is three runs, started one after another by the control plane - this is what makes them one migration on screen again after the tab that began them is gone. A team still waiting its turn is in here with status `queued`.",
    args: {
      runId: t.arg.string({
        required: true,
        description: "Any run of the session.",
      }),
    },
    resolve: (_r, { runId }) => migrationSessionRuns(runId),
  }),
  migrationExport: t.field({
    type: "JSON",
    authScopes: { capability: "reveal_secrets" },
    description:
      "The active team as another Deplo reads it to migrate it: projects, apps, databases, variables, domains, schedules and the volumes that hold their data - secret values DECRYPTED. Needs `reveal_secrets` over the whole team, and every read is recorded in Activity. Versioned (`version`); the shape is lib/migration/deplo/export-shape.ts.",
    resolve: () => exportTeamForMigration(),
  }),
}));
