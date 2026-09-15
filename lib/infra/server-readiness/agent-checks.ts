import { status as GrpcStatus } from "@grpc/grpc-js";

import { AgentUnreachableError } from "../agent-client/errors";
import {
  READINESS_DETAILS,
  READINESS_HINTS,
  READINESS_MESSAGES,
} from "./messages";
import type { ReadinessCheck } from "./types";

export interface BuildMethodSpec {
  id: string;
  capability: string;
  label: string;
  supported: string;
}

export const BUILD_METHODS: readonly BuildMethodSpec[] = [
  {
    id: "build.dockerfile",
    capability: "deploy.dockerfile",
    label: "Dockerfile",
    supported: "The agent supports Dockerfile builds.",
  },
  {
    id: "build.image",
    capability: "deploy.image",
    label: "Prebuilt image",
    supported: "The agent supports running a prebuilt image as-is.",
  },
  {
    id: "build.compose",
    capability: "deploy.compose.multi",
    label: "Compose stack",
    supported: "The agent supports multi-service Compose stacks.",
  },
  {
    id: "build.static",
    capability: "deploy.static",
    label: "Static site",
    supported:
      "The agent supports static-site builds. The nginx and Node images it needs are pulled from the registry on the first build, nothing is installed on the host.",
  },
  {
    id: "build.nixpacks",
    capability: "deploy.nixpacks",
    label: "Nixpacks",
    supported:
      "The agent supports Nixpacks builds. The nixpacks binary itself is downloaded to the host on the first Nixpacks build - Deplo cannot verify from here that it is already there.",
  },
  {
    id: "build.buildpacks",
    capability: "deploy.buildpacks",
    label: "Buildpacks",
    supported:
      "The agent supports Cloud Native Buildpacks. pack and the builder images run in containers, pulled on the first build - nothing is installed on the host.",
  },
  {
    id: "build.railpack",
    capability: "deploy.railpack",
    label: "Railpack",
    supported:
      "The agent supports Railpack builds. Railpack and BuildKit run in throwaway containers, pulled on the first build - nothing is installed on the host.",
  },
] as const;

export const PLATFORM_FEATURES: readonly {
  capability: string;
  name: string;
}[] = [
  { capability: "metrics", name: "host metrics" },
  { capability: "container-stats", name: "per-app monitoring" },
  { capability: "checkport", name: "host port checks" },
  { capability: "backup", name: "backups" },
  { capability: "self-update", name: "in-place agent updates" },
  { capability: "volume-copy", name: "moving data between servers" },
  { capability: "volume-copy-hardened", name: "hardened data import" },
  { capability: "files-copy", name: "moving app files between servers" },
  { capability: "deploy.registry-auth", name: "private image registries" },
] as const;

export function helloFailure(err: unknown): ReadinessCheck {
  const row = (detail: string, hint: string): ReadinessCheck => ({
    id: "agent.hello",
    group: "agent",
    label: "Agent handshake",
    severity: "fail",
    detail,
    hint,
  });
  if (err instanceof AgentUnreachableError) {
    if (err.trust)
      return row(READINESS_MESSAGES.untrusted, READINESS_HINTS.reissue);
    return err.code === GrpcStatus.DEADLINE_EXCEEDED
      ? row(READINESS_MESSAGES.timedOut, READINESS_HINTS.agentLogs)
      : row(READINESS_MESSAGES.refused, READINESS_HINTS.agentLogs);
  }
  return row(READINESS_MESSAGES.agentError, READINESS_HINTS.agentLogs);
}

const AGENT_SEMVER_RE = /^v?\d+\.\d+\.\d+/;
const stripV = (v: string) => v.replace(/^v/i, "");

export function versionCheck(agentVersion: string): ReadinessCheck {
  const base = {
    id: "agent.version",
    group: "agent" as const,
    label: "Agent version",
  };
  if (!agentVersion)
    return {
      ...base,
      severity: "info",
      detail: READINESS_DETAILS.versionUnreported,
    };
  if (!AGENT_SEMVER_RE.test(agentVersion))
    return {
      ...base,
      severity: "info",
      detail: READINESS_DETAILS.versionUncomparable(agentVersion),
    };
  return {
    ...base,
    severity: "pass",
    detail: READINESS_DETAILS.versionRunning(stripV(agentVersion)),
  };
}

export function featuresCheck(capabilities: string[]): ReadinessCheck {
  const base = {
    id: "agent.features",
    group: "agent" as const,
    label: "Agent features",
  };
  if (capabilities.length === 0)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.featuresUnknown,
      hint: READINESS_HINTS.updateAgent,
    };
  const missing = PLATFORM_FEATURES.filter(
    (f) => !capabilities.includes(f.capability),
  );
  if (missing.length === 0)
    return {
      ...base,
      severity: "pass",
      detail: READINESS_DETAILS.featuresAllSupported,
    };
  return {
    ...base,
    severity: "warn",
    detail: READINESS_DETAILS.featuresMissing(missing.map((f) => f.name)),
    hint: READINESS_HINTS.updateAgent,
  };
}

export function buildChecks(capabilities: string[]): ReadinessCheck[] {
  if (capabilities.length === 0)
    return [
      {
        id: "build.unknown",
        group: "build",
        label: "Build methods",
        severity: "skip",
        detail: READINESS_MESSAGES.featuresUnknown,
        hint: READINESS_HINTS.updateAgent,
      },
    ];
  return BUILD_METHODS.map((m) =>
    capabilities.includes(m.capability)
      ? {
          id: m.id,
          group: "build" as const,
          label: m.label,
          severity: "pass" as const,
          detail: m.supported,
        }
      : {
          id: m.id,
          group: "build" as const,
          label: m.label,
          severity: "warn" as const,
          detail: READINESS_DETAILS.buildMissing(m.label),
          hint: READINESS_HINTS.updateAgent,
        },
  );
}
