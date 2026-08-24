import { builder } from "../builder";
import { pubSub, MIGRATION_ACTIVITY_TOPIC } from "../pubsub";
import {
  moveDokployServiceData,
  planDokployDataMove,
  type DataMoveResult,
  type DataMoveService,
  type DataMoveVolume,
} from "@/lib/data/dokploy-data";
import {
  activeDokployImportForTeam,
  beginDokployImport,
  type DokployInvite,
  type DokployPlan,
  finishDokployImport,
  getDokployImport,
  importDokployMembers,
  importDokployProject,
  type ImportItemDTO,
  type ImportProjectResult,
  type ImportRunDTO,
  listDokployImports,
  type PlanEnvironment,
  type PlanMember,
  type PlanProject,
  type PlanServer,
  type PlanService,
  revertDokployImport,
  type RevertResultDTO,
  scanDokploy,
  setDokployMachineAddress,
  stopDokployImport,
} from "@/lib/data/dokploy-import";

/**
 * Import from Dokploy — read a Dokploy instance over its API and create the deplo
 * equivalents in the ACTIVE team.
 *
 * Every resolver is one line into `lib/data/dokploy-import.ts`, which is where the
 * gates live. `create_projects` is the entry capability on all of them (and the
 * data layer additionally refuses a narrowed principal, since an import writes
 * across the whole team); each object created then re-checks its own capability
 * inside the same `lib/data` function the UI calls, so a caller who cannot create
 * databases gets them in the report instead of a privileged shortcut.
 *
 * The import is driven one PROJECT per call. That is deliberate: progress is real,
 * each request is short, and re-running resumes rather than duplicating.
 */

/* ------------------------------------------------------------------ */
/* Enums                                                              */
/* ------------------------------------------------------------------ */

const DokployPlanStatusEnum = builder.enumType("DokployPlanStatus", {
  description:
    "What the preview thinks will happen to one Dokploy service. new = it will be created. exists = something with that name is already here, so it is left alone. unsupported = Deplo has no such thing (a libsql database, a service Dokploy would not return). needs_grant = it can only be created by someone holding the host-volumes or expose-ports grant.",
  values: ["new", "exists", "unsupported", "needs_grant"] as const,
});

const DokployOutcomeEnum = builder.enumType("DokployImportOutcome", {
  description:
    "One line of the report. created = it is in Deplo now. skipped = already here, or left out on purpose. failed = refused, with the server's own message. manual = it came across, but something needs a person (a private repo with no credential, a database whose host name changed, a compose file that was rewritten). unsupported = there is no Deplo equivalent.",
  values: ["created", "skipped", "failed", "manual", "unsupported"] as const,
});

/* ------------------------------------------------------------------ */
/* The plan                                                           */
/* ------------------------------------------------------------------ */

const PlanServiceRef = builder
  .objectRef<PlanService>("DokployPlanService")
  .implement({
    description:
      "One Dokploy service (an application, a compose stack, or a database) as it would land here.",
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      kind: t.exposeString("kind", {
        description:
          "What it is on Dokploy: application, compose, or one of postgres/mysql/mariadb/mongo/redis/libsql.",
      }),
      name: t.exposeString("name"),
      targetKind: t.exposeString("targetKind", {
        nullable: true,
        description: "app or database, or null when Deplo has no equivalent.",
      }),
      status: t.field({
        type: DokployPlanStatusEnum,
        resolve: (s) => s.status,
      }),
      sourceServerId: t.exposeString("sourceServerId", {
        description:
          "The Dokploy server it runs on. Empty string means Dokploy's own host, which has no server row over there.",
      }),
      buildsFromSource: t.exposeBoolean("buildsFromSource", {
        description:
          "Whether Deplo would ever compile this. False for a compose stack, a prebuilt image and a database - all of them deploy as they are, so a build server would have nothing to do for them.",
      }),
      engine: t.exposeString("engine", {
        nullable: true,
        description:
          "Deplo's own engine id for a database (`mongo` on Dokploy is `mongodb` here), so a client can show the engine's brand mark. Null for anything that is not a database Deplo has.",
      }),
      exposedPort: t.exposeInt("exposedPort", {
        nullable: true,
        description:
          "The host port this database publishes on Dokploy, so a review can say what will be published and offer another port when that one is taken here. Describes the SOURCE: it is reported whether or not the caller holds the publish-ports grant, and null only for something that is not a database or publishes nothing.",
      }),
      domains: t.exposeStringList("domains", {
        description:
          "The hostnames that would come across. Dokploy's generated throwaway hosts (traefik.me, sslip.io, nip.io) are already dropped — Deplo mints its own.",
      }),
      logo: t.exposeString("logo", {
        nullable: true,
        description:
          "The icon this service would arrive with, as an inline data-URI, or null when it has none. Already validated against what Deplo will store, so a client can render it as-is.",
      }),
      notes: t.exposeStringList("notes", {
        description:
          "What will not come across, or will need a look afterwards.",
      }),
    }),
  });

