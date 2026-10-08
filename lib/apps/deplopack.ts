import "server-only";

import { requireMembership } from "../membership";
import { listServersForTeam } from "../data/servers/roster";
import { scopeRepoCredentials } from "../data/apps/source-guards";
import { resolveNewAppPlacement } from "../data/apps/placement";
import { resolveCloneUrl } from "../git/clone-url";
import { connectAgent } from "../infra/agent-client/connect";
import { pickBuildServer } from "../deploy/build-server";
import { normalizeRootRel } from "../deploy/source";
import { signState, verifyState } from "../crypto";
import type { BuildConfig } from "../types/build";
import {
  detectionKey,
  type RepoAnalysis,
  type DeplopackOverride,
  type DeplopackDetection,
} from "./deplopack-types";

export interface AnalysisRequest {
  repo: string;
  branch?: string | null;
  installationId?: string | null;
  connectionId?: string | null;
  serverId: string;
  buildServerId?: string | null;
  rootDirectory?: string | null;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}
function binding(input: AnalysisRequest) {
  const root = (input.rootDirectory || ".").replaceAll("\\", "/");
  if (
    root.startsWith("/") ||
    root.split("/").includes("..") ||
    /[\0\r\n]/.test(root)
  )
    throw new Error(
      "Project directory must be relative and inside the repository",
    );
  return {
    repo: input.repo.trim(),
    branch: input.branch?.trim() || "",
    installationId: input.installationId || null,
    connectionId: input.connectionId || null,
    serverId: input.serverId,
    buildServerId: input.buildServerId || null,
    rootDirectory: normalizeRootRel(input.rootDirectory),
  };
}
interface Receipt {
  success: boolean;
  purpose: "deplopack-analysis";
  teamId: string;
  userId: string;
  binding: ReturnType<typeof binding>;
  commitSha: string;
  version: string;
  detections: DeplopackDetection[];
}

export async function analyzeRepo(
  input: AnalysisRequest,
): Promise<RepoAnalysis> {
  const { membership, userId } = await requireMembership();
  await resolveNewAppPlacement(input, membership.teamId);
  const bound = binding(input);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bound.repo))
    throw new Error("Select a GitHub repository");
  const servers = await listServersForTeam(membership.teamId);
  const target = servers.find((server) => server.id === bound.serverId);
  if (!target || target.buildOnly || target.storageOnly || target.importOnly)
    throw new Error("Select a server available to this team");
  const candidates = servers.filter(
    (server) => !server.storageOnly && !server.importOnly,
  );
  if (
    bound.buildServerId &&
    !candidates.some((server) => server.id === bound.buildServerId)
  )
    throw new Error("Build server is not available to this team");
  const picked = pickBuildServer(
    { serverId: target.id, buildServerId: bound.buildServerId },
    target,
    candidates,
  );
  if (picked.reason === "arch-mismatch")
    throw new Error(
      "Build server architecture does not match the deployment server",
    );
  const repo = await scopeRepoCredentials(
    {
      provider: "github",
      url: `https://github.com/${bound.repo}`,
      repo: bound.repo,
      branch: bound.branch,
      installationId: bound.installationId,
      connectionId: bound.connectionId,
    },
    membership.teamId,
  );
  if (!repo) throw new Error("Repository is required");
  const clone = new URL(await resolveCloneUrl(repo));
  const token = decodeURIComponent(clone.password);
  clone.username = "";
  clone.password = "";
  const connection = await connectAgent(picked.serverId ?? target.id);
  try {
    const hello = await connection.hello();
    if (!hello.capabilities.includes("repo.analyze.deplopack"))
      throw new Error(
        "Update the server agent to analyze repositories with DeploPack",
      );
    const response = await connection.analyzeRepo({
      source: {
        url: clone.toString(),
        branch: repo.branch,
        token,
        subdir: bound.rootDirectory,
        commit: "",
      },
      environment: {},
    });
    const result = response.result as RepoAnalysis["result"] | undefined;
    if (
      !result ||
      typeof result.success !== "boolean" ||
      !Array.isArray(result.detections)
    )
      throw new Error("Invalid DeploPack analysis response");
    if (
      !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(response.commitSha) ||
      !/^\d+\.\d+\.\d+$/.test(response.detectorVersion)
    )
      throw new Error("Invalid DeploPack revision or version");
    for (const detection of result.detections) {
      if (
        !detection ||
        typeof detection.type !== "string" ||
        (detection.inputs !== undefined && !Array.isArray(detection.inputs))
      )
        throw new Error("Invalid repository detection");
      for (const field of detection.inputs ?? []) {
        if (
          !field ||
          typeof field.label !== "string" ||
          typeof field.description !== "string"
        )
          throw new Error("Invalid DeploPack input description");
        if (
          !/^DEPLOPACK_[A-Z][A-Z0-9_]*$/.test(field.env) ||
          field.env === "DEPLOPACK_PROVIDER" ||
          !["text", "select", "text-list"].includes(field.type)
        )
          throw new Error("Unsupported DeploPack input");
        if (
          field.defaultValue !== undefined &&
          (field.type === "text-list"
            ? !Array.isArray(field.defaultValue) ||
              !field.defaultValue.every((value) => typeof value === "string")
            : typeof field.defaultValue !== "string")
        )
          throw new Error("Invalid DeploPack default");
        if (
          field.type === "select" &&
          (!Array.isArray(field.options) ||
            !field.options.every((value) => typeof value === "string"))
        )
          throw new Error("Invalid DeploPack options");
      }
    }
    const receipt: Receipt = {
      success: result.success,
      purpose: "deplopack-analysis",
      teamId: membership.teamId,
      userId,
      binding: bound,
      commitSha: response.commitSha,
      version: response.detectorVersion,
      detections: result.detections.map((detection) => ({
        type: detection.type,
        path: detection.path,
        rootDir: detection.rootDir,
        inputs: detection.inputs?.map((field) => ({
          ...field,
          label: "",
          description: "",
          defaultValue: undefined,
          placeholder: undefined,
        })),
      })),
    };
    return {
      receipt: signState(JSON.stringify(receipt), 3600),
      expiresAt: Date.now() + 3600_000,
      commitSha: response.commitSha,
      detectorVersion: response.detectorVersion,
      result,
    };
  } finally {
    connection.close();
  }
}

