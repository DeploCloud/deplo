import { builder } from "../../builder";
import {
  ConnectInputRef,
  QueuedTeamInputRef,
  RunTargetInput,
  ServerChoiceInput,
} from "./inputs";
import { RevertResultRef } from "./run-types";
import { revertMigration } from "@/lib/data/migration-import/revert";
import { finishMigration } from "@/lib/data/migration-import/run-lifecycle";
import { dismissMigrationReport } from "@/lib/data/migration-import/run-queries";
import {
  abandonMigration,
  handOverMigrationSources,
} from "@/lib/data/migration-import/source-agents";
import { setMigrationMachineAddress } from "@/lib/data/migration-import/source-machines";
import { startMigrationRun } from "@/lib/data/migration-runner/start";
import { requestStopMigrationRun } from "@/lib/data/migration-runner/stop";

builder.mutationFields((t) => ({
  startMigration: t.field({
    type: "String",
    authScopes: { capability: "create_projects" },
    description:
      "Start a migration and hand it to the control plane. Returns the run id as soon as the plan is DURABLE, not when the migration is done: the loop lives here now, under the identity of whoever started it, so the tab can be closed, reloaded or replaced and the run does not notice. The panel's token is stored encrypted for the length of the run and wiped the moment it leaves `running` - a deliberate reversal of never storing it, made because the alternative is a migration that cannot survive a page reload.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      orgName: t.arg.string({ required: false }),
      targets: t.arg({ type: [RunTargetInput], required: true }),
      servers: t.arg({ type: [ServerChoiceInput], required: false }),
      keepSources: t.arg.boolean({
        required: false,
        description:
          "Another team of the SAME panel is still to come, so this run must leave Deplo's agents on the source machines - the next team reads the same disks, and an uninstall scheduled here would race the install that follows it. The last run of a series leaves this false, and it is that one that clears them. It also holds the takeover: the ports cannot be taken while a run says more teams are owed. Ignored when `queued` is given: the queue itself says which run is the last.",
      }),
      queued: t.arg({
        type: [QueuedTeamInputRef],
        required: false,
        description:
          "The other teams of this panel, in the order they should be brought over. Each is written down with its own token, its own targets and the team it lands in, and the control plane starts each one as the turn before it ends - so the browser tab is not what walks the list any more. Every token is proved before anything is created, and a team that is to be made here is made now.",
      }),
    },
    resolve: (_r, { input, orgName, targets, servers, keepSources, queued }) =>
      startMigrationRun({
        url: input.url,
        apiKey: input.apiKey,
        kind: input.kind ?? undefined,
        orgName: orgName ?? null,
        keepSources: keepSources ?? false,
        targets: targets.map((t2) => ({
          projectId: t2.projectId,
          projectName: t2.projectName,
          serviceId: t2.serviceId,
          serverId: t2.serverId ?? null,
          buildServerId: t2.buildServerId ?? null,
          exposedPort: t2.exposedPort,
          exposedPortSet: t2.exposedPort !== undefined,
        })),
        servers: (servers ?? []).map((x) => ({ from: x.from, to: x.to })),
        queued: (queued ?? []).map((q) => ({
          apiKey: q.apiKey,
          orgName: q.orgName ?? null,
          teamId: q.teamId ?? null,
          newTeamName: q.newTeamName ?? null,
          newTeamImage: q.newTeamImage ?? null,
          targets: q.targets.map((t2) => ({
            projectId: t2.projectId,
            projectName: t2.projectName,
            serviceId: t2.serviceId,
            serverId: t2.serverId ?? null,
            buildServerId: t2.buildServerId ?? null,
            exposedPort: t2.exposedPort,
            exposedPortSet: t2.exposedPort !== undefined,
          })),
          servers: (q.servers ?? []).map((x) => ({ from: x.from, to: x.to })),
        })),
      }),
  }),
  setMigrationMachineAddress: t.string({
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "Point Deplo at where a machine of this panel really is, and remember it for the next attempt. The address is PROVED first - the agent must answer there, over the same pinned certificate - and only then written down, because a remembered address is used automatically and an unproven one would turn a single bad guess into a permanent one. Returns a warning to surface, or null. The source server row is removed at the end of every migration, which is why this is remembered against the SOURCE rather than against that row.",
    args: {
      url: t.arg.string({ required: true }),
      sourceId: t.arg.string({
        required: true,
        description:
          "The panel's own machine id. Empty string for the host the panel itself runs on.",
      }),
      serverId: t.arg.string({ required: true }),
      address: t.arg.string({ required: true }),
    },
    resolve: async (_r, args) =>
      (
        await setMigrationMachineAddress({
          sourceUrl: args.url,
          sourceId: args.sourceId,
          serverId: args.serverId,
          address: args.address,
        })
      ).warning,
  }),
  stopMigration: t.field({
    type: "Boolean",
    authScopes: { capability: "create_projects" },
    description:
      "Close a run somebody stopped part-way, WITHOUT finishing it - the migration sources keep their agents, because re-running is how a stopped migration is resumed.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      // A REQUEST, not a return from a loop: the thing that stops now runs in
      // the control plane and checks between steps, never mid-call. A run with
      // no live runner is closed on the spot instead - see the function.
      await requestStopMigrationRun(runId);
      return true;
    },
  }),
  revertMigration: t.field({
    type: RevertResultRef,
    authScopes: { capability: "create_projects" },
    description:
      "Remove everything this run CREATED in Deplo - apps, databases, and the projects it made. Anything it merely reused is left alone, and the source is not restarted. Each delete keeps its own capability gate, so what the actor may not remove comes back in `failed`.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: (_r, { runId }) => revertMigration(runId),
  }),
  handOverMigrationSources: t.field({
    type: "Int",
    authScopes: { capability: "create_projects" },
    description:
      "Point a migration at another team: the machines Deplo installed its agent on to READ the panel are granted to the team it now lands in. Called right after switching, since every lookup that reads a source is team-scoped. Refused while a run is in flight in the team being left. Returns how many machines moved.",
    args: { fromTeamId: t.arg.string({ required: true }) },
    resolve: (_r, { fromTeamId }) => handOverMigrationSources(fromTeamId),
  }),
  abandonMigration: t.field({
    type: "Int",
    authScopes: {
      $any: { instanceAdmin: true, capability: "create_projects" },
    },
    description:
      "Leaving the wizard behind: take Deplo's agent back off the machines it registered to read, exactly the way finishing does. No-op while a run is in flight (it owns those agents) and after one whose volume copy failed (the bytes are still over there). Returns how many sources it is removing.",
    resolve: () => abandonMigration(),
  }),
  dismissMigrationReport: t.field({
    type: "Boolean",
    authScopes: { capability: "create_projects" },
    description:
      '"I am done looking at this run": the migration wizard stops opening on it and shows an empty connect form again. Pressing Finish on the report is what sends it.',
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      await dismissMigrationReport(runId);
      return true;
    },
  }),
  finishMigration: t.field({
    type: "Boolean",
    authScopes: { capability: "create_projects" },
    description:
      "Close the run and settle its totals. Idempotent - a finished run is left alone.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      await finishMigration(runId);
      return true;
    },
  }),
}));
