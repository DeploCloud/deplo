import { builder } from "../builder";
import {
  cancelMoveCode,
  createMoveCode,
  sourceMoveStatus,
  type SourceMoveStatus,
} from "@/lib/data/deplo-move/source";
import {
  cancelMove,
  connectMove,
  currentTargetMove,
  finishMoveWithoutSource,
  moveStatus,
  retryMove,
  skipMoveWorkload,
  startMove,
  targetMoveReadiness,
  type MovePreviewServer,
  type MoveStatus,
  type MoveStatusServer,
  type MoveStatusWorkload,
  type MoveTargetServer,
  type TargetMovePreview,
} from "@/lib/data/deplo-move/target";
import { resumeMoveSchedules } from "@/lib/data/deplo-move/schedules";

// ADR-0035. The move code itself never authenticates anything here: only /api/deplo-move/* reads it.

const SourceMoveStateEnum = builder.enumType("SourceMoveState", {
  description:
    "armed = a move code waits for the new Deplo. bound = a new Deplo connected with it. copying = the new Deplo is copying this one; each app with data pauses here only while its own data copies. done = the copy finished; this Deplo keeps running as it was.",
  values: ["armed", "bound", "copying", "done"] as const,
});

const DeploMoveStateEnum = builder.enumType("DeploMoveState", {
  description:
    "connected = the old Deplo answered and the preview is ready. copying = its database is being copied here; changes are paused. deploying = each app and database is deployed here and filled with its data. done = finished. failed = stopped, with `error` saying why; retry resumes. cancelled = abandoned; anything copied here was removed.",
  values: [
    "connected",
    "copying",
    "deploying",
    "done",
    "failed",
    "cancelled",
  ] as const,
});

const DeploMoveStepKeyEnum = builder.enumType("DeploMoveStepKey", {
  description:
    "copy = every team, account, app and setting. deploy = each app and database is deployed here and its data copied in. finish = the old Deplo is told the copy is done.",
  values: ["copy", "deploy", "finish"] as const,
});

const DeploMoveStepStateEnum = builder.enumType("DeploMoveStepState", {
  values: ["waiting", "running", "done", "failed"] as const,
});

const DeploMoveWorkloadStateEnum = builder.enumType("DeploMoveWorkloadState", {
  description:
    "skipped = left out: an instance admin skipped it after it failed, or the move finished without the old Deplo before its data came across.",
  values: ["waiting", "copying", "done", "failed", "skipped"] as const,
});

const DeploMoveWorkloadKindEnum = builder.enumType("DeploMoveWorkloadKind", {
  values: ["app", "database"] as const,
});

const DeploMoveServerRoleEnum = builder.enumType("DeploMoveServerRole", {
  description:
    "What the server is for on the old Deplo: workloads (runs and builds apps), storage (backups only), build (builds only) or import (a migration source).",
  values: ["workloads", "storage", "build", "import"] as const,
});

const MoveCodeRef = builder
  .objectRef<{ code: string; expiresAt: string }>("MoveCode")
  .implement({
    description:
      "A fresh move code. This is the only time it is returned: Deplo keeps only its hash.",
    fields: (t) => ({
      code: t.exposeString("code", {
        description:
          "The `dmove_…` code to paste on the new Deplo. It lets that Deplo read every secret and every app's data, so treat it like the keys to the whole instance.",
      }),
      expiresAt: t.exposeString("expiresAt", {
        description:
          "When the code stops working if no new Deplo has used it. Once used, it lives until the copy finishes or is cancelled.",
      }),
    }),
  });

const SourceMoveRef = builder
  .objectRef<SourceMoveStatus>("SourceMove")
  .implement({
    description: "This Deplo's side of a Deplo move, as the old Deplo.",
    fields: (t) => ({
      id: t.exposeString("id"),
      state: t.field({ type: SourceMoveStateEnum, resolve: (s) => s.state }),
      peerUrl: t.exposeString("peerUrl", {
        nullable: true,
        description:
          "The new Deplo's address, once one has connected with the code.",
      }),
      expiresAt: t.exposeString("expiresAt", {
        nullable: true,
        description:
          "Set only while the code is armed: a bound code lives until the copy finishes or is cancelled.",
      }),
      startedBy: t.exposeString("startedBy"),
      createdAt: t.exposeString("createdAt"),
      finishedAt: t.exposeString("finishedAt", {
        nullable: true,
        description: "When the copy finished, once it is done.",
      }),
    }),
  });