export function validateRepoAnalysis(
  receipt: string | undefined,
  candidate: string | undefined,
  overrides: unknown,
  input: AnalysisRequest,
  teamId: string,
  userId: string,
): { build: Partial<BuildConfig>; commitSha: string } {
  const payload = verifyState(receipt);
  if (!payload)
    throw new Error(
      "Repository analysis expired. Analyze the repository again.",
    );
  let analysis: Receipt;
  try {
    analysis = JSON.parse(payload) as Receipt;
  } catch {
    throw new Error("Invalid repository analysis");
  }
  if (
    !analysis.success ||
    analysis.purpose !== "deplopack-analysis" ||
    analysis.teamId !== teamId ||
    analysis.userId !== userId ||
    JSON.stringify(analysis.binding) !== JSON.stringify(binding(input))
  )
    throw new Error("Repository selection changed. Analyze it again.");
  const detection = analysis.detections.find(
    (item) => detectionKey(item) === candidate,
  );
  if (!detection) throw new Error("Select a repository detection");
  if (!Array.isArray(overrides))
    throw new Error("Invalid DeploPack configuration");
  const accepted: DeplopackOverride[] = [];
  const seen = new Set<string>();
  for (const raw of overrides) {
    if (!raw || typeof raw !== "object")
      throw new Error("Invalid DeploPack input");
    const field = (detection.inputs ?? []).find((item) => item.env === raw.env);
    if (
      !field ||
      seen.has(field.env) ||
      !Array.isArray(raw.values) ||
      !raw.values.every(
        (value: unknown) => typeof value === "string" && !value.includes("\0"),
      )
    )
      throw new Error("Unknown or invalid DeploPack input");
    if (
      field.type === "text-list" &&
      raw.values.some((value: string) => !value.trim())
    )
      throw new Error("Commands cannot be blank");
    if (field.type !== "text-list" && raw.values.length > 1)
      throw new Error("This input accepts one value");
    if (
      field.type === "select" &&
      raw.values.some((value: string) => !field.options?.includes(value))
    )
      throw new Error("Select one of the available values");
    seen.add(field.env);
    if (raw.values.length)
      accepted.push({ env: field.env, type: field.type, values: raw.values });
  }
  return {
    commitSha: analysis.commitSha,
    build: {
      buildMethod: "deplopack",
      includeFilesOutsideRoot: false,
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
      runtimeVersion: "",
      methodSettings: {
        deplopackVersion: analysis.version,
        deplopackProvider: detection.type,
        deplopackPath: detection.path ?? null,
      },
      deplopackInputs: accepted,
    },
  };
}
