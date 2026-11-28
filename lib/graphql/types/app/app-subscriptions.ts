import { builder } from "../../builder";
import { AppRef } from "./app-object";
import {
  findAppSummaryBySlugForTeam,
  summarizeForTeam,
} from "@/lib/data/apps/listing";
import type { AppSummary } from "@/lib/data/apps/summary";
import { pubSub, APP_ACTIVITY_TOPIC, type TeamChangeKind } from "../../pubsub";
import { Repeater } from "@graphql-yoga/subscription";
import { liveKeys, liveStream } from "../../live-stream";
import { countActiveDeploymentsForTeam } from "@/lib/data/deployments/deployment-queries";

builder.subscriptionType({});

export interface ShellPulse {
  activeDeployments: number;
  changed: TeamChangeKind | null;
  changedBy: string | null;
}

const ShellPulseRef = builder.objectRef<ShellPulse>("ShellPulse").implement({
  description:
    "What the dashboard shell follows on its one stream: the in-flight deployment count, and a note whenever something in the active team changed.",
  fields: (t) => ({
    activeDeployments: t.exposeInt("activeDeployments", {
      description:
        "Deployments queued or building across the active team, counting only the apps the caller can reach.",
    }),
    changed: t.exposeString("changed", {
      nullable: true,
      description:
        'Set when the team changed: "activity" (someone\'s action or a finished deploy), "backup" or "cron" (a run started or ended). Null when only the count moved.',
    }),
    changedBy: t.exposeString("changedBy", {
      nullable: true,
      description:
        "The user whose action it was, when a person made the change.",
    }),
  }),
});

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
  appsStatus: t.field({
    type: AppRef,
    description:
      "appStatus for a whole list on one stream: emits each app once, then " +
      "again whenever one of them changes. A slug the caller cannot reach is skipped.",
    authScopes: { loggedIn: true },
    args: { slugs: t.arg.stringList({ required: true }) },
    subscribe: (_root, { slugs }, ctx) =>
      appsStatusStream(slugs, ctx.teamId, ctx.viewer?.id ?? null),
    resolve: (project) => project,
  }),
  shellPulse: t.field({
    type: ShellPulseRef,
    description:
      "Fires once with the in-flight deployment count, then whenever that count moves or something in the active team changes. One stream per open dashboard tab.",
    authScopes: { loggedIn: true },
    subscribe: (_root, _args, ctx) =>
      shellPulseStream(ctx.teamId, ctx.viewer?.id ?? null),
    resolve: (pulse) => pulse,
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

export function activeDeploymentsStream(
  teamId: string | null,
  userId: string | null,
) {
  return liveStream(async function* (track): AsyncGenerator<number> {
    if (!teamId || !userId) throw new Error("Not signed in");
    let last = await countActiveDeploymentsForTeam(teamId, userId);
    yield last;
    for await (const changedId of track(
      pubSub.subscribe("appActivity", APP_ACTIVITY_TOPIC),
    )) {
      void changedId;
      const next = await countActiveDeploymentsForTeam(teamId, userId);
      if (next === last) continue;
      last = next;
      yield next;
    }
  });
}

const CHANGE_KINDS: readonly TeamChangeKind[] = ["activity", "backup", "cron"];

async function* tagged<T>(source: AsyncIterable<string>, tag: T) {
  for await (const payload of source) yield { tag, payload };
}

// A team change costs no query: only the deploy count is read again, and only when a deploy moved.
export function shellPulseStream(teamId: string | null, userId: string | null) {
  return liveStream(async function* (track): AsyncGenerator<ShellPulse> {
    if (!teamId || !userId) throw new Error("Not signed in");
    let count = await countActiveDeploymentsForTeam(teamId, userId);
    yield { activeDeployments: count, changed: null, changedBy: null };
    const events = Repeater.merge([
      tagged(
        track(pubSub.subscribe("appActivity", APP_ACTIVITY_TOPIC)),
        "deploy" as const,
      ),
      tagged(track(pubSub.subscribe("teamChanged", teamId)), "team" as const),
    ]);
    for await (const { tag, payload } of events) {
      if (tag === "deploy") {
        const next = await countActiveDeploymentsForTeam(teamId, userId);
        if (next === count) continue;
        count = next;
        yield { activeDeployments: count, changed: null, changedBy: null };
        continue;
      }
      const change = parseTeamChange(payload);
      if (change)
        yield {
          activeDeployments: count,
          changed: change.k,
          changedBy: change.a,
        };
    }
  });
}

function parseTeamChange(
  raw: string,
): { k: TeamChangeKind; a: string | null } | null {
  try {
    const m = JSON.parse(raw) as { k?: unknown; a?: unknown };
    if (!CHANGE_KINDS.includes(m.k as TeamChangeKind)) return null;
    return {
      k: m.k as TeamChangeKind,
      a: typeof m.a === "string" ? m.a : null,
    };
  } catch {
    return null;
  }
}

// teamId/userId are passed in: cookies() is not callable across an SSE stream's iteration ticks.
export function appStatusStream(
  slug: string,
  teamId: string | null,
  userId: string | null,
) {
  return liveStream(async function* (track): AsyncGenerator<AppSummary> {
    if (!teamId || !userId) throw new Error("App not found");
    const project = await findAppSummaryBySlugForTeam(slug, teamId, userId);
    if (!project) throw new Error("App not found");
    const appId = project.id;

    yield project;

    for await (const changedId of track(
      pubSub.subscribe("appChanged", appId),
    )) {
      const next = await summarizeForTeam(changedId, teamId, userId);
      if (!next) return;
      yield next;
    }
  });
}

export function appsStatusStream(
  slugs: readonly string[],
  teamId: string | null,
  userId: string | null,
) {
  return liveStream(async function* (track): AsyncGenerator<AppSummary> {
    if (!teamId || !userId) throw new Error("App not found");
    const found: string[] = [];
    for (const slug of liveKeys(slugs)) {
      const project = await findAppSummaryBySlugForTeam(slug, teamId, userId);
      if (!project) continue;
      found.push(project.id);
      yield project;
    }
    if (found.length === 0) return;

    const changes = found.map((id) =>
      track(pubSub.subscribe("appChanged", id)),
    );
    for await (const changedId of Repeater.merge(changes)) {
      const next = await summarizeForTeam(changedId, teamId, userId);
      if (next) yield next;
    }
  });
}
