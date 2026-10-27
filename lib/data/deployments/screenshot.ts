import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { cache } from "react";

import { CaptureOutcome } from "../../agent/gen/agent";
import { getCurrentUser } from "../../auth/current-user";
import {
  captureDeploymentScreenshot,
  isLiveDeployment,
  type CaptureResult,
} from "../../deploy/build/screenshot";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  deploymentScreenshots,
  deployments,
} from "../../db/schema/control-plane/deployments";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { requireActiveTeamId } from "../../membership";
import { recordActivity } from "../activity";
import { appInTeam } from "../app-graph-load";
import { appCapabilities, requireAppCapability } from "../node-access";

export type ScreenshotTheme = "light" | "dark";

export interface DeploymentScreenshot {
  deploymentId: string;
  capturedAt: string;
  lightUrl: string;
  darkUrl: string | null;
  // The deployment its URL serves today, so the picture can be taken again.
  current: boolean;
}

// Only a routing key for the image route, which then runs every gate under that team.
export async function deploymentTeamId(id: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ teamId: appsTable.teamId })
    .from(deployments)
    .innerJoin(appsTable, eq(appsTable.id, deployments.appId))
    .where(eq(deployments.id, id))
    .limit(1);
  return row?.teamId ?? null;
}

// Same answer for "no such deployment" and "not yours", as getDeployment gives.
async function visibleDeployment(
  id: string,
): Promise<{ appId: string } | null> {
  const teamId = await requireActiveTeamId();
  const [dep] = await getDb()
    .select({ appId: deployments.appId })
    .from(deployments)
    .where(eq(deployments.id, id))
    .limit(1);
  if (!dep || !(await appInTeam(dep.appId, teamId))) return null;
  if ((await appCapabilities(dep.appId)).length === 0) return null;
  return dep;
}

export const getDeploymentScreenshot = cache(
  async function getDeploymentScreenshot(
    id: string,
  ): Promise<DeploymentScreenshot | null> {
    if (!(await visibleDeployment(id))) return null;
    const [row] = await getDb()
      .select({
        capturedAt: deploymentScreenshots.capturedAt,
        hasDark: sql<boolean>`${deploymentScreenshots.dark} is not null`,
      })
      .from(deploymentScreenshots)
      .where(eq(deploymentScreenshots.deploymentId, id))
      .limit(1);
    if (!row) return null;
    const base = `/api/deployments/${id}/screenshot?v=${Date.parse(row.capturedAt)}`;
    return {
      deploymentId: id,
      capturedAt: row.capturedAt,
      lightUrl: `${base}&theme=light`,
      darkUrl: row.hasDark ? `${base}&theme=dark` : null,
      current: await isLiveDeployment(id),
    };
  },
);

// The newest production picture: a redeploy keeps the last one up until its own lands.
export async function getAppCoverScreenshot(
  appId: string,
): Promise<DeploymentScreenshot | null> {
  const [row] = await getDb()
    .select({ id: deployments.id })
    .from(deploymentScreenshots)
    .innerJoin(
      deployments,
      eq(deployments.id, deploymentScreenshots.deploymentId),
    )
    .where(
      and(
        eq(deployments.appId, appId),
        eq(deployments.environment, "production"),
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deployments.seq))
    .limit(1);
  return row ? getDeploymentScreenshot(row.id) : null;
}

// For a Deployment that was already authorized: the parent object is the gate.
export async function screenshotCapturedAt(id: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ capturedAt: deploymentScreenshots.capturedAt })
    .from(deploymentScreenshots)
    .where(eq(deploymentScreenshots.deploymentId, id))
    .limit(1);
  return row?.capturedAt ?? null;
}

export async function readDeploymentScreenshotImage(
  id: string,
  theme: ScreenshotTheme,
): Promise<Buffer | null> {
  if (!(await visibleDeployment(id))) return null;
  const [row] = await getDb()
    .select({
      light: deploymentScreenshots.light,
      dark: deploymentScreenshots.dark,
    })
    .from(deploymentScreenshots)
    .where(eq(deploymentScreenshots.deploymentId, id))
    .limit(1);
  if (!row) return null;
  return theme === "dark" && row.dark ? row.dark : row.light;
}

function refusal(res: Exclude<CaptureResult, { kind: "stored" }>): string {
  if (res.kind === "skipped") {
    switch (res.reason) {
      case "off":
        return "Screenshots are turned off for this app.";
      case "old-agent":
        return "This app's server needs a newer Deplo agent to take screenshots.";
      case "fork":
        return "A pull request from a fork is never photographed behind basic auth.";
      case "no-url":
        return "This deployment has no address to open.";
      case "frozen":
        return "This Deplo is being moved; try again once the move is done.";
      default:
        return "Only the deployment that is live can be photographed again.";
    }
  }
  switch (res.outcome) {
    case CaptureOutcome.CAPTURE_OUTCOME_HTTP_ERROR:
      return `The site answered with an error (${res.status}).`;
    case CaptureOutcome.CAPTURE_OUTCOME_BLANK:
      return "The page came out blank.";
    case CaptureOutcome.CAPTURE_OUTCOME_TIMEOUT:
      return "The site took too long to load.";
    default:
      return "The site could not be reached.";
  }
}

// Waits for the picture, so a failure comes back with its reason; the old picture stays meanwhile.
export async function retakeDeploymentScreenshot(id: string): Promise<void> {
  const [dep] = await getDb()
    .select({ appId: deployments.appId, appName: appsTable.name })
    .from(deployments)
    .innerJoin(appsTable, eq(appsTable.id, deployments.appId))
    .where(eq(deployments.id, id))
    .limit(1);
  if (!dep) throw new Error("Deployment not found");
  await requireAppCapability(dep.appId, "configure_apps");
  const user = (await getCurrentUser())!;
  let res: CaptureResult;
  try {
    res = await captureDeploymentScreenshot(id);
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      throw new Error(
        "The app's server is not answering, so no screenshot could be taken.",
      );
    // The agent words its refusals for people (a busy server, no disk); show them without the gRPC prefix.
    const details = (e as { details?: unknown }).details;
    if (typeof details === "string" && details) throw new Error(details);
    throw e;
  }
  if (res.kind !== "stored") throw new Error(refusal(res));
  await recordActivity(
    "app",
    `Retook the screenshot of ${dep.appName}`,
    user.name,
    dep.appId,
  );
}
