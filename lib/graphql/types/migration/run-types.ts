import { builder } from "../../builder";
import { MigrationOutcomeEnum, MigrationPlatformEnum } from "./enums";
import { type MigrationInvite } from "@/lib/data/migration-import/member-invites";
import { type ImportProjectResult } from "@/lib/data/migration-import/project-import";
import { type RevertResultDTO } from "@/lib/data/migration-import/revert";
import { type ImportRunDTO } from "@/lib/data/migration-import/run-queries";
import type { ImportItemDTO } from "@/lib/data/migration-import/run-report";

export const ImportItemRef = builder
  .objectRef<ImportItemDTO>("MigrationRunItem")
  .implement({
    fields: (t) => ({
      path: t.exposeString("path", {
        description:
          "Where it was over there: `Project / Environment / service`.",
      }),
      sourceKind: t.exposeString("sourceKind"),
      sourceName: t.exposeString("sourceName"),
      outcome: t.field({
        type: MigrationOutcomeEnum,
        resolve: (i) => i.outcome as never,
      }),
      targetKind: t.exposeString("targetKind", { nullable: true }),
      targetId: t.exposeString("targetId", { nullable: true }),
      message: t.exposeString("message", { nullable: true }),
      at: t.exposeString("at", {
        nullable: true,
        description:
          "When this line happened. Null on rows written before the report became something you can watch. A report read afterwards is a list; read while it runs it is a log, and a log with no times is not one.",
      }),
    }),
  });

export const InviteRef = builder
  .objectRef<MigrationInvite>("MigrationInvite")
  .implement({
    description:
      "One person from the source team or organization: either added to the team (they already had a Deplo account) or handed a single-use registration link.",
    fields: (t) => ({
      email: t.exposeString("email"),
      name: t.exposeString("name"),
      link: t.exposeString("link", {
        nullable: true,
        description:
          "The single-use registration link to send them, or null when they were added directly.",
      }),
      outcome: t.field({
        type: MigrationOutcomeEnum,
        resolve: (i) => i.outcome as never,
      }),
      message: t.exposeString("message", { nullable: true }),
      sourceRole: t.string({
        description: "What they were on the panel, when it says.",
        resolve: (i) => i.sourceRole ?? "",
      }),
      hasAccount: t.boolean({
        description: "Whether that address already has an account here.",
        resolve: (i) => i.hasAccount ?? false,
      }),
      avatarUrl: t.string({
        nullable: true,
        description: "Their picture, when they already have an account here.",
        resolve: (i) => i.avatarUrl ?? null,
      }),
    }),
  });

export const ImportRunRef = builder
  .objectRef<
    ImportRunDTO & { items?: ImportItemDTO[]; members?: MigrationInvite[] }
  >("MigrationRun")
  .implement({
    description:
      "One import, kept after the tab that started it is gone. The API key is never stored.",
    fields: (t) => ({
      id: t.exposeString("id"),
      platform: t.field({
        type: MigrationPlatformEnum,
        description:
          "Which product this run read. Decided once, when it connected.",
        resolve: (r) => r.platform,
      }),
      sourceUrl: t.exposeString("sourceUrl"),
      orgName: t.exposeString("orgName", { nullable: true }),
      actor: t.exposeString("actor"),
      status: t.exposeString("status", {
        description:
          "running | done | failed. A run left open by a closed tab is failed as `Interrupted` by the next one.",
      }),
      created: t.exposeInt("created"),
      skipped: t.exposeInt("skipped"),
      failed: t.exposeInt("failed"),
      manual: t.exposeInt("manual"),
      error: t.exposeString("error", { nullable: true }),
      startedAt: t.exposeString("startedAt"),
      finishedAt: t.exposeString("finishedAt", { nullable: true }),
      phase: t.exposeString("phase", {
        description:
          "`config` | `data` | `done`. Which half the run is in - the two count different things, so their step numbers are not one scale.",
      }),
      doneSteps: t.exposeInt("doneSteps"),
      totalSteps: t.exposeInt("totalSteps"),
      stepLabel: t.exposeString("stepLabel", { nullable: true }),
      stopRequested: t.exposeBoolean("stopRequested", {
        description:
          "Somebody asked it to stop. The runner notices between steps - never mid-call, because a call already sent finishes on the far side whatever this row says.",
      }),
      heartbeatAt: t.exposeString("heartbeatAt", {
        nullable: true,
        description:
          'When the control plane driving this run last said it was alive, or null while nothing has picked it up. A run is a row that says `running` whether or not anybody is driving it, so this is the only honest answer to "is it actually doing something": older than 90 seconds (or null) means no runner has it, and the next tick anywhere on the instance will take it over.',
      }),
      lastPath: t.exposeString("lastPath", {
        nullable: true,
        description:
          "The last thing this run touched, as `Project / Environment / service`. Filled in only by the live `activeMigration` feed - the history list leaves it null, because a finished run says where it got to with its whole report. It is the only record of a run's POSITION that survives the tab: the loop lives in the browser, and so does the plan that knew how many projects there were.",
      }),
      items: t.field({
        type: [ImportItemRef],
        description: "The report. Only loaded by the single-run query.",
        resolve: (r) => r.items ?? [],
      }),
      teamId: t.exposeString("teamId", {
        description: "The Deplo team this run landed in.",
      }),
      teamName: t.exposeString("teamName"),
      teamSlug: t.exposeString("teamSlug"),
      teamAvatarUrl: t.exposeString("teamAvatarUrl", { nullable: true }),
      sessionId: t.exposeString("sessionId", {
        nullable: true,
        description:
          "The runs of ONE walk of the wizard share this: several teams of the same panel are several runs, brought over one after another by the control plane. Null on runs made before the queue left the browser.",
      }),
      members: t.field({
        type: [InviteRef],
        description:
          "The people the panel listed on this team, as the run recorded them - who was added, and who was handed a link. Only the session query loads them.",
        resolve: (r) => ("members" in r ? (r.members ?? []) : []),
      }),
    }),
  });

export const ImportProjectResultRef = builder
  .objectRef<ImportProjectResult>("MigrationProjectResult")
  .implement({
    fields: (t) => ({
      projectName: t.exposeString("projectName"),
      created: t.exposeInt("created"),
      skipped: t.exposeInt("skipped"),
      failed: t.exposeInt("failed"),
      manual: t.exposeInt("manual"),
      items: t.field({ type: [ImportItemRef], resolve: (r) => r.items }),
    }),
  });

export const RevertResultRef = builder
  .objectRef<RevertResultDTO>("MigrationRevertResult")
  .implement({
    description:
      "What a revert took back out of Deplo, and what is still here because it could not be removed.",
    fields: (t) => ({
      apps: t.exposeInt("apps"),
      databases: t.exposeInt("databases"),
      environments: t.exposeInt("environments"),
      projects: t.exposeInt("projects"),
      sharedVars: t.exposeInt("sharedVars"),
      failed: t.exposeStringList("failed", {
        description:
          "One line per thing that is still here, and why - a host that would not confirm the volume is gone, or a capability the actor does not hold.",
      }),
    }),
  });