const ReadinessRef = builder
  .objectRef<{ ready: boolean; reason: string | null }>("DeploMoveReadiness")
  .implement({
    description: "Whether this Deplo can receive a Deplo move right now.",
    fields: (t) => ({
      ready: t.exposeBoolean("ready"),
      reason: t.exposeString("reason", {
        nullable: true,
        description:
          "Why not, in one sentence: a move only goes into a fresh Deplo, one at a time.",
      }),
    }),
  });

const CountsRef = builder
  .objectRef<TargetMovePreview["counts"]>("DeploMoveCounts")
  .implement({
    description: "What the old Deplo holds, and so what a move brings over.",
    fields: (t) => ({
      teams: t.exposeInt("teams"),
      users: t.exposeInt("users"),
      apps: t.exposeInt("apps"),
      databases: t.exposeInt("databases"),
      servers: t.exposeInt("servers"),
    }),
  });

const TargetServerRef = builder
  .objectRef<MoveTargetServer>("DeploMoveTargetServer")
  .implement({
    description:
      "One of this Deplo's own servers, as a place an old server can land.",
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name"),
      address: t.exposeString("address"),
      isThisMachine: t.exposeBoolean("isThisMachine", {
        description: "The machine this Deplo itself runs on.",
      }),
      canHostWorkloads: t.exposeBoolean("canHostWorkloads", {
        description:
          "It runs apps and databases: not a storage, build or migration-source server.",
      }),
    }),
  });

const DatabaseHostRef = builder
  .objectRef<MovePreviewServer["databaseHosts"][number]>(
    "DeploMoveDatabaseHost",
  )
  .implement({
    description:
      "A database on one of the old Deplo's servers, by the address it answers at there.",
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name"),
      host: t.exposeString("host", {
        description:
          "Unique per server only: two databases with the same one cannot land on one server here.",
      }),
    }),
  });

const PreviewServerRef = builder
  .objectRef<MovePreviewServer>("DeploMovePreviewServer")
  .implement({
    description:
      "One of the old Deplo's servers, as a move would take it. It stays with the old Deplo: only what it holds is copied.",
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name"),
      address: t.exposeString("address"),
      port: t.exposeInt("port", { nullable: true }),
      role: t.field({ type: DeploMoveServerRoleEnum, resolve: (s) => s.role }),
      isPanelHost: t.exposeBoolean("isPanelHost", {
        description: "The machine the old Deplo itself runs on.",
      }),
      enrolled: t.exposeBoolean("enrolled", {
        description: "False for a server that never finished connecting.",
      }),
      reachable: t.exposeBoolean("reachable", {
        description:
          "The old Deplo reached it just now. Its apps' data can only be copied while it does.",
      }),
      agentVersion: t.exposeString("agentVersion", { nullable: true }),
      apps: t.exposeInt("apps"),
      databases: t.exposeInt("databases"),
      databaseHosts: t.field({
        type: [DatabaseHostRef],
        description:
          "Its databases. A map that lands two with the same `host` on one server here is refused.",
        resolve: (s) => s.databaseHosts,
      }),
      target: t.exposeString("target", {
        nullable: true,
        description:
          "The server here it lands on unless startDeploMove's map says otherwise. Null for a migration source, which is never copied.",
      }),
      choices: t.exposeStringList("choices", {
        description:
          "The servers here it may land on: one that runs apps for a workload server, one that builds for a build server, any for a storage one. Empty for a migration source.",
      }),
      problem: t.exposeString("problem", {
        nullable: true,
        description:
          "What keeps the move from starting because of this server, in one sentence.",
      }),
    }),
  });

const PreviewRef = builder
  .objectRef<TargetMovePreview>("DeploMovePreview")
  .implement({
    description:
      "What a Deplo move would bring here, read from the old Deplo. Nothing has changed on either side yet.",
    fields: (t) => ({
      id: t.exposeString("id", {
        description:
          "The move's id. It is also the key to its public progress page, /moving/<id>.",
      }),
      peerUrl: t.exposeString("peerUrl"),
      version: t.exposeString("version", {
        description: "The old Deplo's version.",
      }),
      counts: t.field({ type: CountsRef, resolve: (p) => p.counts }),
      servers: t.field({ type: [PreviewServerRef], resolve: (p) => p.servers }),
      targets: t.field({
        type: [TargetServerRef],
        description:
          "This Deplo's servers an old server can land on. One the old Deplo also uses is never offered.",
        resolve: (p) => p.targets,
      }),
      problems: t.exposeStringList("problems", {
        description:
          "Everything that blocks the move with each server's `target`, each naming its server. startDeploMove refuses while any remains; a database clash goes with a map that separates them.",
      }),
      warnings: t.exposeStringList("warnings", {
        description: "Worth knowing, never blocking.",
      }),
      canStart: t.exposeBoolean("canStart"),
    }),
  });

