import { builder } from "../builder";
import {
  getConsoleInfo,
  getLogsInfo,
  getShellLabel,
  execInContainer,
  type ConsoleInfo,
  type LogsInfo,
  type ConsoleInstance,
} from "@/lib/data/console";

/**
 * GraphQL surface for the real container console: read the attachable instances
 * for a project, probe the default container's shell label, and exec a command
 * inside the live container. All resolvers are thin wrappers over the data layer,
 * which enforces team-scoping (reads) and the `deploy` capability (exec).
 */

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const ConsoleInstanceRef = builder
  .objectRef<ConsoleInstance>("ConsoleInstance")
  .implement({
    description: "A single attachable container in a project's stack.",
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
    "Console attach info for a project (no shell probe — fetch the shell " +
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
    instances: t.field({
      type: [ConsoleInstanceRef],
      resolve: (l) => l.instances,
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
    serviceId: t.string({ required: true }),
    // Optional explicit instance to probe; default = the running/default target.
    containerName: t.string({ required: false }),
  }),
});

const ExecConsoleInputType = builder.inputType("ExecConsoleInput", {
  fields: (t) => ({
    serviceId: t.string({ required: true }),
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
    description: "Attachable instances + default target for a project's console.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => getConsoleInfo(serviceId),
  }),
  logsInfo: t.field({
    type: LogsInfoRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description: "Lighter instance list for the logs viewer.",
    args: { serviceId: t.arg.string({ required: true }) },
    resolve: (_r, { serviceId }) => getLogsInfo(serviceId),
  }),
  shellLabel: t.field({
    type: "String",
    authScopes: { loggedIn: true },
    description:
      'The default (or chosen) container\'s shell label, e.g. "/bin/sh" or ' +
      '"raw exec (no shell)".',
    args: { input: t.arg({ type: ShellLabelInputType, required: true }) },
    resolve: (_r, { input }) =>
      getShellLabel(input.serviceId, input.containerName ?? undefined),
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
      "Run a command in the project's live container (docker exec). Gated on " +
      "the deploy capability — this is arbitrary code execution.",
    args: { input: t.arg({ type: ExecConsoleInputType, required: true }) },
    resolve: (_r, { input }) =>
      execInContainer(
        input.serviceId,
        input.command,
        input.containerName ?? undefined,
      ),
  }),
}));
