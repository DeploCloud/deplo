import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps } from "../db/schema/control-plane/apps";
import { clusters } from "../db/schema/control-plane/clusters";
import { cronJobs } from "../db/schema/control-plane/crons";
import { databases } from "../db/schema/control-plane/databases";
import { appPreviews } from "../db/schema/control-plane/deployments";
import { domains } from "../db/schema/control-plane/domains";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { getCurrentUser } from "../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { nowIso } from "../ids";
import { cache } from "../request-cache";
import {
  EXPERIMENT_META,
  EXPERIMENTS,
  NO_EXPERIMENTS,
  experimentOffMessage,
  type ExperimentFlags,
  type ExperimentKey,
} from "../experiments";
import { recordActivity } from "./activity";
import { SETTINGS_ID } from "./instance-settings/settings-store";

const COLUMN = {
  crons: "experimentCrons",
  zeroDowntime: "experimentZeroDowntime",
  pullRequests: "experimentPullRequests",
  clusters: "experimentClusters",
  tunnels: "experimentTunnels",
} as const satisfies Record<
  ExperimentKey,
  keyof typeof instanceSettings.$inferSelect
>;

async function readExperiments(): Promise<ExperimentFlags> {
  const [row] = await getDb()
    .select({
      crons: instanceSettings.experimentCrons,
      zeroDowntime: instanceSettings.experimentZeroDowntime,
      pullRequests: instanceSettings.experimentPullRequests,
      clusters: instanceSettings.experimentClusters,
      tunnels: instanceSettings.experimentTunnels,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return row ?? NO_EXPERIMENTS;
}

/** Every experiment's switch. Read by anyone signed in: menus and gates depend on it. */
export const experiments = cache(readExperiments);

export async function experimentOn(key: ExperimentKey): Promise<boolean> {
  return (await experiments())[key];
}

export async function requireExperiment(key: ExperimentKey): Promise<void> {
  if (!(await experimentOn(key))) throw new Error(experimentOffMessage(key));
}

export interface ExperimentState {
  key: ExperimentKey;
  enabled: boolean;
  // What uses it right now, e.g. "2 apps, 5 jobs"; null when nothing does.
  usage: string | null;
  // Why it cannot be turned off right now.
  lockedOn: string | null;
}

const count = sql<number>`count(*)::int`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const list = (parts: (string | false)[]) =>
  parts.filter(Boolean).join(", ") || null;

async function usageOf(
  key: ExperimentKey,
): Promise<Pick<ExperimentState, "usage" | "lockedOn">> {
  const db = getDb();
  const live = isNull(apps.deletingAt);
  switch (key) {
    case "crons": {
      const [[a], [d], [j]] = await Promise.all([
        db
          .select({ n: count })
          .from(apps)
          .where(and(eq(apps.cronEnabled, true), live)),
        db
          .select({ n: count })
          .from(databases)
          .where(eq(databases.cronEnabled, true)),
        db
          .select({ n: count })
          .from(cronJobs)
          .where(eq(cronJobs.enabled, true)),
      ]);
      if (a.n + d.n === 0) return { usage: null, lockedOn: null };
      return {
        usage: list([
          a.n > 0 && plural(a.n, "app"),
          d.n > 0 && plural(d.n, "database"),
          plural(j.n, "job"),
        ]),
        lockedOn: null,
      };
    }
    case "zeroDowntime": {
      const [a] = await db
        .select({ n: count })
        .from(apps)
        .where(and(eq(apps.zeroDowntimeDeploys, true), live));
      return { usage: a.n > 0 ? plural(a.n, "app") : null, lockedOn: null };
    }
    case "pullRequests": {
      const [[a], [p]] = await Promise.all([
        db
          .select({ n: count })
          .from(apps)
          .where(and(eq(apps.previewEnabled, true), live)),
        db
          .select({ n: count })
          .from(appPreviews)
          .where(isNull(appPreviews.tornDownAt)),
      ]);
      return {
        usage: list([
          a.n > 0 && plural(a.n, "app"),
          p.n > 0 && plural(p.n, "live preview"),
        ]),
        lockedOn: null,
      };
    }
    case "clusters": {
      const rows = await db.select({ name: clusters.name }).from(clusters);
      if (rows.length === 0) return { usage: null, lockedOn: null };
      return {
        usage: plural(rows.length, "cluster"),
        lockedOn:
          rows.length === 1
            ? `Cluster ${rows[0].name} is still there. Delete it to turn this off.`
            : `${rows.length} clusters are still there. Delete them to turn this off.`,
      };
    }
    case "tunnels": {
      const [[s], [d]] = await Promise.all([
        db
          .select({ host: instanceSettings.panelTunnelHostname })
          .from(instanceSettings)
          .where(eq(instanceSettings.id, SETTINGS_ID)),
        db.select({ n: count }).from(domains).where(eq(domains.tunnel, true)),
      ]);
      const panel = Boolean(s?.host);
      if (!panel && d.n === 0) return { usage: null, lockedOn: null };
      return {
        usage: list([panel && "the panel", d.n > 0 && plural(d.n, "domain")]),
        lockedOn: panel
          ? "The panel is still reached through a tunnel. Turn it off in Advanced first."
          : `${plural(d.n, "domain")} still ${d.n === 1 ? "uses" : "use"} a tunnel. Remove ${d.n === 1 ? "it" : "them"} first.`,
      };
    }
  }
}

/** The Experiments tab: every switch with what uses it. Instance admins only. */
export async function listExperimentStates(): Promise<ExperimentState[]> {
  await requireInstanceAdmin();
  const flags = await readExperiments();
  return Promise.all(
    EXPERIMENTS.map(async (key) => ({
      key,
      enabled: flags[key],
      ...(await usageOf(key)),
    })),
  );
}

export async function setExperiment(
  key: ExperimentKey,
  enabled: boolean,
): Promise<ExperimentState> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const usage = await usageOf(key);
  if ((await readExperiments())[key] !== enabled) {
    if (!enabled && usage.lockedOn) throw new Error(usage.lockedOn);
    const now = nowIso();
    const set = { [COLUMN[key]]: enabled, updatedAt: now };
    await getDb()
      .insert(instanceSettings)
      .values({ id: SETTINGS_ID, ...set })
      .onConflictDoUpdate({ target: instanceSettings.id, set });
    const user = (await getCurrentUser())!;
    await recordActivity(
      "instance",
      `Turned ${enabled ? "on" : "off"} the ${EXPERIMENT_META[key].label} experiment`,
      user.name,
      null,
      teamId,
    );
  }
  return { key, enabled, ...usage };
}