const PlanEnvironmentRef = builder
  .objectRef<PlanEnvironment>("DokployPlanEnvironment")
  .implement({
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      name: t.exposeString("name"),
      exists: t.exposeBoolean("exists", {
        description:
          "An environment of that name is already in the matching project — Dokploy's `production` maps onto the one every Deplo project starts with.",
      }),
      services: t.field({ type: [PlanServiceRef], resolve: (e) => e.services }),
    }),
  });

const PlanProjectRef = builder
  .objectRef<PlanProject>("DokployPlanProject")
  .implement({
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      name: t.exposeString("name"),
      exists: t.exposeBoolean("exists"),
      environments: t.field({
        type: [PlanEnvironmentRef],
        resolve: (p) => p.environments,
      }),
    }),
  });

const PlanServerRef = builder
  .objectRef<PlanServer>("DokployPlanServer")
  .implement({
    description:
      "One machine behind the source instance. The FIRST entry is always the host the source instance itself runs on, whose `sourceId` is the empty string - the same key the server mapping and the data cutover use for it.",
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      name: t.exposeString("name"),
      ipAddress: t.exposeString("ipAddress", { nullable: true }),
      deploServerId: t.exposeString("deploServerId", {
        nullable: true,
        description:
          "The Deplo server at that same address, or null when Deplo has no agent there. Data cannot be copied off a machine Deplo cannot reach: a volume is read by the agent ON its host, and agents cannot dial each other.",
      }),
      deploServerName: t.exposeString("deploServerName", { nullable: true }),
    }),
  });

const PlanMemberRef = builder
  .objectRef<PlanMember>("DokployPlanMember")
  .implement({
    description:
      "Someone in the Dokploy organization the API key reads. Empty when the key belongs to a plain member, which cannot list the organization.",
    fields: (t) => ({
      email: t.exposeString("email"),
      name: t.exposeString("name"),
      sourceRole: t.exposeString("sourceRole", {
        description:
          "The role they held on Dokploy. Shown, never applied: everyone arrives as a plain member and is promoted on purpose.",
      }),
      hasAccount: t.exposeBoolean("hasAccount"),
      inTeam: t.exposeBoolean("inTeam"),
    }),
  });

const DokployPlanRef = builder.objectRef<DokployPlan>("DokployPlan").implement({
  description:
    "What an import would do, read from the source instance without writing anything.",
  fields: (t) => ({
    sourceUrl: t.exposeString("sourceUrl"),
    orgName: t.exposeString("orgName", {
      nullable: true,
      description:
        "The Dokploy organization this key reads. An API key belongs to one organization, so importing a second one means a second key.",
    }),
    projects: t.field({ type: [PlanProjectRef], resolve: (p) => p.projects }),
    servers: t.field({ type: [PlanServerRef], resolve: (p) => p.servers }),
    members: t.field({ type: [PlanMemberRef], resolve: (p) => p.members }),
  }),
});

/* ------------------------------------------------------------------ */
/* The report                                                         */
/* ------------------------------------------------------------------ */

const ImportItemRef = builder
  .objectRef<ImportItemDTO>("DokployImportItem")
  .implement({
    fields: (t) => ({
      path: t.exposeString("path", {
        description:
          "Where it was on Dokploy: `Project / Environment / service`.",
      }),
      sourceKind: t.exposeString("sourceKind"),
      sourceName: t.exposeString("sourceName"),
      outcome: t.field({
        type: DokployOutcomeEnum,
        resolve: (i) => i.outcome as never,
      }),
      targetKind: t.exposeString("targetKind", { nullable: true }),
      targetId: t.exposeString("targetId", { nullable: true }),
      message: t.exposeString("message", { nullable: true }),
    }),
  });

const ImportRunRef = builder
  .objectRef<ImportRunDTO & { items?: ImportItemDTO[] }>("DokployImport")
  .implement({
    description:
      "One import, kept after the tab that started it is gone. The API key is never stored.",
    fields: (t) => ({
      id: t.exposeString("id"),
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
    }),
  });

