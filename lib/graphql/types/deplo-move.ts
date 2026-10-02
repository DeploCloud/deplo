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
  startMove,
  targetMoveReadiness,
  type MovePreviewServer,
  type MoveStatus,
  type MoveStatusServer,
  type TargetMovePreview,
} from "@/lib/data/deplo-move/target";

// ADR-0035. The move code itself never authenticates anything here: only /api/deplo-move/* reads it.

const SourceMoveStateEnum = builder.enumType("SourceMoveState", {
  description:
    "armed = a move code waits for the new Deplo. bound = a new Deplo connected with it; nothing is paused yet. frozen = changes are paused while the new Deplo copies and takes the servers over. moved = every server answers to the new Deplo, for good.",
  values: ["armed", "bound", "frozen", "moved"] as const,
});

const DeploMoveStateEnum = builder.enumType("DeploMoveState", {
  description:
    "connected = the old Deplo answered and the preview is ready. copying = its data is being copied here. handing_over = its servers are switching to this Deplo. done = finished. failed = stopped, with `error` saying why; retry resumes. cancelled = abandoned before any server was handed over.",
  values: [
    "connected",
    "copying",
    "handing_over",
    "done",
    "failed",
    "cancelled",
  ] as const,
});

const DeploMoveStepKeyEnum = builder.enumType("DeploMoveStepKey", {
  description:
    "copy = every team, account, app and setting. servers = each server switches to this Deplo. finish = the old Deplo is told where everything went.",
  values: ["copy", "servers", "finish"] as const,
});

const DeploMoveStepStateEnum = builder.enumType("DeploMoveStepState", {
  values: ["waiting", "running", "done", "failed"] as const,
});

const DeploMoveServerStateEnum = builder.enumType("DeploMoveServerState", {
  values: ["waiting", "handed_over", "failed"] as const,
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
          "The `dmove_…` code to paste on the new Deplo. It lets that Deplo read every secret and take every server over, so treat it like the keys to the whole instance.",
      }),
      expiresAt: t.exposeString("expiresAt", {
        description:
          "When the code stops working if no new Deplo has used it. Once used, it lives until the move ends.",
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
          "Set only while the code is armed: a bound code lives until the move ends.",
      }),
      handedOver: t.exposeInt("handedOver", {
        description: "Servers that already answer to the new Deplo.",
      }),
      servers: t.exposeInt("servers", {
        description: "Servers that have to be handed over in all.",
      }),
      startedBy: t.exposeString("startedBy"),
      createdAt: t.exposeString("createdAt"),
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

const PreviewServerRef = builder
  .objectRef<MovePreviewServer>("DeploMovePreviewServer")
  .implement({
    description: "One of the old Deplo's servers, as a move would take it.",
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name"),
      address: t.exposeString("address"),
      port: t.exposeInt("port", { nullable: true }),
      role: t.field({ type: DeploMoveServerRoleEnum, resolve: (s) => s.role }),
      isPanelHost: t.exposeBoolean("isPanelHost", {
        description:
          "The machine the old Deplo itself runs on. It is handed over last and its apps keep running.",
      }),
      enrolled: t.exposeBoolean("enrolled", {
        description:
          "False for a server that never finished connecting: it is copied as it is, with nothing to hand over.",
      }),
      agentVersion: t.exposeString("agentVersion", { nullable: true }),
      apps: t.exposeInt("apps"),
      databases: t.exposeInt("databases"),
      problem: t.exposeString("problem", {
        nullable: true,
        description:
          "What keeps this server from being handed over, in one sentence. The move cannot start while any server has one.",
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
      problems: t.exposeStringList("problems", {
        description:
          "Everything that blocks the move, each naming its server. startDeploMove refuses while any remains.",
      }),
      warnings: t.exposeStringList("warnings", {
        description: "Worth knowing, never blocking.",
      }),
      canStart: t.exposeBoolean("canStart"),
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
    description: "One server's handover.",
    fields: (t) => ({
      id: t.exposeString("id"),
      name: t.exposeString("name"),
      state: t.field({
        type: DeploMoveServerStateEnum,
        resolve: (s) => s.state,
      }),
      error: t.exposeString("error", {
        description:
          "Why it failed; on a handed-over server, a note that this Deplo cannot reach it yet. Empty otherwise.",
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
    servers: t.field({ type: [StatusServerRef], resolve: (s) => s.servers }),
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
        "Until the first server is handed over. After that a move only goes forward.",
    }),
    canFinishWithoutSource: t.exposeBoolean("canFinishWithoutSource", {
      description:
        "The copy landed and the move stopped, so it can finish without the old Deplo. finishDeploMoveWithoutSource still refuses while the old Deplo answers.",
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
      "Mint the code that lets a new Deplo move this one onto its machine. Replaces an unused code; refused once a move has paused this Deplo.",
    resolve: () => createMoveCode(),
  }),
  cancelMoveCode: t.boolean({
    authScopes: { instanceAdmin: true },
    description:
      "Withdraw the move code and resume changes here. Refused once a server answers to the new Deplo, unless `force` is set.",
    args: {
      force: t.arg.boolean({
        required: false,
        description:
          "Resume even though servers already answer to the new Deplo, for when that one is gone. Those servers must be added here again. Refused once the move finished.",
      }),
    },
    resolve: async (_r, { force }) => {
      await cancelMoveCode({ force: force ?? false });
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
      "Start a connected move: the old Deplo pauses, everything here is replaced by its data, then its servers are handed over.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => startMove(id),
  }),
  retryDeploMove: t.field({
    type: StatusRef,
    description:
      "Resume a failed move where it stopped. Public by the move's unguessable id, like its progress page.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => retryMove(id),
  }),
  cancelDeploMove: t.field({
    type: StatusRef,
    description:
      "Abandon a move before any server is handed over: the old Deplo resumes and anything copied here is removed. Public by the move's id.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => cancelMove(id),
  }),
  finishDeploMoveWithoutSource: t.field({
    type: StatusRef,
    description:
      "Finish a stopped move when the old Deplo is gone for good: servers not handed over yet stay with it and have to be added here again. Refused while the old Deplo answers. Public by the move's id.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => finishMoveWithoutSource(id),
  }),
}));