const ServerMapInput = builder.inputType("DeploMoveServerMapInput", {
  description:
    "Where one of the old Deplo's servers lands here. A server left out of the map takes its preview `target`.",
  fields: (t) => ({
    from: t.string({
      required: true,
      description: "The old Deplo's server id.",
    }),
    to: t.string({
      required: false,
      description:
        "A server id here, from the preview's `choices`. Ignored for a migration source.",
    }),
  }),
});

const StepRef = builder
  .objectRef<MoveStatus["steps"][number]>("DeploMoveStep")
  .implement({
    fields: (t) => ({
      key: t.field({ type: DeploMoveStepKeyEnum, resolve: (s) => s.key }),
      state: t.field({ type: DeploMoveStepStateEnum, resolve: (s) => s.state }),
    }),
  });

const StatusServerRef = builder
  .objectRef<MoveStatusServer>("DeploMoveServer")
  .implement({
    description: "Where one of the old Deplo's servers landed here.",
    fields: (t) => ({
      id: t.exposeString("id", { description: "The old Deplo's server id." }),
      name: t.exposeString("name"),
      targetId: t.exposeString("targetId", {
        nullable: true,
        description: "The server here that takes its place. Null: not copied.",
      }),
      targetName: t.exposeString("targetName", { nullable: true }),
    }),
  });

const StatusWorkloadRef = builder
  .objectRef<MoveStatusWorkload>("DeploMoveWorkload")
  .implement({
    description:
      "One app or database the move deploys here and fills with its data, databases first.",
    fields: (t) => ({
      kind: t.field({
        type: DeploMoveWorkloadKindEnum,
        resolve: (w) => w.kind,
      }),
      id: t.exposeString("id"),
      name: t.exposeString("name"),
      state: t.field({
        type: DeploMoveWorkloadStateEnum,
        resolve: (w) => w.state,
      }),
      error: t.exposeString("error", {
        description:
          "Why it failed or was left out, or for a copied one what was not copied. Empty otherwise.",
      }),
    }),
  });

const StatusRef = builder.objectRef<MoveStatus>("DeploMoveStatus").implement({
  description:
    "A Deplo move into this Deplo, as its progress page shows it. Read by its id alone: the copy signs everyone out.",
  fields: (t) => ({
    id: t.exposeString("id"),
    state: t.field({ type: DeploMoveStateEnum, resolve: (s) => s.state }),
    error: t.exposeString("error", {
      description:
        "Why the move stopped, or a note left by a cancel or by finishing without the old Deplo. Empty otherwise.",
    }),
    steps: t.field({ type: [StepRef], resolve: (s) => s.steps }),
    servers: t.field({
      type: [StatusServerRef],
      description: "The server map the move was started with.",
      resolve: (s) => s.servers,
    }),
    workloads: t.field({
      type: [StatusWorkloadRef],
      description: "Listed once the database copy lands.",
      resolve: (s) => s.workloads,
    }),
    peerUrl: t.exposeString("peerUrl", {
      description: "The old Deplo's address.",
    }),
    setupPath: t.exposeString("setupPath", {
      nullable: true,
      description:
        "After a cancel that left this Deplo without an account: the link that sets it up again.",
    }),
    rowsCopied: t.exposeInt("rowsCopied"),
    unreadable: t.exposeInt("unreadable", {
      description:
        "Saved secrets the old Deplo could not open. They came across as they were and have to be entered again.",
    }),
    createdAt: t.exposeString("createdAt"),
    finishedAt: t.exposeString("finishedAt", { nullable: true }),
    canRetry: t.exposeBoolean("canRetry"),
    canCancel: t.exposeBoolean("canCancel", {
      description:
        "Until the move is done, even while it runs: the old Deplo starts what it paused, and this Deplo goes back to setup. Once the copy landed, only for an instance admin.",
    }),
    canFinishWithoutSource: t.exposeBoolean("canFinishWithoutSource", {
      description:
        "The copy landed and the move stopped, and the viewer is an instance admin, so it can finish without the old Deplo. finishDeploMoveWithoutSource still refuses while the old Deplo answers.",
    }),
    canSkip: t.exposeBoolean("canSkip", {
      description:
        "An app or database failed and the viewer is an instance admin: skipDeploMoveWorkload leaves it out so the rest finishes.",
    }),
    needsAdminSignIn: t.exposeBoolean("needsAdminSignIn", {
      description:
        "The copy landed, so cancelling, finishing or skipping needs an instance admin signed in here, and the viewer is not one.",
    }),
  }),
});