const ImportProjectResultRef = builder
  .objectRef<ImportProjectResult>("DokployImportProjectResult")
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

const InviteRef = builder.objectRef<DokployInvite>("DokployInvite").implement({
  description:
    "One person from the Dokploy organization: either added to the team (they already had a Deplo account) or handed a single-use registration link.",
  fields: (t) => ({
    email: t.exposeString("email"),
    name: t.exposeString("name"),
    link: t.exposeString("link", {
      nullable: true,
      description:
        "The single-use registration link to send them, or null when they were added directly.",
    }),
    outcome: t.field({
      type: DokployOutcomeEnum,
      resolve: (i) => i.outcome as never,
    }),
    message: t.exposeString("message", { nullable: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* The data cutover                                                    */
/* ------------------------------------------------------------------ */

const DataMoveVolumeRef = builder
  .objectRef<DataMoveVolume>("DokployDataVolume")
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

const DataMoveServiceRef = builder
  .objectRef<DataMoveService>("DokployDataService")
  .implement({
    description:
      "An already-imported service whose data can still be moved over from Dokploy.",
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
          "Still up on Dokploy. Moving the data stops it, which is the point of a cutover.",
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

const DataMoveResultRef = builder
  .objectRef<DataMoveResult>("DokployDataMoveResult")
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

const RevertResultRef = builder
  .objectRef<RevertResultDTO>("DokployRevertResult")
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

/* ------------------------------------------------------------------ */
/* Inputs                                                             */
/* ------------------------------------------------------------------ */

const ServerChoiceInput = builder.inputType("DokployServerChoiceInput", {
  description:
    "Map one Dokploy server onto one of ours. `from` is the Dokploy server id, or the empty string for Dokploy's own host.",
  fields: (t) => ({
    from: t.string({ required: true }),
    to: t.string({ required: true }),
  }),
});

const PlacementInput = builder.inputType("DokployPlacementInput", {
  description:
    "Where one service lands. `serviceId` is the `sourceId` a scan reports. Omit `buildServerId` (or send null) for Automatic - Deplo uses a build server if the fleet has one, and compiles where the app runs otherwise.",
  fields: (t) => ({
    serviceId: t.string({ required: true }),
    serverId: t.string({ required: true }),
    buildServerId: t.string({ required: false }),
    exposedPort: t.int({
      required: false,
      description:
        "A database's host port. Omit the field to keep the port it had on Dokploy (what the import has always done); send null to publish nothing; send a number to publish there instead - which is how a review resolves a port something else already holds on the target server. Ignored for anything that is not a database.",
    }),
  }),
});

const ConnectInputRef = builder.inputType("DokployConnectInput", {
  fields: (t) => ({
    url: t.string({
      required: true,
      description:
        "The Dokploy instance's address. `/api` is added automatically, so paste the address you open in a browser.",
    }),
    apiKey: t.string({
      required: true,
      description:
        "A Dokploy API key (Settings -> Profile -> API/CLI). Use an owner's or admin's key: a plain member's key answers 403 on the per-service calls. Never stored.",
    }),
    allowPrivate: t.boolean({
      required: false,
      description:
        "Allow a private or loopback address — what the same-machine case needs (http://172.17.0.1:3000). Instance admin only, like a git connection's or an S3 endpoint's private-endpoint flag.",
    }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                            */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  dokployImports: t.field({
    type: [ImportRunRef],
    authScopes: { capability: "create_projects" },
    description:
      "This team's import history, newest first. Without the per-run report — read one run for that.",
    resolve: () => listDokployImports(),
  }),
  dokployImport: t.field({
    type: ImportRunRef,
    nullable: true,
    authScopes: { capability: "create_projects" },
    description: "One import with its full report.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getDokployImport(id),
  }),
}));

/* ------------------------------------------------------------------ */
/* Subscriptions                                                      */
/* ------------------------------------------------------------------ */

builder.subscriptionFields((t) => ({
  activeMigration: t.field({
    type: ImportRunRef,
    nullable: true,
    description:
      'Emits the migration this team currently has in flight, or null when there is none. Fires once immediately, then whenever a run starts, moves on or ends - it is what the header chip and the wizard\'s watching panel read. Deliberately NOT gated on `create_projects`: "somebody is moving a platform into this team right now" is a warning every member needs.',
    authScopes: { loggedIn: true },
    subscribe: (_root, _args, ctx) => activeMigrationStream(ctx.teamId),
    resolve: (run) => run,
  }),
}));

/**
 * Live "is a migration running in this team". Cookie-free: the team comes from
 * the GraphQL context and the read takes it as an argument, because `cookies()`
 * is not callable across the iteration ticks of a long-lived SSE response.
 *
 * Emits on every change of the RUN, counts included, so the wizard's watching
 * panel counts up without polling. A ping that changes nothing emits nothing.
 */
export async function* activeMigrationStream(
  teamId: string | null,
): AsyncGenerator<ImportRunDTO | null> {
  if (!teamId) throw new Error("Not signed in");
  let last = await activeDokployImportForTeam(teamId);
  yield last;
  for await (const ping of pubSub.subscribe(
    "migrationActivity",
    MIGRATION_ACTIVITY_TOPIC,
  )) {
    // The channel is instance-wide (a team-wide feed has no per-resource key),
    // so the payload says nothing this team cares about - re-read instead.
    void ping;
    const next = await activeDokployImportForTeam(teamId);
    if (sameRun(last, next)) continue;
    last = next;
    yield next;
  }
}

/** Two reads of the run that would render identically. */
function sameRun(a: ImportRunDTO | null, b: ImportRunDTO | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.lastPath === b.lastPath &&
    a.created === b.created &&
    a.skipped === b.skipped &&
    a.failed === b.failed &&
    a.manual === b.manual
  );
}

/* ------------------------------------------------------------------ */
/* Mutations                                                          */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  scanDokploy: t.field({
    type: DokployPlanRef,
    authScopes: { capability: "create_projects" },
    description:
      "Read a Dokploy instance and describe what an import would do. Writes NOTHING, here or there. The per-service detail calls happen now, not at import time, so the preview can already say which hostname belongs to another team, which compose file needs a grant you do not hold, and what has no equivalent here.",
    args: { input: t.arg({ type: ConnectInputRef, required: true }) },
    resolve: (_r, { input }) =>
      scanDokploy({
        url: input.url,
        apiKey: input.apiKey,
        allowPrivate: input.allowPrivate ?? false,
      }),
  }),
  beginDokployImport: t.field({
    type: "String",
    authScopes: { capability: "create_projects" },
    description:
      "Open an import run and return its id. Any run this team left open (a closed tab) is closed as failed first, so the history never shows two live imports.",
    args: {
      url: t.arg.string({ required: true }),
      orgName: t.arg.string({ required: false }),
    },
    resolve: (_r, { url, orgName }) => beginDokployImport({ url, orgName }),
  }),
  importDokployProject: t.field({
    type: ImportProjectResultRef,
    authScopes: { capability: "create_projects" },
    description:
      "Import ONE Dokploy project into the active team: its environments, apps, compose stacks, databases, variables, domains, config files, volumes, resource limits, basic-auth users and crons. Nothing is deployed — the source instance is still answering those hostnames. Anything already here is skipped by name, so running it again resumes an interrupted import instead of duplicating it. One object failing never stops the rest: it becomes a line in the report.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
      projectId: t.arg.string({
        required: true,
        description: "The Dokploy `projectId` to import.",
      }),
      servers: t.arg({ type: [ServerChoiceInput], required: false }),
      serviceIds: t.arg.stringList({
        required: false,
        description:
          "Which of the project's services to import, by their Dokploy id (the `sourceId` a scan reports). Omit to import all of them. A service left out is left out silently - it is a choice, not an outcome, so it produces no report line. An environment nothing was picked from is not created.",
      }),
      placements: t.arg({
        type: [PlacementInput],
        required: false,
        description:
          "Where each service lands, one entry per service. Wins over `servers`, which stays the fallback for anything not listed here. Both are about where a service RUNS; where its data is READ FROM is derived from the Dokploy machine's own address and is never a caller's choice. A server this team cannot deploy to is refused into a report line, never used.",
      }),
    },
    resolve: (
      _r,
      { input, runId, projectId, servers, serviceIds, placements },
    ) =>
      importDokployProject({
        url: input.url,
        apiKey: input.apiKey,
        allowPrivate: input.allowPrivate ?? false,
        runId,
        projectId,
        servers: servers?.map((s) => ({ from: s.from, to: s.to })),
        serviceIds: serviceIds ?? undefined,
        placements: placements?.map((p) => ({
          serviceId: p.serviceId,
          serverId: p.serverId,
          buildServerId: p.buildServerId ?? null,
          // NOT `?? null` like the line above it: for a port, absent and null are
          // two different instructions (keep the source's, publish nothing), so
          // an omitted field has to stay undefined all the way down.
          exposedPort: p.exposedPort,
        })),
      }),
  }),
  importDokployMembers: t.field({
    type: [InviteRef],
    authScopes: { instanceAdmin: true },
    description:
      "Bring the Dokploy organization's people over. Someone who already has a Deplo account is added to this team; everyone else gets a single-use registration link to send them. Passwords cannot travel in either direction, and everyone arrives as a plain member whatever they were over there — the report says who was an owner or admin so it can be granted on purpose.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
    },
    resolve: (_r, { input, runId }) =>
      importDokployMembers({
        url: input.url,
        apiKey: input.apiKey,
        allowPrivate: input.allowPrivate ?? false,
        runId,
      }),
  }),
  planDokployDataMove: t.field({
    type: [DataMoveServiceRef],
    authScopes: { capability: "create_projects" },
    description:
      "The services THIS RUN imported whose DATA can still be moved, with each volume paired to the Deplo one that would receive it (paired by container path, the only identity the two platforms share). Reads both sides and writes nothing. Scoped to the run because the copy WIPES its target before writing: what a service became is a fact the run recorded, never a name that happens to match.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
    },
    resolve: (_r, { input, runId }) =>
      planDokployDataMove({
        url: input.url,
        apiKey: input.apiKey,
        allowPrivate: input.allowPrivate ?? false,
        runId,
      }),
  }),
  moveDokployServiceData: t.field({
    type: DataMoveResultRef,
    authScopes: { capability: "create_projects" },
    description:
      "Cut ONE service's data over: STOP it on Dokploy (and leave it stopped - a volume read while its container writes cannot be trusted), then copy every paired volume into the app or database imported from it. A database is started again afterwards and checked, so the report says the engine reads the copied data rather than only that bytes moved. Additionally gated on `restore_backups` on the target, which is what overwriting a resource's data already requires. NEITHER side is taken from the caller: the volumes are derived from the service and the app, and the host the data is read from is derived from that machine's address - naming either would be an instruction to copy any volume on any host over any other one.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
      sourceKind: t.arg.string({ required: true }),
      sourceId: t.arg.string({ required: true }),
    },
    resolve: (_r, { input, runId, sourceKind, sourceId }) =>
      moveDokployServiceData({
        url: input.url,
        apiKey: input.apiKey,
        allowPrivate: input.allowPrivate ?? false,
        runId,
        sourceKind,
        sourceId,
      }),
  }),
  setDokployMachineAddress: t.string({
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "Point Deplo at where a machine of this Dokploy really is, and remember it for the next attempt. The address is PROVED first - the agent must answer there, over the same pinned certificate - and only then written down, because a remembered address is used automatically and an unproven one would turn a single bad guess into a permanent one. Returns a warning to surface, or null. The source server row is removed at the end of every migration, which is why this is remembered against the SOURCE rather than against that row.",
    args: {
      url: t.arg.string({ required: true }),
      sourceId: t.arg.string({
        required: true,
        description:
          "Dokploy's own machine id. Empty string for the host Dokploy itself runs on.",
      }),
      serverId: t.arg.string({ required: true }),
      address: t.arg.string({ required: true }),
    },
    resolve: async (_r, args) =>
      (
        await setDokployMachineAddress({
          sourceUrl: args.url,
          sourceId: args.sourceId,
          serverId: args.serverId,
          address: args.address,
        })
      ).warning,
  }),
  stopDokployImport: t.field({
    type: "Boolean",
    authScopes: { capability: "create_projects" },
    description:
      "Close a run somebody stopped part-way, WITHOUT finishing it - the migration sources keep their agents, because re-running is how a stopped migration is resumed.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      await stopDokployImport(runId);
      return true;
    },
  }),
  revertDokployImport: t.field({
    type: RevertResultRef,
    authScopes: { capability: "create_projects" },
    description:
      "Remove everything this run CREATED in Deplo - apps, databases, and the projects it made. Anything it merely reused is left alone, and Dokploy is not restarted. Each delete keeps its own capability gate, so what the actor may not remove comes back in `failed`.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: (_r, { runId }) => revertDokployImport(runId),
  }),
  finishDokployImport: t.field({
    type: "Boolean",
    authScopes: { capability: "create_projects" },
    description:
      "Close the run and settle its totals. Idempotent — a finished run is left alone.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      await finishDokployImport(runId);
      return true;
    },
  }),
}));
