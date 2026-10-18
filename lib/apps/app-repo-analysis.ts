import "server-only";

import { requireAppCapability } from "../data/node-access";
import { loadAppGraph } from "../data/app-graph-load";
import type { App } from "../types/app";
import { analyzeRepoForMember, type AnalysisRequest } from "./deplopack";
import { isDeplopackDetection } from "./deplopack-types";

export function appRepoAnalysisInput(app: App): AnalysisRequest {
  if (
    !["git", "github"].includes(app.source) ||
    app.repo?.provider !== "github" ||
    app.composePath ||
    !app.serverId
  )
    throw new Error("DeploPacks BETA requires an app with a GitHub repository");
  return {
    repo: app.repo.repo,
    branch: app.repo.branch,
    installationId: app.repo.installationId,
    connectionId: app.repo.connectionId,
    serverId: app.serverId,
    buildServerId: app.buildServerId,
    rootDirectory: app.build.rootDirectory,
  };
}

export async function analyzeAppRepo(id: string) {
  const { membership, userId } = await requireAppCapability(
    id,
    "configure_apps",
  );
  const app = await loadAppGraph(id);
  if (!app || app.teamId !== membership.teamId)
    throw new Error("App not found");
  const analysis = await analyzeRepoForMember(
    appRepoAnalysisInput(app),
    membership.teamId,
    userId,
  );
  return {
    ...analysis,
    result: {
      ...analysis.result,
      detections: analysis.result.detections.filter(isDeplopackDetection),
    },
  };
}