builder.queryFields((t) => ({
  sourceMove: t.field({
    type: SourceMoveRef,
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "This Deplo's move to another machine, or null when there is none (an unused code that expired counts as none).",
    resolve: () => sourceMoveStatus(),
  }),
  targetMove: t.string({
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "The id of the move into this Deplo that is still open, or null. deploMoveStatus reads it.",
    resolve: () => currentTargetMove(),
  }),
  deploMoveReadiness: t.field({
    type: ReadinessRef,
    authScopes: { instanceAdmin: true },
    resolve: () => targetMoveReadiness(),
  }),
  deploMoveStatus: t.field({
    type: StatusRef,
    nullable: true,
    description:
      "Public on purpose: the id is unguessable and the copy signs everyone out, so the progress page cannot lean on a session. Null for an unknown id.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => moveStatus(id),
  }),
}));

builder.mutationFields((t) => ({
  createMoveCode: t.field({
    type: MoveCodeRef,
    authScopes: { instanceAdmin: true },
    description:
      "Mint the code that lets a new Deplo copy this one onto its machine. Replaces an unused or finished code; refused while a copy runs.",
    resolve: () => createMoveCode(),
  }),
  cancelMoveCode: t.boolean({
    authScopes: { instanceAdmin: true },
    description:
      "Withdraw the move code, or stop a copy in progress: every app paused for it starts again here. A finished copy has nothing to cancel.",
    resolve: async () => {
      await cancelMoveCode();
      return true;
    },
  }),
  connectDeploMove: t.field({
    type: PreviewRef,
    authScopes: { instanceAdmin: true },
    description:
      "Reach the old Deplo with its move code and preview the move. Changes nothing on either side; only a fresh Deplo can receive one.",
    args: {
      url: t.arg.string({
        required: true,
        description: "The old Deplo's https address.",
      }),
      code: t.arg.string({ required: true }),
    },
    resolve: (_r, { url, code }) => connectMove({ url, code }),
  }),
  startDeploMove: t.field({
    type: StatusRef,
    authScopes: { instanceAdmin: true },
    description:
      "Start a connected move: everything here is replaced by a copy of the old Deplo, then each app and database is deployed on its mapped server and filled with its data. The old Deplo keeps running.",
    args: {
      id: t.arg.string({ required: true }),
      map: t.arg({
        type: [ServerMapInput],
        required: false,
        description:
          "Where each old server lands here. Every one but a migration source needs a server here, and one holding apps or databases needs one that runs apps.",
      }),
    },
    resolve: (_r, { id, map }) =>
      startMove(
        id,
        (map ?? []).map((m) => ({ from: m.from, to: m.to ?? null })),
      ),
  }),
  retryDeploMove: t.field({
    type: StatusRef,
    description:
      "Resume a failed move: the copy again if it never landed, else every app or database not copied yet. Public by the move's unguessable id, like its progress page.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => retryMove(id),
  }),
  cancelDeploMove: t.field({
    type: StatusRef,
    description:
      "Abandon a move any time before it is done, even while it runs: the old Deplo starts what it paused, what the move deployed here is removed and this Deplo goes back to setup. Public by the move's id until the copy lands; after that, for an instance admin only.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => cancelMove(id),
  }),
  finishDeploMoveWithoutSource: t.field({
    type: StatusRef,
    description:
      "Finish a stopped move when the old Deplo is gone for good: every app or database whose data never came across is left out, not deployed. Refused while the old Deplo answers. For an instance admin only: it runs after the copy landed.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => finishMoveWithoutSource(id),
  }),
  skipDeploMoveWorkload: t.field({
    type: StatusRef,
    authScopes: { instanceAdmin: true },
    description:
      "Leave out an app or database that failed to copy, so the move can finish without it. It stays in this Deplo, stopped and without its data; once nothing else is left, the move finishes.",
    args: {
      id: t.arg.string({ required: true }),
      kind: t.arg({ type: DeploMoveWorkloadKindEnum, required: true }),
      workloadId: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, kind, workloadId }) =>
      skipMoveWorkload(id, kind, workloadId),
  }),
  resumeMoveSchedules: t.boolean({
    authScopes: { instanceAdmin: true },
    description:
      "Turn on the cron jobs and backup schedules a Deplo move left paused here, so they never run on both Deplos at once.",
    resolve: async () => {
      await resumeMoveSchedules();
      return true;
    },
  }),
}));
