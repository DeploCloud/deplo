import { builder } from "../../builder";
import { AppRef } from "./app-object";
import {
  findAppSummaryBySlugForTeam,
  summarizeForTeam,
} from "@/lib/data/apps/listing";
import type { AppSummary } from "@/lib/data/apps/summary";
import { pubSub, APP_ACTIVITY_TOPIC } from "../../pubsub";
import { countActiveDeploymentsForTeam } from "@/lib/data/deployments/deployment-queries";

builder.subscriptionType({});

builder.subscriptionFields((t) => ({
  appStatus: t.field({
    type: AppRef,
    description:
      "Emits the app whenever its status (power / deployment) changes. " +
      "Fires once immediately with the current snapshot, then on every change.",
    authScopes: { loggedIn: true },
    args: { slug: t.arg.string({ required: true }) },
    subscribe: (_root, { slug }, ctx) =>
      appStatusStream(slug, ctx.teamId, ctx.viewer?.id ?? null),
    resolve: (project) => project,
  }),
  activeDeployments: t.int({
    description:
      "Emits how many deployments are in flight (queued or building) across the active team, counting only the apps the caller can reach. Fires once immediately, then on every change - it is what the sidebar's live chip reads.",
    authScopes: { loggedIn: true },
    subscribe: (_root, _args, ctx) =>
      activeDeploymentsStream(ctx.teamId, ctx.viewer?.id ?? null),
    resolve: (count) => count,
  }),
}));

export async function* activeDeploymentsStream(
  teamId: string | null,
  userId: string | null,
): AsyncGenerator<number> {
  if (!teamId || !userId) throw new Error("Not signed in");
  let last = await countActiveDeploymentsForTeam(teamId, userId);
  yield last;
  for await (const changedId of pubSub.subscribe(
    "appActivity",
    APP_ACTIVITY_TOPIC,
  )) {
    void changedId;
    const next = await countActiveDeploymentsForTeam(teamId, userId);
    if (next === last) continue;
    last = next;
    yield next;
  }
}

// teamId/userId are passed in: cookies() is not callable across an SSE stream's iteration ticks.
export async function* appStatusStream(
  slug: string,
  teamId: string | null,
  userId: string | null,
): AsyncGenerator<AppSummary> {
  if (!teamId || !userId) throw new Error("App not found");
  const project = await findAppSummaryBySlugForTeam(slug, teamId, userId);
  if (!project) throw new Error("App not found");
  const appId = project.id;

  yield project;

  for await (const changedId of pubSub.subscribe("appChanged", appId)) {
    const next = await summarizeForTeam(changedId, teamId, userId);
    if (!next) return;
    yield next;
  }
}
