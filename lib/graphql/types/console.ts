import { builder } from "../builder";
import {
  getConsoleInfo,
  getLogsInfo,
  getShellLabel,
  getAppRuntime,
  execInContainer,
  type ConsoleInfo,
  type LogsInfo,
  type ConsoleInstance,
  type AppRuntime,
  type RuntimeContainer,
} from "@/lib/data/console";

/**
 * GraphQL surface for the real container console: read the attachable instances
 * for an app, probe the default container's shell label, and exec a command
 * inside the live container. All resolvers are thin wrappers over the data layer,
 * which enforces team-scoping (reads) and the `deploy` capability (exec).
 */

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const ConsoleInstanceRef = builder
  .objectRef<ConsoleInstance>("ConsoleInstance")
  .implement({
    description: "A single attachable container in an app's stack.",
    fields: (t) => ({
      name: t.exposeString("name"),
      service: t.exposeString("service"),
      image: t.exposeString("image"),
      running: t.exposeBoolean("running"),
      exposed: t.exposeBoolean("exposed"),
      user: t.exposeString("user"),
      workdir: t.exposeString("workdir"),
      openStdin: t.exposeBoolean("openStdin"),
      tty: t.exposeBoolean("tty"),
    }),
  });

const ConsoleInfoRef = builder.objectRef<ConsoleInfo>("ConsoleInfo").implement({
  description:
    "Console attach info for an app (no shell probe — fetch the shell " +
    "label separately via shellLabel).",
  fields: (t) => ({
    containerName: t.exposeString("containerName"),
    image: t.exposeString("image"),
    running: t.exposeBoolean("running"),
    instances: t.field({
      type: [ConsoleInstanceRef],
      resolve: (c) => c.instances,
    }),
  }),
});

const LogsInfoRef = builder.objectRef<LogsInfo>("LogsInfo").implement({
  description: "Lighter container list for the logs viewer (no shell probe).",
  fields: (t) => ({
    running: t.exposeBoolean("running"),
    streamable: t.exposeBoolean("streamable", {
      description:
        "A real container exists on the host, so its logs can be streamed — " +
        "whether it is running, restarting or exited. Attach on this, not on " +
        "`running`: a crash-looping container is the one whose logs you need.",
    }),
    unreachable: t.exposeBoolean("unreachable", {
      description: "The owning server's agent could not be reached.",
    }),
    instances: t.field({
      type: [ConsoleInstanceRef],
      resolve: (l) => l.instances,
    }),
  }),
});

const RuntimeContainerRef = builder
  .objectRef<RuntimeContainer>("RuntimeContainer")
  .implement({
    description: "One container of an app, as the host actually has it now.",
    fields: (t) => ({
      name: t.exposeString("name"),
      service: t.exposeString("service"),
      state: t.exposeString("state", {
        description:
          'Raw docker state ("running" | "restarting" | "exited" | …), or "" ' +
          "when the owning agent is too old to report it.",
      }),
      running: t.exposeBoolean("running"),
      exposed: t.exposeBoolean("exposed"),
    }),
  });

const AppRuntimeRef = builder.objectRef<AppRuntime>("AppRuntime").implement({
  description:
    "What an app's containers are ACTUALLY doing on the host, read live from " +
    "the owning agent. `App.status` only records the last thing the control " +
    "plane asked for (deploy / start / stop), so it keeps saying 'active' for " +
    "an app that has been crash-looping since its deploy succeeded.",
  fields: (t) => ({
    total: t.exposeInt("total"),
    running: t.exposeInt("running"),
    restarting: t.exposeInt("restarting"),
    missing: t.exposeStringList("missing", {
      description:
        "Declared services with NO container on the host — the failure the " +
        "running/total counts cannot see, because a container that was never " +
        "created is not there to be counted as stopped.",
    }),
    unreachable: t.exposeBoolean("unreachable", {
      description: "The agent did not answer: the counts are unknown, not zero.",
    }),
    containers: t.field({
      type: [RuntimeContainerRef],
      resolve: (r) => r.containers,
    }),
  }),
});

/** Result of running a command in the live container. */
interface ExecResult {
  output: string;
  detach?: boolean;
}

const ExecResultRef = builder.objectRef<ExecResult>("ExecResult").implement({
  description: "Output of an exec'd console command.",
  fields: (t) => ({
    output: t.exposeString("output"),
    detach: t.exposeBoolean("detach", { nullable: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const ShellLabelInputType = builder.inputType("ShellLabelInput", {
  fields: (t) => ({
    appId: t.string({ required: true }),
    // Optional explicit instance to probe; default = the running/default target.
    containerName: t.string({ required: false }),
  }),
});

const ExecConsoleInputType = builder.inputType("ExecConsoleInput", {
  fields: (t) => ({
    appId: t.string({ required: true }),
    command: t.string({ required: true }),
    // Optional explicit instance to exec into; default = the default target.
    containerName: t.string({ required: false }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  consoleInfo: t.field({
    type: ConsoleInfoRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Attachable instances + default target for an app's console.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getConsoleInfo(appId),
  }),
  logsInfo: t.field({
    type: LogsInfoRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Lighter instance list for the logs viewer.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getLogsInfo(appId),
  }),
  appRuntime: t.field({
    type: AppRuntimeRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description:
      "Live container state for an app, straight from the owning agent — the " +
      "truth behind the stored status. Polled by the app's status badge.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => getAppRuntime(appId),
  }),
  shellLabel: t.field({
    type: "String",
    authScopes: { loggedIn: true },
    description:
      'The default (or chosen) container\'s shell label, e.g. "/bin/sh" or ' +
      '"raw exec (no shell)".',
    args: { input: t.arg({ type: ShellLabelInputType, required: true }) },
    resolve: (_r, { input }) =>
      getShellLabel(input.appId, input.containerName ?? undefined),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  execConsole: t.field({
    type: ExecResultRef,
    authScopes: { capability: "deploy" },
    description:
      "Run a command in the app's live container (docker exec). Gated on " +
      "the deploy capability — this is arbitrary code execution.",
    args: { input: t.arg({ type: ExecConsoleInputType, required: true }) },
    resolve: (_r, { input }) =>
      execInContainer(
        input.appId,
        input.command,
        input.containerName ?? undefined,
      ),
  }),
}));
