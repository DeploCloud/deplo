import { builder } from "../../builder";
import {
  listServerWorkloads,
  type ServerWorkload,
  type WorkloadContainer,
} from "@/lib/data/servers/workloads";

const WorkloadContainerRef = builder
  .objectRef<WorkloadContainer>("WorkloadContainer")
  .implement({
    description: "One container of an app or database, from the live stream.",
    fields: (t) => ({
      name: t.exposeString("name"),
      state: t.exposeString("state", {
        description: 'Docker\'s state: "running", "restarting", "exited", ...',
      }),
      health: t.exposeString("health", {
        description:
          '"healthy", "unhealthy" or "starting"; empty when the image has no healthcheck.',
      }),
      cpu: t.exposeFloat("cpu", { description: "Percent, like docker stats." }),
      memUsed: t.exposeFloat("memUsed", { description: "Bytes." }),
      restartCount: t.exposeInt("restartCount"),
    }),
  });

const ServerWorkloadRef = builder
  .objectRef<ServerWorkload>("ServerWorkload")
  .implement({
    description:
      "An app or database placed on a server, with its live status and usage.",
    fields: (t) => ({
      id: t.exposeID("id"),
      kind: t.exposeString("kind", { description: '"app" or "database".' }),
      name: t.exposeString("name"),
      logo: t.exposeString("logo", { nullable: true }),
      logoTone: t.exposeString("logoTone", { nullable: true }),
      engine: t.exposeString("engine", {
        nullable: true,
        description: 'A database\'s engine ("postgres"); null for an app.',
      }),
      teamName: t.exposeString("teamName"),
      href: t.exposeString("href", {
        nullable: true,
        description:
          "Its page, or null when the viewer is not in the owning team.",
      }),
      project: t.exposeString("project", { nullable: true }),
      environment: t.exposeString("environment", { nullable: true }),
      status: t.exposeString("status", {
        description:
          "The live status shown on its badge: active, restarting, unhealthy, down, idle, error, ...",
      }),
      cpu: t.exposeFloat("cpu", { nullable: true }),
      memUsed: t.exposeFloat("memUsed", { nullable: true }),
      restarts: t.exposeInt("restarts"),
      containers: t.field({
        type: [WorkloadContainerRef],
        resolve: (w) => w.containers,
      }),
    }),
  });

builder.queryFields((t) => ({
  serverWorkloads: t.field({
    type: [ServerWorkloadRef],
    authScopes: { instanceAdmin: true },
    description:
      "Every team's apps and databases on one server, with live status and usage. Instance admins only.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => listServerWorkloads(id),
  }),
}));
