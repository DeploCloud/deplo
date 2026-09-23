import { builder } from "../../builder";
import { ImportRunRef } from "./run-types";
import { pubSub, MIGRATION_ACTIVITY_TOPIC } from "../../pubsub";
import { liveStream } from "../../live-stream";
import {
  headerMigrationForTeam,
  type ImportRunDTO,
} from "@/lib/data/migration-import/run-queries";

builder.subscriptionFields((t) => ({
  activeMigration: t.field({
    type: ImportRunRef,
    nullable: true,
    description:
      'Emits the migration this team currently has in flight - or, once it is done, the finished run until somebody closes its report - or null. Fires once immediately, then whenever a run starts, moves on or ends - it is what the header chip and the wizard\'s panel read. Deliberately NOT gated on `create_projects`: "somebody is moving a platform into this team right now" is a warning every member needs.',
    authScopes: { loggedIn: true },
    subscribe: (_root, _args, ctx) => activeMigrationStream(ctx.teamId),
    resolve: (run) => run,
  }),
}));

export function activeMigrationStream(teamId: string | null) {
  return liveStream(
    async function* (track): AsyncGenerator<ImportRunDTO | null> {
      if (!teamId) throw new Error("Not signed in");
      let last = await headerMigrationForTeam(teamId);
      yield last;
      for await (const ping of track(
        pubSub.subscribe("migrationActivity", MIGRATION_ACTIVITY_TOPIC),
      )) {
        void ping;
        const next = await headerMigrationForTeam(teamId);
        if (sameRun(last, next)) continue;
        last = next;
        yield next;
      }
    },
  );
}

function sameRun(a: ImportRunDTO | null, b: ImportRunDTO | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.lastPath === b.lastPath &&
    a.phase === b.phase &&
    a.doneSteps === b.doneSteps &&
    a.totalSteps === b.totalSteps &&
    a.stepLabel === b.stepLabel &&
    a.heartbeatAt === b.heartbeatAt &&
    a.created === b.created &&
    a.skipped === b.skipped &&
    a.failed === b.failed &&
    a.manual === b.manual
  );
}
